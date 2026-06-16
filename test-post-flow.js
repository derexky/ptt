'use strict'
require('dotenv').config()
const { Poster } = require('./posterWS')

const PTT_ID = process.env.PTT_ID
const PTT_PASSWORD = process.env.PTT_PASSWORD

if (!PTT_ID || !PTT_PASSWORD) {
  console.error('缺少 PTT_ID / PTT_PASSWORD（請設定 .env）')
  process.exit(1)
}

// 用法: node test-post-flow.js <AID> [BOARD]
// 或設定環境變數 PTT_TEST_AID / PTT_TEST_BOARD
const AID = (process.argv[2] || process.env.PTT_TEST_AID || '').replace(/^#/, '')
const BOARD = process.argv[3] || process.env.PTT_TEST_BOARD || 'Gossiping'
const RUNS = 3

if (!AID) {
  console.error('缺少 AID，用法：node test-post-flow.js <AID> [BOARD]')
  console.error('  或設定 .env PTT_TEST_AID=xxxxx')
  process.exit(1)
}

console.log(`測試模式：回文 (board=${BOARD}, aid=${AID})`)

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function runOnce(runNum) {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`[Run ${runNum}] 開始測試回文流程`)

  const poster = new Poster(PTT_ID, PTT_PASSWORD)
  let reachedPosting = false
  let aborted = false

  const postPromise = poster.postArticle({
    board: BOARD,
    aid: AID,
    isSendByWord: true,
    preGeneratedContent: '這是測試用回文，不會實際發表。',
    onProgress: (p) => {
      console.log(`  [進度] phase=${p.phase}${p.percent != null ? ` ${p.percent}%` : ''}`)
      // 偵測到開始逐字輸入後立即中止，不實際儲存
      if (p.phase === 'posting' && !aborted) {
        aborted = true
        reachedPosting = true
        console.log(`  [Test] ✅ 已到達逐字輸入階段，中止連線（不儲存文章）`)
        poster.abort()
      }
    },
  }).catch(err => {
    if (aborted) return null  // abort 是預期行為
    throw err
  })

  try {
    // 等待 AI 生成內容（此處跳過 AI，直接用 preGeneratedContent）
    const contentResult = await Promise.race([
      poster.contentReady,
      sleep(120000).then(() => { throw new Error('contentReady timeout 120s') }),
    ])
    console.log(`  [內容] ${String(contentResult.content).slice(0, 40)}...`)

    // 告知 poster 繼續（開始實際發文操作）
    poster.continueState()
  } catch (e) {
    if (aborted) {
      // abort 可能在 contentReady 之前觸發，視為成功中止
    } else {
      throw e
    }
  }

  // 等候 postPromise 結束（正常中止或超時）
  await Promise.race([
    postPromise,
    sleep(120000).then(() => {
      if (!aborted) throw new Error('postPromise timeout 120s')
    }),
  ]).catch(err => {
    if (!aborted) throw err
  })

  if (reachedPosting) {
    console.log(`[Run ${runNum}] ✅ PASS：成功走到逐字輸入階段並中止`)
    return true
  } else {
    console.log(`[Run ${runNum}] ❌ FAIL：未到達逐字輸入階段`)
    return false
  }
}

;(async () => {
  let passed = 0
  for (let i = 1; i <= RUNS; i++) {
    try {
      const ok = await runOnce(i)
      if (ok) passed++
    } catch (err) {
      console.error(`[Run ${i}] ❌ ERROR: ${err.message}`)
    }
    // 每次測試間隔，讓 PTT 伺服器有時間處理
    if (i < RUNS) {
      console.log(`\n等待 5 秒再進行下一次測試...`)
      await sleep(5000)
    }
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`測試結果：${passed} / ${RUNS} 通過`)
  process.exit(passed === RUNS ? 0 : 1)
})()
