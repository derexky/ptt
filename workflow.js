// workflow.js
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
const { crawlNewPosts } = require('./crawl')
const { Poster } = require('./posterWS')
const { keywordFilter, aiFilter } = require('./filter')
const { generateContentByGoogle } = require('./ai')
const { extractAid } = require('./helper')

// ── DB ──────────────────────────────────────────────────────────────

function createPool() {
  return mysql.createPool(config.mysql)
}

async function initSchema(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS proxies (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      host      VARCHAR(100) NOT NULL,
      port      INT NOT NULL,
      username  VARCHAR(100),
      password  VARCHAR(100),
      label     VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS bots (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      ptt_id     VARCHAR(50) NOT NULL,
      password   VARCHAR(100) NOT NULL,
      stance     TEXT,
      tone       VARCHAR(200),
      is_active  BOOLEAN DEFAULT TRUE,
      start_hour TINYINT DEFAULT NULL,
      end_hour   TINYINT DEFAULT NULL,
      proxy_id   INT DEFAULT NULL
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS topics (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      board       VARCHAR(50) NOT NULL,
      keywords    JSON NOT NULL,
      ai_prompt   TEXT,
      daily_limit INT DEFAULT 5,
      is_active   BOOLEAN DEFAULT TRUE
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS bot_topic_subscriptions (
      bot_id   INT NOT NULL,
      topic_id INT NOT NULL,
      PRIMARY KEY (bot_id, topic_id),
      FOREIGN KEY (bot_id)   REFERENCES bots(id),
      FOREIGN KEY (topic_id) REFERENCES topics(id)
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

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS article_topic_ai_result (
      article_id    INT NOT NULL,
      topic_id      INT NOT NULL,
      selected      BOOLEAN NOT NULL,
      push_at_cache INT DEFAULT 0,
      PRIMARY KEY (article_id, topic_id),
      FOREIGN KEY (article_id) REFERENCES articles(id),
      FOREIGN KEY (topic_id)   REFERENCES topics(id)
    )
  `)

  try {
    const [articleCols] = await conn.execute('SHOW COLUMNS FROM articles')
    if (!new Set(articleCols.map(c => c.Field)).has('created_at')) {
      await conn.execute('ALTER TABLE articles ADD COLUMN created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP')
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e
  }

  const [aiCols] = await conn.execute('SHOW COLUMNS FROM article_topic_ai_result')
  if (!new Set(aiCols.map(c => c.Field)).has('push_at_cache')) {
    await conn.execute('ALTER TABLE article_topic_ai_result ADD COLUMN push_at_cache INT DEFAULT 0')
  }

  const [botCols] = await conn.execute('SHOW COLUMNS FROM bots')
  const botColSet = new Set(botCols.map(c => c.Field))
  if (!botColSet.has('start_hour')) {
    await conn.execute('ALTER TABLE bots ADD COLUMN start_hour TINYINT DEFAULT NULL')
    await conn.execute('ALTER TABLE bots ADD COLUMN end_hour TINYINT DEFAULT NULL')
  }
  if (!botColSet.has('proxy_id')) {
    await conn.execute('ALTER TABLE bots ADD COLUMN proxy_id INT DEFAULT NULL')
  }

  const [topicCols] = await conn.execute('SHOW COLUMNS FROM topics')
  const topicColSet = new Set(topicCols.map(c => c.Field))
  if (!topicColSet.has('daily_limit')) {
    await conn.execute('ALTER TABLE topics ADD COLUMN daily_limit INT DEFAULT 5')
  }

  const [existingCols] = await conn.execute('SHOW COLUMNS FROM reply_log')
  const colSet = new Set(existingCols.map(c => c.Field))
  const migrations = [
    ['board',         'ALTER TABLE reply_log ADD COLUMN board VARCHAR(50)'],
    ['article_title', 'ALTER TABLE reply_log ADD COLUMN article_title VARCHAR(500)'],
    ['topic_id',      'ALTER TABLE reply_log ADD COLUMN topic_id INT'],
    ['success',       'ALTER TABLE reply_log ADD COLUMN success BOOLEAN DEFAULT TRUE'],
    ['ai_content',    'ALTER TABLE reply_log ADD COLUMN ai_content TEXT'],
    ['retry_count',   'ALTER TABLE reply_log ADD COLUMN retry_count INT DEFAULT 0'],
  ]
  for (const [col, sql] of migrations) {
    if (!colSet.has(col)) await conn.execute(sql)
  }

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      bot_id       INT NOT NULL,
      board        VARCHAR(50) NOT NULL,
      title        VARCHAR(200) NOT NULL,
      category     INT DEFAULT 1,
      content      TEXT DEFAULT NULL,
      ai_prompt    TEXT DEFAULT NULL,
      scheduled_at DATETIME NOT NULL,
      status       ENUM('pending','processing','done','failed') DEFAULT 'pending',
      posted_at    DATETIME DEFAULT NULL,
      error_msg    TEXT DEFAULT NULL,
      FOREIGN KEY (bot_id) REFERENCES bots(id)
    )
  `)

  const [spCols] = await conn.execute('SHOW COLUMNS FROM scheduled_posts LIKE \'status\'')
  if (spCols.length > 0 && !spCols[0].Type.includes('processing')) {
    await conn.execute(`ALTER TABLE scheduled_posts MODIFY COLUMN status ENUM('pending','processing','done','failed') DEFAULT 'pending'`)
  }

  console.log('✅ Schema initialised')
}

async function loadTopics(conn) {
  const [rows] = await conn.execute('SELECT * FROM topics WHERE is_active = TRUE')
  return rows.map(r => ({ ...r, keywords: Array.isArray(r.keywords) ? r.keywords : JSON.parse(r.keywords) }))
}

async function loadSubscribedBots(conn, topicId) {
  const [rows] = await conn.execute(
    `SELECT b.*,
            p.host AS proxy_host, p.port AS proxy_port,
            p.username AS proxy_user, p.password AS proxy_pass
     FROM bots b
     JOIN bot_topic_subscriptions s ON s.bot_id = b.id
     LEFT JOIN proxies p ON p.id = b.proxy_id AND p.is_active = TRUE
     WHERE s.topic_id = ? AND b.is_active = TRUE`,
    [topicId]
  )
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

const MAX_RETRY_COUNT = 3

async function getFailedReplies(conn, botId, board) {
  const [rows] = await conn.execute(
    `SELECT article_link, article_title, ai_content, retry_count FROM reply_log
     WHERE bot_id = ? AND board = ? AND success = FALSE AND retry_count < ?
     ORDER BY replied_at DESC`,
    [botId, board, MAX_RETRY_COUNT]
  )
  return rows
}

async function updateReplyLog(conn, botId, articleLink, { success, aiContent }) {
  const incrementRetry = success === false ? ', retry_count = retry_count + 1' : ''
  await conn.execute(
    `UPDATE reply_log SET success = ?, ai_content = ?, replied_at = NOW()${incrementRetry}
     WHERE bot_id = ? AND article_link = ?`,
    [success ?? false, aiContent ?? null, botId, articleLink]
  )
}

async function getAiCachedIds(conn, topicId, articleIds) {
  if (articleIds.length === 0) return new Set()
  const placeholders = articleIds.map(() => '?').join(',')
  const [rows] = await conn.execute(
    `SELECT article_id FROM article_topic_ai_result WHERE topic_id = ? AND article_id IN (${placeholders})`,
    [topicId, ...articleIds]
  )
  return new Set(rows.map(r => r.article_id))
}

async function saveAiResults(conn, topicId, articles) {
  if (articles.length === 0) return
  const placeholders = articles.map(() => '(?,?,?,?)').join(',')
  await conn.execute(
    `INSERT IGNORE INTO article_topic_ai_result (article_id, topic_id, selected, push_at_cache) VALUES ${placeholders}`,
    articles.flatMap(a => [a.id, topicId, a.selected ? 1 : 0, parsePush(a.push)])
  )
}

async function invalidateStaleAiCache(conn, board, threshold = 5) {
  const [rows] = await conn.execute(
    `SELECT r.article_id, r.push_at_cache, a.push
     FROM article_topic_ai_result r
     JOIN articles a ON a.id = r.article_id
     WHERE a.link LIKE ? AND r.selected = FALSE`,
    [`%/bbs/${board}/%`]
  )
  const stale = rows.filter(r => parsePush(r.push) - r.push_at_cache >= threshold)
  if (stale.length === 0) return 0
  const ids = stale.map(r => r.article_id)
  const ph = ids.map(() => '?').join(',')
  const [result] = await conn.execute(
    `DELETE FROM article_topic_ai_result WHERE article_id IN (${ph}) AND selected = FALSE`,
    ids
  )
  return result.affectedRows
}

async function getSelectedArticles(conn, topicId) {
  const [rows] = await conn.execute(
    `SELECT a.id, a.title, a.link, a.aid, a.board, a.push
     FROM articles a
     JOIN article_topic_ai_result r ON r.article_id = a.id
     WHERE r.topic_id = ? AND r.selected = TRUE
       AND (
         (a.created_at IS NOT NULL AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR))
         OR
         (a.created_at IS NULL AND TRIM(a.date) = DATE_FORMAT(CONVERT_TZ(NOW(), '+00:00', '+08:00'), '%c/%e'))
       )
     ORDER BY a.id DESC LIMIT 100`,
    [topicId, ARTICLE_MAX_AGE_HOURS]
  )
  return rows
}

async function countTodayBoardReplies(conn, botId, board) {
  // DB 時區為 UTC，用 +8 偏移換算成台灣日期，確保午夜重置時間正確
  const [rows] = await conn.execute(
    `SELECT COUNT(DISTINCT article_link) AS cnt FROM reply_log
     WHERE bot_id = ? AND article_link LIKE ?
       AND success = TRUE
       AND DATE(replied_at + INTERVAL 8 HOUR) = DATE(NOW() + INTERVAL 8 HOUR)`,
    [botId, `%/bbs/${board}/%`]
  )
  return rows[0].cnt
}

// ── Helpers ─────────────────────────────────────────────────────────

function parsePush(p) {
  if (p === '100+') return 100
  const s = String(p)
  if (s.startsWith('X')) return (parseInt(s.slice(1)) || 0) * 2
  return parseInt(s) || 0
}

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

// AI rate limiter — serialises all AI calls with a minimum interval between them.
// withAiRateLimit(fn) queues fn behind any in-flight call and waits AI_MIN_INTERVAL
// after the previous call completes before starting fn.
const AI_MIN_INTERVAL = 12000
let lastAiCallAt = 0
let aiCallLock = Promise.resolve()

function withAiRateLimit(fn) {
  const slot = aiCallLock.then(async () => {
    const elapsed = Date.now() - lastAiCallAt
    if (lastAiCallAt > 0 && elapsed < AI_MIN_INTERVAL) {
      const wait = AI_MIN_INTERVAL - elapsed
      console.log(`⏳ Waiting ${Math.ceil(wait / 1000)}s for AI rate limit...`)
      await sleep(wait)
    }
    try {
      return await fn()
    } finally {
      lastAiCallAt = Date.now()
    }
  })
  aiCallLock = slot.catch(() => {})
  return slot
}

// ── Reply ────────────────────────────────────────────────────────────

async function replyWithBot(bot, article, { preGeneratedContent, onContentReady, onPostDone, aiRateLimiter } = {}) {
  const aid = article.aid || extractAid(article.link)
  const board = article.board
  if (!aid || !board) {
    console.error(`[Bot ${bot.ptt_id}] Missing aid or board for: ${article.link}`)
    return { ok: false, aiContent: null }
  }

  const antiAiRules = '回覆內容至少800字以上。不要介紹文章背景，不要分析正反兩面，直接發洩你的直覺反應。可以有語氣詞、不完整句子、PTT縮寫（ㄟ、ㄏㄏ、Xdd、幹、靠北、笑死等），不需要每句話都結構完整。禁止用條列或段落標題整理論點，禁止「首先」「再來」「最後」這類結構詞，禁止開頭打招呼語（如哈囉各位、大家好等）。'
  const stance = [bot.stance, bot.tone, antiAiRules].filter(Boolean).join('\n')
  const proxyUrl = bot.proxy_host
    ? `http://${bot.proxy_user}:${bot.proxy_pass}@${bot.proxy_host}:${bot.proxy_port}`
    : null
  const poster = new Poster(bot.ptt_id, bot.password)
  const makeTimeout = (ms, label) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)
  )
  const CONTENT_TIMEOUT_MS = 100_000        // 100s：登入 + AI 生成
  const isDev = process.env.NODE_ENV === 'develop'
  const POST_PHASE_TIMEOUT_MS = isDev ? 30 * 60_000 : 15 * 60_000 // dev: 30min, prod: 15min

  // Starts postArticle (triggers AI) and waits for content to be ready.
  // Runs inside aiRateLimiter so the AI call is serialised; postPromise continues after.
  const startAndGetContent = async () => {
    const postPromise = poster.postArticle({
      board,
      aid,
      stance,
      proxyUrl,
      isSendByWord: true,
      isNeedBackup: false,
      preGeneratedContent: preGeneratedContent || null,
      onPostDone,
    }).catch(err => { console.error(`[Poster ${bot.ptt_id}] Background error:`, err.message); return null })
    const result = await Promise.race([poster.contentReady, makeTimeout(CONTENT_TIMEOUT_MS, 'content not ready within 100s').catch(err => { poster.abort(); throw err })])
    return { postPromise, result }
  }

  try {
    const { postPromise, result } = aiRateLimiter && !preGeneratedContent
      ? await aiRateLimiter(startAndGetContent)
      : await startAndGetContent()

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
    await Promise.race([
      postPromise,
      makeTimeout(POST_PHASE_TIMEOUT_MS, 'posting phase timed out after resume'),
    ]).catch(err => { poster.abort(); throw err })
    return { ok: true, aiContent }
  } catch (err) {
    console.error(`[Bot ${bot.ptt_id}] Post failed:`, err.message)
    return { ok: false, aiContent: null }
  }
}

// ── Scheduled posts ──────────────────────────────────────────────────

async function runScheduledPosts() {
  const pool = createPool()
  try {
    const [posts] = await pool.execute(
      `SELECT sp.*,
              b.ptt_id, b.password,
              p.host AS proxy_host, p.port AS proxy_port,
              p.username AS proxy_user, p.password AS proxy_pass
       FROM scheduled_posts sp
       JOIN bots b ON b.id = sp.bot_id AND b.is_active = TRUE
       LEFT JOIN proxies p ON p.id = b.proxy_id AND p.is_active = TRUE
       WHERE sp.status = 'pending' AND sp.scheduled_at <= UTC_TIMESTAMP()`
    )

    if (posts.length === 0) return

    console.log(`[ScheduledPost] ${posts.length} post(s) due`)

    await Promise.all(posts.map(async post => {
      const [upd] = await pool.execute(
        `UPDATE scheduled_posts SET status = 'processing' WHERE id = ? AND status = 'pending'`,
        [post.id]
      )
      if (upd.affectedRows === 0) {
        console.log(`[ScheduledPost ${post.id}] Already claimed, skipping`)
        return
      }

      const isDryRun = process.env.DRY_RUN === 'true'
      if (isDryRun) {
        console.log(`[ScheduledPost ${post.id}] DRY_RUN: would post "${post.title}" to ${post.board}, skipping`)
        await pool.execute(
          `UPDATE scheduled_posts SET status = 'pending' WHERE id = ?`,
          [post.id]
        )
        return
      }

      try {
        let content = post.content
        if (!content) {
          if (!post.ai_prompt) {
            throw new Error('Neither content nor ai_prompt is set')
          }
          console.log(`[ScheduledPost ${post.id}] Generating AI content...`)
          const aiResult = await withAiRateLimit(() => generateContentByGoogle({ prompt: post.ai_prompt }))
          if (!aiResult || !aiResult.success) {
            throw new Error(aiResult?.message || 'AI returned empty content')
          }
          content = aiResult.value
          await pool.execute(
            `UPDATE scheduled_posts SET content = ? WHERE id = ?`,
            [content, post.id]
          )
        }

        const proxyUrl = post.proxy_host
          ? `http://${post.proxy_user}:${post.proxy_pass}@${post.proxy_host}:${post.proxy_port}`
          : null

        const poster = new Poster(post.ptt_id, post.password)

        const makeTimeout = (ms, label) => new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)
        )

        const postPromise = poster.postArticle({
          board: post.board,
          title: post.title,
          category: post.category ?? 1,
          preGeneratedContent: content,
          isSendByWord: true,
          isNeedBackup: false,
          proxyUrl,
        }).catch(err => {
          console.error(`[ScheduledPost ${post.id}] Background error:`, err.message)
          throw err
        })

        await Promise.race([
          poster.contentReady,
          postPromise,
          makeTimeout(100_000, 'content not ready within 100s').catch(err => { poster.abort(); throw err }),
        ])
        poster.continueState()
        await Promise.race([
          postPromise,
          makeTimeout(POST_PHASE_TIMEOUT_MS, 'posting phase timed out after resume'),
        ]).catch(err => { poster.abort(); throw err })

        await pool.execute(
          `UPDATE scheduled_posts SET status = 'done', posted_at = UTC_TIMESTAMP() WHERE id = ?`,
          [post.id]
        )
        console.log(`[ScheduledPost ${post.id}] ✅ Posted successfully`)
      } catch (err) {
        console.error(`[ScheduledPost ${post.id}] ❌ Failed:`, err.message)
        await pool.execute(
          `UPDATE scheduled_posts SET status = 'failed', error_msg = ? WHERE id = ?`,
          [err.message.slice(0, 500), post.id]
        )
      }
    }))
  } finally {
    await pool.end()
  }
}

