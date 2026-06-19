# Scheduled Post Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓系統在指定時間自動以指定 bot 於 PTT 發新文（非回文），支援手動內容或 AI 生成。

**Architecture:** 在 `workflow.js` 加入 `runScheduledPosts()` 查詢到期的 `scheduled_posts` 記錄並發文；`scheduler.js` 加一個每分鐘 cron job 呼叫它；新增 `schedule-post.js` CLI 建立預約記錄。

**Tech Stack:** Node.js, mysql2/promise, node-schedule, `posterWS.js` Poster class, `ai.js` generateContentByGoogle

---

## File Map

| 動作 | 檔案 | 說明 |
|------|------|------|
| Modify | `workflow.js` | `initSchema()` 加建表；新增 `runScheduledPosts()` 與 `module.exports` |
| Modify | `scheduler.js` | 加每分鐘 cron job |
| Create | `schedule-post.js` | CLI：建立預約發文記錄 |

---

## Task 1：DB Schema — 新增 `scheduled_posts` 表

**Files:**
- Modify: `workflow.js`

- [ ] **Step 1：在 `initSchema()` 末尾加入建表 SQL**

在 `workflow.js` 的 `initSchema` 函式中，找到最後一個 `await conn.execute(...)` 之後（約 line 122 `console.log('✅ Schema initialised')` 之前），插入：

```js
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
      status       ENUM('pending','done','failed') DEFAULT 'pending',
      posted_at    DATETIME DEFAULT NULL,
      error_msg    TEXT DEFAULT NULL,
      FOREIGN KEY (bot_id) REFERENCES bots(id)
    )
  `)
