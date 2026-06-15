# PTT Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workflow to `ptt/` that crawls board articles, applies keyword + AI filtering to select topics, then has each configured bot account reply with its own personality.

**Architecture:** Three new files in the existing `ptt/` project. `workflow.js` is the entry point and orchestrator — it initialises the three new DB tables, loads `topics` and `bots` config, calls `crawl.js` to fetch articles, runs `filter.js` for two-stage selection, then loops through bots × articles posting replies via `posterWS.js`. `filter.js` contains the pure keyword filter and the AI batch-selection call. `scheduler.js` wraps `runWorkflow()` with `node-schedule`. All AI calls go through the existing `ai.js` which enforces a 2-minute minimum interval between calls — the plan accounts for this by waiting before each AI-calling step.

**Tech Stack:** Node.js, mysql2/promise, Google Gemini via existing `ai.js`, node-schedule (already in `package.json`), existing `crawl.js` / `posterWS.js` / `ai.js`

**Key constraint:** `ai.js` enforces `MIN_INTERVAL = 120 000 ms` between `generateContentByGoogle` calls at module level. Both `filter.js` (AI selection) and `posterWS.js` (reply generation) go through this same function. The workflow sleeps 130 s before every AI-calling step after the first.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `filter.js` | Create | `keywordFilter(articles, keywords)` + `aiFilter(articles, aiPrompt)` |
| `workflow.js` | Create | DB schema init, config loading, pipeline orchestration, `runWorkflow()` entry point |
| `scheduler.js` | Create | node-schedule cron trigger for `runWorkflow()` |

---

### Task 1: Create DB schema — `bots`, `topics`, `reply_log`

**Files:**
- Create: `workflow.js` (schema init portion only)

- [ ] **Step 1: Write `workflow.js` with just the DB init functions**

```js
// workflow.js
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')

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

module.exports = { createConnection, initSchema }
```

- [ ] **Step 2: Verify tables are created**

```bash
node -e "
const {createConnection,initSchema}=require('./workflow')
createConnection().then(c=>initSchema(c).then(()=>c.end()))
"
```

Expected output:
```
✅ Schema initialised
```

Then confirm in MySQL:
```bash
mysql -u root -p ptt -e "SHOW TABLES LIKE 'bots'; SHOW TABLES LIKE 'topics'; SHOW TABLES LIKE 'reply_log';"
```

Expected: all three tables listed.

- [ ] **Step 3: Commit**

```bash
git add workflow.js
git commit -m "[Add] workflow: DB schema init for bots, topics, reply_log"
```

---

### Task 2: Seed test data

**Files:**
- No new files — direct SQL only

- [ ] **Step 1: Insert one test topic and two test bots**

Run in MySQL (replace placeholder passwords with real PTT test account credentials):

```sql
INSERT INTO topics (board, keywords, ai_prompt, is_active) VALUES (
  'Gossiping',
  '["AI", "人工智慧", "ChatGPT"]',
  '選出有討論空間、可以表達意見的文章。避免選廣告文、感謝文或純分享無爭議的文章。',
  TRUE
);

INSERT INTO bots (ptt_id, password, stance, tone, is_active) VALUES (
  'test_account_1',
  'test_password_1',
  '你是一位對AI科技充滿熱情的工程師，支持科技進步，認為AI將改善人類生活。',
  '理性、有條理、偶爾帶點極客味',
  TRUE
);
```

- [ ] **Step 2: Verify seed data**

```bash
node -e "
const {createConnection}=require('./workflow')
createConnection().then(async c=>{
  const [t]=await c.execute('SELECT id,board,keywords FROM topics')
  const [b]=await c.execute('SELECT id,ptt_id,tone FROM bots')
  console.log('topics:',t)
  console.log('bots:',b)
  await c.end()
})
"
```

Expected: one topic row and one bot row printed.

---

### Task 3: `filter.js` — keyword filter

**Files:**
- Create: `filter.js`

- [ ] **Step 1: Write `keywordFilter` function**

```js
// filter.js
function keywordFilter(articles, keywords) {
  if (!keywords || keywords.length === 0) return articles
  const lower = keywords.map(k => k.toLowerCase())
  return articles.filter(a =>
    lower.some(k => a.title.toLowerCase().includes(k))
  )
}

module.exports = { keywordFilter }
```