// ── Crawl job ────────────────────────────────────────────────────────

async function runCrawl() {
  console.log(`\n[${new Date().toISOString()}] Starting crawl...`)
  const pool = createPool()
  try {
    const topics = await loadTopics(pool)
    const boards = [...new Set(topics.map(t => t.board))]
    for (const board of boards) {
      console.log(`Crawling ${board}...`)
      await crawlNewPosts(5, board, { skipContent: true })
      const deleted = await invalidateStaleAiCache(pool, board)
      if (deleted > 0) console.log(`${board}: invalidated ${deleted} stale cache entries (push jumped ≥5)`)
    }
    console.log('✅ Crawl complete')
  } finally {
    await pool.end()
  }
}

// ── Main workflow ─────────────────────────────────────────────────────

const INTER_TOPIC_DELAY_MS  = parseInt(process.env.INTER_TOPIC_DELAY_MS  || '60000')   // 1 min between boards
const INTER_BOT_STAGGER_MS  = parseInt(process.env.INTER_BOT_STAGGER_MS  || '30000')   // 30s between bots
const ARTICLE_MAX_AGE_HOURS = parseInt(process.env.ARTICLE_MAX_AGE_HOURS || '48') || 48

async function runWorkflow(runningBots = new Set()) {
  console.log(`\n[${new Date().toISOString()}] Starting workflow...`)
  const pool = createPool()

  try {
    await initSchema(pool)

    const topics = await loadTopics(pool)
    if (topics.length === 0) { console.log('No active topics.'); return }
    console.log(`Loaded ${topics.length} topic(s)`)

    for (let topicIdx = 0; topicIdx < topics.length; topicIdx++) {
      if (topicIdx > 0) {
        console.log(`⏳ Waiting ${INTER_TOPIC_DELAY_MS / 1000}s before next board...`)
        await sleep(INTER_TOPIC_DELAY_MS)
      }
      const topic = topics[topicIdx]
      console.log(`\n📋 Topic: board=${topic.board} keywords=${JSON.stringify(topic.keywords)}`)

      try {
        const bots = await loadSubscribedBots(pool, topic.id)
        console.log(`Subscribed bots: ${bots.length}`)

        if (bots.length === 0) {
          console.log(`No subscribed bots for topic ${topic.id}, skipping`)
          continue
        }

        const botFailedMap = new Map()
        for (const bot of bots) {
          const failed = await getFailedReplies(pool, bot.id, topic.board)
          if (failed.length > 0) botFailedMap.set(bot.id, failed)
        }

        const [rawArticles] = await pool.execute(
          `SELECT id, title, link, aid, board, push FROM articles
            WHERE link LIKE ? ORDER BY id DESC LIMIT 100`,
          [`%/bbs/${topic.board}/%`]
        )
        console.log(`DB returned ${rawArticles.length} articles for ${topic.board}`)

        const keyFiltered = keywordFilter(rawArticles, topic.keywords)
        console.log(`After keyword filter: ${keyFiltered.length} article(s)`)

        if (keyFiltered.length > 0) {
          const cachedIds = await getAiCachedIds(pool, topic.id, keyFiltered.map(a => a.id))
          const uncached = keyFiltered.filter(a => !cachedIds.has(a.id))
          if (uncached.length > 0) {
            console.log(`Running AI filter on ${uncached.length} new article(s)...`)
            try {
              const selected = await withAiRateLimit(() => aiFilter(uncached, topic.ai_prompt))
              const selectedIds = new Set(selected.map(a => a.id))
              await saveAiResults(pool, topic.id, uncached.map(a => ({ id: a.id, selected: selectedIds.has(a.id), push: a.push })))
              console.log(`AI selected ${selected.length} new, cached ${uncached.length}`)
            } catch (err) {
              console.error(`AI filter failed, skipping cache write:`, err.message)
            }
          } else {
            console.log(`All ${keyFiltered.length} article(s) already AI-filtered, using cache`)
          }
        }

        const cachedSelected = await getSelectedArticles(pool, topic.id)
        const sortedArticles = [...cachedSelected].sort((a, b) => parsePush(b.push) - parsePush(a.push))
        console.log(`${sortedArticles.length} article(s) available for bots`)

        const twHour = (new Date().getUTCHours() + 8) % 24
        const claimedLinks = new Set()

        for (let botIdx = 0; botIdx < bots.length; botIdx++) {
          if (botIdx > 0) {
            console.log(`⏳ Waiting ${INTER_BOT_STAGGER_MS / 1000}s before next bot...`)
            await sleep(INTER_BOT_STAGGER_MS)
          }
          const bot = bots[botIdx]
          if (bot.start_hour !== null && bot.end_hour !== null) {
            const inWindow = bot.start_hour <= bot.end_hour
              ? twHour >= bot.start_hour && twHour < bot.end_hour
              : twHour >= bot.start_hour || twHour < bot.end_hour
            if (!inWindow) {
              console.log(`[Bot ${bot.ptt_id}] 目前 ${twHour} 點不在啟動時段 ${bot.start_hour}-${bot.end_hour}，跳過`)
              continue
            }
          }

          if (runningBots.has(bot.id)) {
            console.log(`[Bot ${bot.ptt_id}] 上一輪尚未完成，跳過`)
            continue
          }

          runningBots.add(bot.id)
          try {
            if (botFailedMap.has(bot.id)) {
              const failed = botFailedMap.get(bot.id)
              console.log(`[Bot ${bot.ptt_id}] ${failed.length} failed reply(s) to retry`)
              const dailyLimit = topic.daily_limit ?? 5
              const todayReplies = await countTodayBoardReplies(pool, bot.id, topic.board)
              if (todayReplies >= dailyLimit) {
                console.log(`[Bot ${bot.ptt_id}] 已達今日上限 ${dailyLimit} 篇，跳過 retry`)
                continue
              }
              for (const failedReply of failed) {
                const article = {
                  link: failedReply.article_link,
                  title: failedReply.article_title,
                  board: topic.board,
                }
                const hasContent = !!failedReply.ai_content
                console.log(`[Bot ${bot.ptt_id}] Retrying: "${failedReply.article_title}" (${hasContent ? 'reuse content' : 'regenerate'})`)
                const { ok, aiContent, skipped } = await replyWithBot(bot, article, {
                  preGeneratedContent: failedReply.ai_content || null,
                  aiRateLimiter: withAiRateLimit,
                  onContentReady: hasContent ? null : async (content) => {
                    if (await hasDuplicateContent(pool, bot.id, content)) {
                      console.log(`[Bot ${bot.ptt_id}] ⚠️ Duplicate content on retry, skipping`)
                      return false
                    }
                    await updateReplyLog(pool, bot.id, failedReply.article_link, { success: false, aiContent: content })
                  },
                  onPostDone: async () => {
                    await updateReplyLog(pool, bot.id, failedReply.article_link, { success: true, aiContent: failedReply.ai_content })
                    console.log(`[Bot ${bot.ptt_id}] ✅ Post confirmed on PTT, DB updated`)
                  },
                })
                if (skipped) {
                  console.log(`[Bot ${bot.ptt_id}] ⏭️ Retry skipped (duplicate content)`)
                } else {
                  await updateReplyLog(pool, bot.id, failedReply.article_link, { success: ok, aiContent: aiContent || failedReply.ai_content })
                  console.log(`[Bot ${bot.ptt_id}] ${ok ? '✅ Retry succeeded' : '❌ Retry failed'}`)
                }
              }
            } else {
              const dailyLimit = topic.daily_limit ?? 5
              const todayReplies = await countTodayBoardReplies(pool, bot.id, topic.board)
              console.log(`[Bot ${bot.ptt_id}] Today's replies for ${topic.board}: ${todayReplies}/${dailyLimit}`)

              if (todayReplies >= dailyLimit) {
                console.log(`[Bot ${bot.ptt_id}] 已達今日上限 ${dailyLimit} 篇，跳過`)
                continue
              }

              let target = null
              for (const article of sortedArticles) {
                if (claimedLinks.has(article.link)) {
                  console.log(`[Bot ${bot.ptt_id}] ⏭ 文章已被其他 bot 認領，跳過: "${article.title.substring(0, 30)}"`)
                  continue
                }
                claimedLinks.add(article.link)
                if (await hasReplied(pool, bot.id, article.link)) {
                  claimedLinks.delete(article.link)
                  continue
                }
                const baseTitle = getBaseTitle(article.title)
                if (await hasRepliedToSameThread(pool, bot.id, topic.board, baseTitle)) {
                  claimedLinks.delete(article.link)
                  console.log(`[Bot ${bot.ptt_id}] ⚠️ Same thread already replied: "${baseTitle}", skipping "${article.title}"`)
                  continue
                }
                target = article
                break
              }

              if (!target) {
                console.log(`[Bot ${bot.ptt_id}] 沒有可回覆的新文章`)
                continue
              }

              console.log(`[Bot ${bot.ptt_id}] Replying to: "${target.title}" (push: ${target.push})`)

              let capturedContent = null
              const { ok, aiContent, skipped } = await replyWithBot(bot, target, {
                aiRateLimiter: withAiRateLimit,
                onContentReady: async (content) => {
                  if (await hasDuplicateContent(pool, bot.id, content)) {
                    console.log(`[Bot ${bot.ptt_id}] ⚠️ Duplicate content detected, skipping post`)
                    return false
                  }
                  capturedContent = content
                  await logReply(pool, bot.id, target.link, {
                    board: topic.board,
                    articleTitle: target.title,
                    topicId: topic.id,
                    success: false,
                    aiContent: content,
                  })
                },
                onPostDone: async () => {
                  await updateReplyLog(pool, bot.id, target.link, { success: true, aiContent: capturedContent })
                  console.log(`[Bot ${bot.ptt_id}] ✅ Post confirmed on PTT, DB updated`)
                },
              })
              if (skipped) {
                console.log(`[Bot ${bot.ptt_id}] ⏭️ Skipped (duplicate content)`)
              } else {
                await updateReplyLog(pool, bot.id, target.link, { success: ok, aiContent })
                console.log(`[Bot ${bot.ptt_id}] ${ok ? '✅ Reply logged' : '❌ Reply failed, logged'}`)
              }
            }
          } catch (err) {
            console.error(`[Bot ${bot.ptt_id}] Error:`, err.message)
          } finally {
            runningBots.delete(bot.id)
          }
        }
      } catch (err) {
        console.error(`[Topic ${topic.board}] Error, skipping:`, err.message)
      }
    }

    console.log(`\n✅ Workflow complete`)
  } finally {
    await pool.end()
  }
}

module.exports = { runWorkflow, runCrawl, runScheduledPosts, initSchema, createPool }

if (require.main === module) {
  runWorkflow().catch(err => {
    console.error('❌ Workflow error:', err.message)
    process.exit(1)
  })
}