```

- [ ] **Step 2：驗證建表**

```bash
node -e "
require('dotenv').config()
const { createPool, initSchema } = require('./workflow')
const pool = createPool()
initSchema(pool).then(() => pool.end()).then(() => console.log('OK'))
"
```

預期輸出：`✅ Schema initialised` 然後 `OK`

- [ ] **Step 3：確認欄位存在**

```bash
node -e "
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
mysql.createConnection(config.mysql).then(async c => {
  const [rows] = await c.execute('DESCRIBE scheduled_posts')
  rows.forEach(r => console.log(r.Field, r.Type))
  await c.end()
})
"
```

預期輸出包含：`id`, `bot_id`, `board`, `title`, `category`, `content`, `ai_prompt`, `scheduled_at`, `status`, `posted_at`, `error_msg`

- [ ] **Step 4：Commit**

```bash
git add workflow.js
git commit -m "feat: add scheduled_posts table to initSchema"
```

---

## Task 2：`runScheduledPosts()` — 核心發文邏輯

**Files:**
- Modify: `workflow.js`

- [ ] **Step 1：在 `workflow.js` 加入 `runScheduledPosts` 函式**

在 `runCrawl` 函式之前（約 line 369）插入以下完整函式：

```js
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

    for (const post of posts) {
      const [upd] = await pool.execute(
        `UPDATE scheduled_posts SET status = 'done' WHERE id = ? AND status = 'pending'`,
        [post.id]
      )
      if (upd.affectedRows === 0) {
        console.log(`[ScheduledPost ${post.id}] Already claimed, skipping`)
        continue
      }

      try {
        let content = post.content
        if (!content) {
          console.log(`[ScheduledPost ${post.id}] Generating AI content...`)
          const aiResult = await generateContentByGoogle({ prompt: post.ai_prompt })
          if (!aiResult || !aiResult.success) {
            throw new Error(aiResult?.message || 'AI returned empty content')
          }
          content = aiResult.value
        }

        const proxyUrl = post.proxy_host
          ? `http://${post.proxy_user}:${post.proxy_pass}@${post.proxy_host}:${post.proxy_port}`
          : null

        const poster = new Poster(post.ptt_id, post.password)

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
          return null
        })

        await poster.contentReady
        poster.continueState()
        await postPromise

        await pool.execute(
          `UPDATE scheduled_posts SET posted_at = UTC_TIMESTAMP() WHERE id = ?`,
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
    }
  } finally {
    await pool.end()
  }
}
```

- [ ] **Step 2：在 `workflow.js` 頂部加入 AI import**

找到 `workflow.js` 第 7 行附近現有的 require 區塊：

```js
const { keywordFilter, aiFilter } = require('./filter')
```

在它之後加一行：

```js
const { generateContentByGoogle } = require('./ai')
```

- [ ] **Step 3：將 `runScheduledPosts` 加入 `module.exports`**

找到 `workflow.js` 最底部：

```js
module.exports = { runWorkflow, runCrawl, initSchema, createPool }
```

改為：

```js
module.exports = { runWorkflow, runCrawl, runScheduledPosts, initSchema, createPool }
```

- [ ] **Step 4：手動整合測試**

先在 DB 插入一筆過去時間的測試記錄（用你實際存在的 bot_id，例如 1）：

```bash
node -e "
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
mysql.createConnection(config.mysql).then(async c => {
  await c.execute(
    \`INSERT INTO scheduled_posts (bot_id, board, title, content, scheduled_at)
     VALUES (1, 'Test', '測試預約發文', '這是測試內容，不應實際發出。', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE))\`
  )
  console.log('Inserted test record')
  await c.end()
})
"
```

- [ ] **Step 5：確認 `runScheduledPosts` 能撈到該記錄並嘗試發文**

```bash
node -e "
require('dotenv').config()
const { runScheduledPosts } = require('./workflow')
runScheduledPosts().then(() => console.log('Done')).catch(e => console.error(e.message))
"
```

預期看到 `[ScheduledPost 1] 1 post(s) due` 以及發文流程或失敗訊息（若測試看板不存在則 failed，status 會改為 failed，這是正確行為）。

- [ ] **Step 6：確認 DB 狀態已更新**

```bash
node -e "
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
mysql.createConnection(config.mysql).then(async c => {
  const [rows] = await c.execute('SELECT id, status, error_msg, posted_at FROM scheduled_posts ORDER BY id DESC LIMIT 3')
  console.table(rows)
  await c.end()
})
"
```

預期：status 為 `done` 或 `failed`（不再是 `pending`）。

- [ ] **Step 7：Commit**

```bash
git add workflow.js
git commit -m "feat: add runScheduledPosts() to workflow"
```

---

## Task 3：`scheduler.js` — 加每分鐘 cron job

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1：在 `scheduler.js` 頂部 require 加入 `runScheduledPosts`**

找到第 4 行：

```js
const { runWorkflow, runCrawl } = require('./workflow')
```

改為：

```js
const { runWorkflow, runCrawl, runScheduledPosts } = require('./workflow')
```

- [ ] **Step 2：在現有 `crawlJob` 定義之後加入每分鐘 job**

在 `scheduler.js` 的 `crawlJob` 區塊結束後（約 line 34，`crawling = false` 的 finally 之後），加入：

```js
schedule.scheduleJob('* * * * *', async () => {
  try {
    await runScheduledPosts()
  } catch (err) {
    console.error(`[ScheduledPost] Error:`, err.message)
  }
})
```

- [ ] **Step 3：驗證 scheduler 啟動正常**

```bash
node scheduler.js
```

預期輸出包含原本的 Bot cron / Crawl cron 訊息，且不報錯。按 Ctrl+C 停止。

- [ ] **Step 4：Commit**

```bash
git add scheduler.js
git commit -m "feat: add per-minute scheduled post cron job to scheduler"
```

---

## Task 4：`schedule-post.js` — CLI 建立預約記錄

**Files:**
- Create: `schedule-post.js`

- [ ] **Step 1：建立 `schedule-post.js`**

```js
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
```

- [ ] **Step 2：測試必填驗證**

```bash
node schedule-post.js
```

預期：印出錯誤訊息 `❌ 缺少必填參數` 並 exit 1

```bash
node schedule-post.js --bot-id 1 --board Gossiping --title "測試" --at "2026-06-20T15:30:00+08:00"
```

預期：印出 `❌ --content 與 --ai-prompt 至少填一個` 並 exit 1

```bash
node schedule-post.js --bot-id 1 --board Gossiping --title "測試" --content "內文" --at "not-a-date"
```

預期：印出 `❌ --at 格式錯誤` 並 exit 1

- [ ] **Step 3：測試正常建立**

```bash
node schedule-post.js \
  --bot-id 1 \
  --board Gossiping \
  --title "排程測試文章" \
  --content "這是排程發文的測試內容。" \
  --at "2099-12-31T23:59:00+08:00"
```

預期：`✅ 預約發文已建立 (id=...)` 並列出各欄位確認

- [ ] **Step 4：確認 DB 記錄**

```bash
node -e "
require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
mysql.createConnection(config.mysql).then(async c => {
  const [rows] = await c.execute('SELECT id, bot_id, board, title, scheduled_at, status FROM scheduled_posts ORDER BY id DESC LIMIT 3')
  console.table(rows)
  await c.end()
})
"
```

預期：剛建立的記錄 status=`pending`，scheduled_at 已換算為 UTC

- [ ] **Step 5：Commit**

```bash
git add schedule-post.js
git commit -m "feat: add schedule-post.js CLI for creating scheduled posts"
```
