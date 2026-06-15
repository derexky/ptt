// workflow.js
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
const { crawlNewPosts } = require('./crawl')
const { Poster } = require('./posterWS')
const { keywordFilter, aiFilter } = require('./filter')

// ── DB ──────────────────────────────────────────────────────────────

async function createConnection() {
  return mysql.createConnection(config.mysql)
}

async function initSchema(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS bots (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      ptt_id    VARCHAR(50) NOT NULL,
      password  VARCHAR(100) NOT NULL,
      stance    TEXT,
      tone      VARCHAR(200),
      is_active BOOLEAN DEFAULT TRUE
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS topics (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      board     VARCHAR(50) NOT NULL,
      keywords  JSON NOT NULL,
      ai_prompt TEXT,
      is_active BOOLEAN DEFAULT TRUE
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS reply_log (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      bot_id       INT NOT NULL,
      article_link VARCHAR(255) NOT NULL,
      replied_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_reply (bot_id, article_link),
      FOREIGN KEY (bot_id) REFERENCES bots(id)
    )
  `)
  console.log('✅ Schema initialised')
}

async function loadTopics(conn) {
  const [rows] = await conn.execute('SELECT * FROM topics WHERE is_active = TRUE')
  return rows.map(r => ({ ...r, keywords: Array.isArray(r.keywords) ? r.keywords : JSON.parse(r.keywords) }))
}

async function loadBots(conn) {
  const [rows] = await conn.execute('SELECT * FROM bots WHERE is_active = TRUE')
  return rows
}

async function hasReplied(conn, botId, articleLink) {
  const [rows] = await conn.execute(
    'SELECT id FROM reply_log WHERE bot_id = ? AND article_link = ?',
    [botId, articleLink]
  )
  return rows.length > 0
}

async function logReply(conn, botId, articleLink) {
  await conn.execute(
    'INSERT IGNORE INTO reply_log (bot_id, article_link) VALUES (?, ?)',
    [botId, articleLink]
  )
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ai.js enforces 2-min min interval; track last call time ourselves
// so we can sleep before each AI-calling step.
const AI_MIN_INTERVAL = 130000 // 2 min 10 sec — slightly over the 120 s limit
let lastAiCallAt = 0

async function waitForAiRateLimit() {
  const elapsed = Date.now() - lastAiCallAt
  if (lastAiCallAt > 0 && elapsed < AI_MIN_INTERVAL) {
    const wait = AI_MIN_INTERVAL - elapsed
    console.log(`⏳ Waiting ${Math.ceil(wait / 1000)}s for AI rate limit...`)
    await sleep(wait)
  }
}

function markAiCall() {
  lastAiCallAt = Date.now()
}

function extractAid(link) {
  const match = link.match(/\/([^/]+)\.html$/)
  return match ? match[1] : null
}

// ── Reply ────────────────────────────────────────────────────────────

async function replyWithBot(bot, article, board) {
  const aid = extractAid(article.link)
  if (!aid) {
    console.error(`[Bot ${bot.ptt_id}] Cannot extract aid from: ${article.link}`)
    return false
  }

  const stance = [bot.stance, bot.tone].filter(Boolean).join('\n')
  const poster = new Poster(bot.ptt_id, bot.password)

  poster.postArticle({
    board,
    aid,
    stance,
    isSendByWord: true,
    isNeedBackup: false,
  }).catch(err => console.error(`[Poster ${bot.ptt_id}] Background error:`, err.message))

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Reply timeout after 5 minutes')), 300000)
  )

  try {
    const result = await Promise.race([poster.contentReady, timeout])
    console.log(`[Bot ${bot.ptt_id}] Content ready: "${String(result.text || '').slice(0, 60)}..."`)
    poster.continueState()
    return true
  } catch (err) {
    console.error(`[Bot ${bot.ptt_id}] Post failed:`, err.message)
    return false
  } finally {
    markAiCall()
  }
}

// ── Main workflow ─────────────────────────────────────────────────────

async function runWorkflow() {
  console.log(`\n[${new Date().toISOString()}] Starting workflow...`)
  const conn = await createConnection()

  try {
    await initSchema(conn)

    const topics = await loadTopics(conn)
    const bots   = await loadBots(conn)

    if (topics.length === 0) { console.log('No active topics.'); return }

    console.log(`Loaded ${topics.length} topic(s), ${bots.length} bot(s)`)

    if (bots.length === 0) {
      console.log('No active bots.')
      console.log(`\n✅ Workflow complete`)
      return
    }

    for (const topic of topics) {
      console.log(`\n📋 Topic: board=${topic.board} keywords=${JSON.stringify(topic.keywords)}`)

      // Step 1: Crawl latest articles into DB
      console.log(`Crawling ${topic.board}...`)
      await crawlNewPosts(10, topic.board)

      // Step 2: Query the DB for articles from this board
      const [articles] = await conn.execute(
        `SELECT id, title, link FROM articles
          WHERE link LIKE ? ORDER BY id DESC LIMIT 100`,
        [`%/bbs/${topic.board}/%`]
      )
      console.log(`DB returned ${articles.length} articles for ${topic.board}`)

      // Step 3: Keyword pre-filter
      const keyFiltered = keywordFilter(articles, topic.keywords)
      console.log(`After keyword filter: ${keyFiltered.length} article(s)`)
      if (keyFiltered.length === 0) continue

      // Step 4: AI filter (1 AI call per topic)
      await waitForAiRateLimit()
      console.log(`Running AI filter on ${keyFiltered.length} article(s)...`)
      const selected = await aiFilter(keyFiltered, topic.ai_prompt)
      markAiCall()
      console.log(`AI selected ${selected.length} article(s)`)
      if (selected.length === 0) continue

      // Step 5: Reply loop — each bot × each selected article
      for (const article of selected) {
        for (const bot of bots) {
          const already = await hasReplied(conn, bot.id, article.link)
          if (already) {
            console.log(`[Bot ${bot.ptt_id}] Already replied to "${article.title}", skipping`)
            continue
          }

          console.log(`[Bot ${bot.ptt_id}] Replying to: "${article.title}"`)

          // Wait for AI rate limit before the Poster's internal AI call
          await waitForAiRateLimit()

          const ok = await replyWithBot(bot, article, topic.board)
          if (ok) {
            await logReply(conn, bot.id, article.link)
            console.log(`[Bot ${bot.ptt_id}] ✅ Reply logged`)
          }
        }
      }
    }

    console.log(`\n✅ Workflow complete`)
  } finally {
    await conn.end()
  }
}

module.exports = { runWorkflow, initSchema, createConnection }

if (require.main === module) {
  runWorkflow().catch(err => {
    console.error('❌ Workflow error:', err.message)
    process.exit(1)
  })
}
