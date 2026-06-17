// workflow.js
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
const { crawlNewPosts } = require('./crawl')
const { Poster } = require('./posterWS')
const { keywordFilter, aiFilter } = require('./filter')
const { extractAid } = require('./helper')

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
      id            INT AUTO_INCREMENT PRIMARY KEY,
      bot_id        INT NOT NULL,
      article_link  VARCHAR(255) NOT NULL,
      board         VARCHAR(50),
      article_title VARCHAR(500),
      topic_id      INT,
      success       BOOLEAN DEFAULT TRUE,
      ai_content    TEXT,
      replied_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_reply (bot_id, article_link),
      FOREIGN KEY (bot_id) REFERENCES bots(id)
    )
  `)
  const [existingCols] = await conn.execute('SHOW COLUMNS FROM reply_log')
  const colSet = new Set(existingCols.map(c => c.Field))
  const migrations = [
    ['board',         'ALTER TABLE reply_log ADD COLUMN board VARCHAR(50)'],
    ['article_title', 'ALTER TABLE reply_log ADD COLUMN article_title VARCHAR(500)'],
    ['topic_id',      'ALTER TABLE reply_log ADD COLUMN topic_id INT'],
    ['success',       'ALTER TABLE reply_log ADD COLUMN success BOOLEAN DEFAULT TRUE'],
    ['ai_content',    'ALTER TABLE reply_log ADD COLUMN ai_content TEXT'],
  ]
  for (const [col, sql] of migrations) {
    if (!colSet.has(col)) await conn.execute(sql)
  }
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

async function hasDuplicateContent(conn, botId, content) {
  if (!content) return false
  const [rows] = await conn.execute(
    'SELECT id FROM reply_log WHERE bot_id = ? AND ai_content = ? AND success = TRUE LIMIT 1',
    [botId, content]
  )
  return rows.length > 0
}

async function logReply(conn, botId, articleLink, { board, articleTitle, topicId, success, aiContent } = {}) {
  await conn.execute(
    `INSERT IGNORE INTO reply_log (bot_id, article_link, board, article_title, topic_id, success, ai_content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [botId, articleLink, board ?? null, articleTitle ?? null, topicId ?? null, success ?? true, aiContent ?? null]
  )
}

async function getFailedReplies(conn, botId, board) {
  const [rows] = await conn.execute(
    `SELECT article_link, article_title, ai_content FROM reply_log
     WHERE bot_id = ? AND board = ? AND success = FALSE
     ORDER BY replied_at DESC`,
    [botId, board]
  )
  return rows
}

async function updateReplyLog(conn, botId, articleLink, { success, aiContent }) {
  await conn.execute(
    `UPDATE reply_log SET success = ?, ai_content = ?, replied_at = NOW()
     WHERE bot_id = ? AND article_link = ?`,
    [success ?? false, aiContent ?? null, botId, articleLink]
  )
}

const DAILY_BOARD_LIMIT = 5