- [ ] **Step 2: Verify with a quick inline test**

```bash
node -e "
const {keywordFilter}=require('./filter')
const articles=[
  {title:'AI真的很強嗎？',link:'/bbs/Gossiping/M.1.A.1.html'},
  {title:'今天天氣好',link:'/bbs/Gossiping/M.2.A.2.html'},
  {title:'ChatGPT又出新功能',link:'/bbs/Gossiping/M.3.A.3.html'},
]
const result=keywordFilter(articles,['AI','ChatGPT'])
console.log('filtered count:',result.length)   // expected: 2
console.log(result.map(a=>a.title))
"
```

Expected output:
```
filtered count: 2
[ 'AI真的很強嗎？', 'ChatGPT又出新功能' ]
```

- [ ] **Step 3: Commit**

```bash
git add filter.js
git commit -m "[Add] filter: keywordFilter function"
```

---

### Task 4: `filter.js` — AI filter

**Files:**
- Modify: `filter.js`

- [ ] **Step 1: Add `aiFilter` to `filter.js`**

Replace the entire `filter.js` with:

```js
// filter.js
const { generateContentByGoogle } = require('./ai')

function keywordFilter(articles, keywords) {
  if (!keywords || keywords.length === 0) return articles
  const lower = keywords.map(k => k.toLowerCase())
  return articles.filter(a =>
    lower.some(k => a.title.toLowerCase().includes(k))
  )
}

async function aiFilter(articles, aiPrompt) {
  if (articles.length === 0) return []

  const titlesText = articles.map((a, i) => `${i}: ${a.title}`).join('\n')
  const prompt = [
    aiPrompt,
    '',
    '以下是文章標題清單（格式：索引: 標題）：',
    titlesText,
    '',
    '請從中選出值得回文的文章，以 JSON 陣列格式回傳選出的索引，例如：[0, 2, 5]。只輸出 JSON，不要其他說明文字。',
  ].join('\n')

  const result = await generateContentByGoogle({
    prompt,
    stance: '你是一個文章選題助手，根據使用者的指示，從文章標題清單中選出值得回應的文章。',
  })

  if (!result.success) {
    console.error('[AI Filter] Call failed:', result.message)
    return []
  }

  try {
    const match = result.value.match(/\[[\d,\s]*\]/)
    if (!match) {
      console.error('[AI Filter] Cannot parse response:', result.value)
      return []
    }
    const indices = JSON.parse(match[0])
    return indices
      .filter(i => Number.isInteger(i) && i >= 0 && i < articles.length)
      .map(i => articles[i])
  } catch (e) {
    console.error('[AI Filter] Parse error:', e.message)
    return []
  }
}

module.exports = { keywordFilter, aiFilter }
```

- [ ] **Step 2: Verify `aiFilter` with a live call**

This uses the real Gemini API (counts against your quota).

```bash
node -e "
require('dotenv').config()
const {aiFilter}=require('./filter')
const articles=[
  {title:'AI真的很強嗎？大家怎麼看',link:'/bbs/Gossiping/M.1.A.1.html'},
  {title:'[公告] 看板規則更新',link:'/bbs/Gossiping/M.2.A.2.html'},
  {title:'ChatGPT-5發布了 會不會搶走工作',link:'/bbs/Gossiping/M.3.A.3.html'},
]
aiFilter(articles,'選出有討論空間的文章，避免公告文').then(r=>{
  console.log('AI selected:',r.map(a=>a.title))
}).catch(console.error)
"
```

Expected: 1–2 articles selected (not the 公告 article).

- [ ] **Step 3: Commit**

```bash
git add filter.js
git commit -m "[Add] filter: aiFilter using Gemini batch selection"
```

---

### Task 5: `workflow.js` — complete implementation

**Files:**
- Modify: `workflow.js`

- [ ] **Step 1: Write the complete `workflow.js`**

Replace `workflow.js` entirely:

