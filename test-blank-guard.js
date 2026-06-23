'use strict'
/**
 * 測試空白內容防護修正（不連接 PTT）
 *
 * 修正 1：handleResolve 收到空/空白內容時，應 reject contentReady，不讓 HTTP handler timeout
 * 修正 2：startPost 收到純空白 postContent 時，應送 Ctrl+X+Q 中止，不發空白文
 */

const path = require('path')
const { Poster } = require(path.join(__dirname, 'functions/external/posterWS'))

// startPost 的狀態值（hardcode 與 posterWS.js 內部一致）
const STATUS_START_POST = 12

function makeMockStream() {
  const sent = []
  return {
    sent,
    close() { sent.push('__close__') },
    send(data) { sent.push(data) },
  }
}

let passed = 0
let total = 0

async function check(name, fn) {
  total++
  try {
    const ok = await fn()
    if (ok) {
      console.log(`  ✅ PASS: ${name}`)
      passed++
    } else {
      console.log(`  ❌ FAIL: ${name}`)
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${name} — ${err.message}`)
  }
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────
async function test_emptyContent_rejectsContentReady() {
  const poster = new Poster('u', 'p')
  poster.stream = makeMockStream()

  let rejected = false
  poster.contentReady.catch(() => { rejected = true })
  poster.handleResolve({ text: '' })
  await new Promise(r => setTimeout(r, 50))
  return rejected
}

// ─── Test 2 ───────────────────────────────────────────────────────────────────
async function test_whitespaceContent_rejectsContentReady() {
  const poster = new Poster('u', 'p')
  poster.stream = makeMockStream()

  let rejected = false
  poster.contentReady.catch(() => { rejected = true })
  poster.handleResolve({ text: '   \n\n\t  ' })
  await new Promise(r => setTimeout(r, 50))
  return rejected
}

// ─── Test 3 ───────────────────────────────────────────────────────────────────
async function test_whitespacePostContent_abortsEditor_notFinishPost() {
  const poster = new Poster('u', 'p')
  const mockStream = makeMockStream()
  poster.stream = mockStream
  poster.postContent = '   \n\n   '
  poster.currentState = STATUS_START_POST
  poster.isProcessing = false

  // 觸發狀態機（chunk 內容不影響 startPost case）
  await poster.handleState('arbitrary chunk')
  await new Promise(r => setTimeout(r, 1200)) // wait for two delayWrite(500ms each)

  const sentStrings = mockStream.sent.map(s =>
    Buffer.isBuffer(s) ? s.toString('latin1') : String(s)
  )
  const ctrlX = sentStrings.some(s => s.includes('\x18'))
  const quit   = sentStrings.some(s => s.includes('Q'))
  const save   = sentStrings.some(s => s.includes('S\r\n'))

  // 應有 Ctrl+X 和 Q，不應有 S（儲存）
  return ctrlX && quit && !save
}

// ─── Test 4 ───────────────────────────────────────────────────────────────────
async function test_normalContent_proceedsToPost() {
  const poster = new Poster('u', 'p')
  const mockStream = makeMockStream()
  poster.stream = mockStream
  poster.postContent = '這是正常內容，應該進入發文流程。'
  poster.currentState = STATUS_START_POST
  poster.isProcessing = false
  poster.isSendByWord = true

  let postStarted = false
  poster.postEachWord = async () => { postStarted = true }

  await poster.handleState('arbitrary chunk')
  await new Promise(r => setTimeout(r, 50))

  return postStarted
}

;(async () => {
  console.log('=== 空白內容防護測試 ===\n')

  await check('空字串 content → contentReady reject', test_emptyContent_rejectsContentReady)
  await check('空白字元 content → contentReady reject', test_whitespaceContent_rejectsContentReady)
  await check('startPost 空白 postContent → 送 Ctrl+X+Q，不送 S', test_whitespacePostContent_abortsEditor_notFinishPost)
  await check('startPost 正常 postContent → 進入 postEachWord', test_normalContent_proceedsToPost)

  console.log(`\n${'='.repeat(40)}`)
  console.log(`結果：${passed} / ${total} 通過`)
  process.exit(passed === total ? 0 : 1)
})()