async function countTodayBoardReplies(conn, botId, board) {
  // DB 時區為 UTC，用 +8 偏移換算成台灣日期，確保午夜重置時間正確
  const [rows] = await conn.execute(
    `SELECT COUNT(DISTINCT article_link) AS cnt FROM reply_log
     WHERE bot_id = ? AND article_link LIKE ?
       AND DATE(replied_at + INTERVAL 8 HOUR) = DATE(NOW() + INTERVAL 8 HOUR)`,
    [botId, `%/bbs/${board}/%`]
  )
  return rows[0].cnt
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getBaseTitle(title) {
  return (title || '').replace(/^(Re:\s*)+/i, '').trim()
}

async function hasRepliedToSameThread(conn, botId, board, baseTitle) {
  const [rows] = await conn.execute(
    `SELECT rl.id FROM reply_log rl
     JOIN articles a ON rl.article_link = a.link
     WHERE rl.bot_id = ? AND rl.board = ?
       AND (a.title = ? OR a.title = ?)
     LIMIT 1`,
    [botId, board, baseTitle, `Re: ${baseTitle}`]
  )
  return rows.length > 0
}

// ai.js enforces 2-min min interval; track last call time ourselves
// so we can sleep before each AI-calling step.
const AI_MIN_INTERVAL = 12000 // 12 sec — slightly over the 10 s limit in ai.js
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


// ── Reply ────────────────────────────────────────────────────────────

async function replyWithBot(bot, article, { preGeneratedContent, onContentReady, onPostDone } = {}) {
  const aid = article.aid || extractAid(article.link)
  const board = article.board
  if (!aid || !board) {
    console.error(`[Bot ${bot.ptt_id}] Missing aid or board for: ${article.link}`)
    return { ok: false, aiContent: null }
  }

  const stance = [bot.stance, bot.tone, '回覆內容500到800字之間'].filter(Boolean).join('\n')
  const poster = new Poster(bot.ptt_id, bot.password)

  const postPromise = poster.postArticle({
    board,
    aid,
    stance,
    isSendByWord: true,
    isNeedBackup: false,
    preGeneratedContent: preGeneratedContent || null,
    onPostDone,
  }).catch(err => { console.error(`[Poster ${bot.ptt_id}] Background error:`, err.message); return null })

  const makeTimeout = () => new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Reply timeout after ${config.replyTimeoutMs / 60000} minutes`)), config.replyTimeoutMs)
  )

  try {
    const result = await Promise.race([poster.contentReady, makeTimeout()])
    const aiContent = String(result.content || result.text || '')
    console.log(`[Bot ${bot.ptt_id}] Content ready: "${aiContent.slice(0, 60)}..."`)
    if (onContentReady) {
      const shouldPost = await onContentReady(aiContent)
      if (shouldPost === false) {
        poster.abort()
        return { ok: false, aiContent, skipped: true }
      }
    }
    poster.continueState()
    await Promise.race([postPromise, makeTimeout()])
    return { ok: true, aiContent }
  } catch (err) {
    console.error(`[Bot ${bot.ptt_id}] Post failed:`, err.message)
    return { ok: false, aiContent: null }
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

      try {
        // Check each bot for pending failed replies on this board
        const botFailedMap = new Map()
        for (const bot of bots) {
          const failed = await getFailedReplies(conn, bot.id, topic.board)
          if (failed.length > 0) botFailedMap.set(bot.id, failed)
        }

        const botsNeedingNew = bots.filter(b => !botFailedMap.has(b.id))
        let sortedArticles = []

        if (botsNeedingNew.length > 0) {
          // Step 1: Crawl latest articles into DB
          console.log(`Crawling ${topic.board}...`)
          await crawlNewPosts(5, topic.board, { skipContent: true })

          // Step 2: Query the DB for articles from this board
          const [articles] = await conn.execute(
            `SELECT id, title, link, aid, board, push FROM articles
              WHERE link LIKE ? ORDER BY id DESC LIMIT 100`,
            [`%/bbs/${topic.board}/%`]
          )
          console.log(`DB returned ${articles.length} articles for ${topic.board}`)

          // Step 3: Keyword pre-filter
          const keyFiltered = keywordFilter(articles, topic.keywords)
          console.log(`After keyword filter: ${keyFiltered.length} article(s)`)

          if (keyFiltered.length > 0) {
            // Step 4: AI filter (1 AI call per topic)
            await waitForAiRateLimit()
            console.log(`Running AI filter on ${keyFiltered.length} article(s)...`)
            const selected = await aiFilter(keyFiltered, topic.ai_prompt)
            markAiCall()
            console.log(`AI selected ${selected.length} article(s)`)
            const parsePush = p => p === '100+' ? 100 : (parseInt(String(p).replace(/^X/, '')) || 0)
            sortedArticles = [...selected].sort((a, b) => parsePush(b.push) - parsePush(a.push))
          }
        } else {
          console.log(`All bots have pending retries for ${topic.board}, skipping crawl`)
        }

        const claimedThisRun = new Set()

        for (const bot of bots) {
          if (botFailedMap.has(bot.id)) {
            // Retry path: re-post failed replies
            const failed = botFailedMap.get(bot.id)
            console.log(`[Bot ${bot.ptt_id}] ${failed.length} failed reply(s) to retry`)
            for (const failedReply of failed) {
              const article = {
                link: failedReply.article_link,
                title: failedReply.article_title,
                board: topic.board,
              }
              const hasContent = !!failedReply.ai_content
              console.log(`[Bot ${bot.ptt_id}] Retrying: "${failedReply.article_title}" (${hasContent ? 'reuse content' : 'regenerate'})`)
              if (!hasContent) await waitForAiRateLimit()
              const { ok, aiContent, skipped } = await replyWithBot(bot, article, {
                preGeneratedContent: failedReply.ai_content || null,
                onContentReady: hasContent ? null : async (content) => {
                  if (await hasDuplicateContent(conn, bot.id, content)) {
                    console.log(`[Bot ${bot.ptt_id}] ⚠️ Duplicate content on retry, skipping`)
                    return false
                  }
                  await updateReplyLog(conn, bot.id, failedReply.article_link, { success: false, aiContent: content })
                },
                onPostDone: async () => {
                  await updateReplyLog(conn, bot.id, failedReply.article_link, { success: true, aiContent: failedReply.ai_content })
                  console.log(`[Bot ${bot.ptt_id}] ✅ Post confirmed on PTT, DB updated`)
                },
              })
              if (skipped) {
                console.log(`[Bot ${bot.ptt_id}] ⏭️ Retry skipped (duplicate content)`)
              } else {
                await updateReplyLog(conn, bot.id, failedReply.article_link, { success: ok, aiContent: aiContent || failedReply.ai_content })
                console.log(`[Bot ${bot.ptt_id}] ${ok ? '✅ Retry succeeded' : '❌ Retry failed'}`)
              }
            }
          } else {
            // Normal path: pick a new article
            const todayReplies = await countTodayBoardReplies(conn, bot.id, topic.board)
            console.log(`[Bot ${bot.ptt_id}] Today's replies for ${topic.board}: ${todayReplies}/${DAILY_BOARD_LIMIT}`)

            if (todayReplies >= DAILY_BOARD_LIMIT) {
              console.log(`[Bot ${bot.ptt_id}] 已達今日上限 ${DAILY_BOARD_LIMIT} 篇，跳過`)
              continue
            }

            const target = await (async () => {
              for (const article of sortedArticles) {
                if (claimedThisRun.has(article.link)) continue
                if (await hasReplied(conn, bot.id, article.link)) continue
                const baseTitle = getBaseTitle(article.title)
                if (await hasRepliedToSameThread(conn, bot.id, topic.board, baseTitle)) {
                  console.log(`[Bot ${bot.ptt_id}] ⚠️ Same thread already replied: "${baseTitle}", skipping "${article.title}"`)
                  continue
                }
                return article
              }
              return null
            })()

            if (!target) {
              console.log(`[Bot ${bot.ptt_id}] 沒有可回覆的新文章`)
              continue
            }

            claimedThisRun.add(target.link)
            console.log(`[Bot ${bot.ptt_id}] Replying to: "${target.title}" (push: ${target.push})`)

            await waitForAiRateLimit()
            let capturedContent = null
            const { ok, aiContent, skipped } = await replyWithBot(bot, target, {
              onContentReady: async (content) => {
                if (await hasDuplicateContent(conn, bot.id, content)) {
                  console.log(`[Bot ${bot.ptt_id}] ⚠️ Duplicate content detected, skipping post`)
                  return false
                }
                capturedContent = content
                await logReply(conn, bot.id, target.link, {
                  board: topic.board,
                  articleTitle: target.title,
                  topicId: topic.id,
                  success: false,
                  aiContent: content,
                })
              },
              onPostDone: async () => {
                await updateReplyLog(conn, bot.id, target.link, { success: true, aiContent: capturedContent })
                console.log(`[Bot ${bot.ptt_id}] ✅ Post confirmed on PTT, DB updated`)
              },
            })
            if (skipped) {
              console.log(`[Bot ${bot.ptt_id}] ⏭️ Skipped (duplicate content)`)
            } else {
              await updateReplyLog(conn, bot.id, target.link, { success: ok, aiContent })
              console.log(`[Bot ${bot.ptt_id}] ${ok ? '✅ Reply logged' : '❌ Reply failed, logged'}`)
            }
          }
        }
      } catch (err) {
        console.error(`[Topic ${topic.board}] Error, skipping:`, err.message)
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