```js
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
  return rows.map(r => ({ ...r, keywords: JSON.parse(r.keywords) }))
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

  try {
    const result = await poster.contentReady
    console.log(`[Bot ${bot.ptt_id}] Content ready: "${String(result.text || '').slice(0, 60)}..."`)
    poster.continueState()
    // The Poster's internal AI call just completed; mark the time.
    markAiCall()
    return true
  } catch (err) {
    console.error(`[Bot ${bot.ptt_id}] Post failed:`, err.message)
    return false
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
    if (bots.length === 0)   { console.log('No active bots.');   return }

    console.log(`Loaded ${topics.length} topic(s), ${bots.length} bot(s)`)

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
```

- [ ] **Step 2: Dry-run without bots to verify crawl + filter pipeline**

First, temporarily set `is_active = FALSE` on all bots so no actual posts are sent:

```sql
UPDATE bots SET is_active = FALSE;
```

Then run:

```bash
node workflow.js
```

Expected output (abbreviated):
```
✅ Schema initialised
Loaded 1 topic(s), 0 bot(s)
No active bots.
✅ Workflow complete
```

Wait — with no active bots the pipeline exits early. To test the crawl + filter steps, temporarily keep bots active but check that articles are being crawled and filtered. Watch for:
- `DB returned N articles for Gossiping`
- `After keyword filter: N article(s)`
- `AI selected N article(s)`

If you want to test just crawl + filter without any posting, add `return` after the `console.log('AI selected ...')` line temporarily, then remove it after verification.

- [ ] **Step 3: Re-enable bots and run a live reply test with a real PTT account**

```sql
UPDATE bots SET is_active = TRUE;
```

```bash
node workflow.js
```

Watch for:
```
[Bot test_account_1] Content ready: "..."
[Bot test_account_1] ✅ Reply logged
✅ Workflow complete
```

Confirm on PTT that the reply appeared.

- [ ] **Step 4: Verify reply_log prevents duplicate on second run**

```bash
node workflow.js
```

Expected: all articles from the first run log `Already replied to ..., skipping`.

- [ ] **Step 5: Commit**

```bash
git add workflow.js
git commit -m "[Add] workflow: full crawl → filter → reply pipeline"
```

---

### Task 6: `scheduler.js` — cron trigger

**Files:**
- Create: `scheduler.js`

- [ ] **Step 1: Write `scheduler.js`**

```js
// scheduler.js
require('dotenv').config()
const schedule = require('node-schedule')
const { runWorkflow } = require('./workflow')

const cronExpr = process.env.CRON_SCHEDULE || '0 * * * *'

let running = false

const job = schedule.scheduleJob(cronExpr, async () => {
  if (running) {
    console.log(`[${new Date().toISOString()}] Previous run still in progress, skipping.`)
    return
  }
  running = true
  console.log(`[${new Date().toISOString()}] Scheduled run starting...`)
  try {
    await runWorkflow()
  } catch (err) {
    console.error(`[Scheduler] Error:`, err.message)
  } finally {
    running = false
  }
})

console.log(`Scheduler started. Cron: "${cronExpr}"`)
console.log(`Next fire: ${job.nextInvocation()}`)
console.log('Press Ctrl+C to stop.')
```

- [ ] **Step 2: Verify the scheduler fires**

Set `CRON_SCHEDULE` to fire every 2 minutes for testing:

```bash
CRON_SCHEDULE="*/2 * * * *" node scheduler.js
```

Expected output:
```
Scheduler started. Cron: "*/2 * * * *" (next fire: ...)
Press Ctrl+C to stop.
[2026-06-15T...] Scheduled run starting...
✅ Schema initialised
...
✅ Workflow complete
```

After confirming it fires, stop with Ctrl+C and remove the env override.

- [ ] **Step 3: Commit**

```bash
git add scheduler.js
git commit -m "[Add] scheduler: cron trigger for runWorkflow"
```

---

## Notes

**Rate limit:** With `MIN_INTERVAL = 120 s` in `ai.js`, each workflow run costs at minimum:
- 1 AI call per topic (filter) + 1 AI call per bot × selected article (reply)
- Total wait time ≈ `(1 + bots × selected_articles) × 130 s` per topic
- Example: 1 topic, 1 bot, 3 selected articles → ~8 min total

**Adding more bots/topics:** Insert rows into `bots` / `topics` tables. No code changes needed.

**Disabling a bot or topic:** `UPDATE bots SET is_active = FALSE WHERE id = N`
