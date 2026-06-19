'use strict'
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')

const rawArgs = process.argv.slice(2)
const args = {}
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i].startsWith('--')) {
    const key = rawArgs[i].slice(2)
    const val = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : true
    args[key] = val
  }
}

function usage() {
  console.error('用法:')
  console.error('  node schedule-post.js --bot-id <n> --board <看板> --title <標題> --at <ISO8601> [--content <內文> | --ai-prompt <prompt>] [--category <n>]')
  console.error('範例:')
  console.error('  node schedule-post.js --bot-id 1 --board Gossiping --title "測試" --content "內文" --at "2026-06-20T15:30:00+08:00"')
  console.error('  node schedule-post.js --bot-id 1 --board Gossiping --title "測試" --ai-prompt "請寫一篇..." --at "2026-06-20T15:30:00+08:00"')
  process.exit(1)
}

const botId    = args['bot-id']
const board    = args['board']
const title    = args['title']
const atStr    = args['at']
const content  = args['content'] || null
const aiPrompt = args['ai-prompt'] || null
const category = args['category'] ? parseInt(args['category'], 10) : 1

if (!botId || !board || !title || !atStr) {
  console.error('❌ 缺少必填參數：--bot-id, --board, --title, --at')
  usage()
}

if (!content && !aiPrompt) {
  console.error('❌ --content 與 --ai-prompt 至少填一個')
  usage()
}

const scheduledDate = new Date(atStr)
if (isNaN(scheduledDate.getTime())) {
  console.error(`❌ --at 格式錯誤，請用 ISO 8601（例：2026-06-20T15:30:00+08:00）`)
  process.exit(1)
}

// 轉為 UTC DATETIME 字串供 MySQL 使用
const scheduledUtc = scheduledDate.toISOString().slice(0, 19).replace('T', ' ')

;(async () => {
  let conn
  try {
    conn = await mysql.createConnection(config.mysql)

    const [bots] = await conn.execute('SELECT id FROM bots WHERE id = ? AND is_active = TRUE', [botId])
    if (bots.length === 0) {
      console.error(`❌ bot_id=${botId} 不存在或未啟用`)
      process.exit(1)
    }

    const [result] = await conn.execute(
      `INSERT INTO scheduled_posts (bot_id, board, title, category, content, ai_prompt, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [botId, board, title, category, content, aiPrompt, scheduledUtc]
    )

    console.log(`✅ 預約發文已建立 (id=${result.insertId})`)
    console.log(`   Bot:     ${botId}`)
    console.log(`   看板:    ${board}`)
    console.log(`   標題:    ${title}`)
    console.log(`   分類:    ${category}`)
    console.log(`   內容:    ${content ? content.slice(0, 40) + '...' : '(AI 生成)'}`)
    console.log(`   發文時間: ${atStr} → UTC ${scheduledUtc}`)
  } catch (err) {
    console.error('❌ 建立失敗:', err.message)
    process.exit(1)
  } finally {
    if (conn) await conn.end()
  }
})()
