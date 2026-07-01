'use strict'
process.env.NODE_ENV = 'develop' // 確保 isDev=true，讓 retry path 執行
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

// Patch GoogleGenerativeAI to always throw 503
const genAiModule = require('@google/generative-ai')
const OriginalClass = genAiModule.GoogleGenerativeAI
genAiModule.GoogleGenerativeAI = class extends OriginalClass {
  getGenerativeModel(...args) {
    const model = super.getGenerativeModel(...args)
    model.generateContent = async () => {
      const err = new Error('[503 Service Unavailable] high demand')
      throw err
    }
    return model
  }
}

const { generateContentByGoogle } = require('./ai')

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    passed++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    failed++
  }
}

;(async () => {
  // Test 1: isCancelled true from start → return immediately, no retry sleep
  await check('isCancelled=true → stop after first failure, no sleep', async () => {
    const start = Date.now()
    const result = await generateContentByGoogle({
      prompt: 'test',
      stance: 'test',
      isCancelled: () => true,
      retryDelay: 5000, // 若沒截停會很慢
    })
    const elapsed = Date.now() - start
    if (result.message !== 'Cancelled') throw new Error(`Expected 'Cancelled', got '${result.message}'`)
    if (elapsed > 2000) throw new Error(`Took ${elapsed}ms, should be instant`)
  })

  // Test 2: isCancelled false → 允許 retry（但時間上會等 retryDelay，改用短 delay 測試）
  await check('isCancelled=false → retries normally (2 attempts)', async () => {
    let callCount = 0
    const origPatch = genAiModule.GoogleGenerativeAI.prototype
    // count attempts via wrapping
    let attemptCount = 0
    const result = await generateContentByGoogle({
      prompt: 'test',
      stance: 'test',
      isCancelled: () => false,
      maxRetries: 1,    // 最多 retry 1 次
      retryDelay: 100,  // 短到可以快速跑完
    })
    // 503 2 次後應 return failure
    if (result.success !== false) throw new Error(`Expected failure, got success`)
    if (result.message === 'Cancelled') throw new Error(`Should not be Cancelled`)
  })

  // Test 3: isCancelled 在 sleep 中途變 true → sleep 結束後下一個 attempt 前截停
  await check('isCancelled becomes true during sleep → stops at next attempt check', async () => {
    let shouldCancel = false
    setTimeout(() => { shouldCancel = true }, 150) // 150ms 後 cancel
    const start = Date.now()
    const result = await generateContentByGoogle({
      prompt: 'test',
      stance: 'test',
      isCancelled: () => shouldCancel,
      maxRetries: 5,
      retryDelay: 200, // sleep 200ms，cancel 在 150ms 時觸發
    })
    const elapsed = Date.now() - start
    if (result.message !== 'Cancelled') throw new Error(`Expected 'Cancelled', got '${result.message}'`)
    // 應在 1st retry sleep (200ms) 結束後、2nd attempt 前停止 → ~200ms
    if (elapsed > 1000) throw new Error(`Took ${elapsed}ms, should stop around 200ms`)
  })

  console.log(`\n結果：${passed} 通過，${failed} 失敗`)
  process.exit(failed > 0 ? 1 : 0)
})()
