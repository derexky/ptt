# PTT Workflow 設計文件

**日期：** 2026-06-15
**狀態：** 已批准

---

## 概述

在現有 `ptt` 專案內新增自動化 workflow，實現以下流程：

**抓取文章列表 → 關鍵字初篩 → AI 選題 → 多帳號自動回文**

直接沿用專案內已有的 `crawl.js`、`ai.js`、`posterWS.js`，新增少量檔案完成串接，共用現有 MySQL 資料庫與 `node_modules`。

---

## 架構

### 新增檔案

```
ptt/
├── workflow.js      # 主流程協調器
├── scheduler.js     # node-schedule 定時排程入口
└── filter.js        # 關鍵字初篩 + AI 批次篩選
```

`workflow.js` 手動執行：`node workflow.js`
`scheduler.js` 排程執行：`node scheduler.js`

### 相依的現有模組

- `crawl.js`（`crawlNewPosts`）— 用 axios + cheerio 爬 PTT 網頁版文章列表，結果存入 MySQL `articles` 表
- `posterWS.js` — 透過 WebSocket 連線 PTT 發回文
- `ai.js`（`generateContentByGoogle`）— 呼叫 Gemini API 生成內容
- `main.js` 的 MySQL 連線 — 沿用現有初始化邏輯，新增三張表

---

## 資料庫 Schema

### `bots` — 回文帳號設定

```sql
CREATE TABLE bots (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  ptt_id     VARCHAR(50) NOT NULL,
  password   VARCHAR(100) NOT NULL,
  stance     TEXT,          -- AI system prompt，定義立場
  tone       VARCHAR(200),  -- 語氣關鍵字描述
  is_active  BOOLEAN DEFAULT TRUE
);
```

### `topics` — 主題與看板設定

```sql
CREATE TABLE topics (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  board      VARCHAR(50) NOT NULL,   -- PTT 看板名稱
  keywords   JSON NOT NULL,          -- 初篩關鍵字陣列，例如 ["AI", "人工智慧"]
  ai_prompt  TEXT,                   -- 告訴 AI 要選什麼類型的文章
  is_active  BOOLEAN DEFAULT TRUE
);
```

### `reply_log` — 回文紀錄（去重用）

```sql
CREATE TABLE reply_log (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  bot_id       INT NOT NULL,
  article_link VARCHAR(255) NOT NULL,
  replied_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_reply (bot_id, article_link),
  FOREIGN KEY (bot_id) REFERENCES bots(id)
);
```

---

## 主流程（workflow.js）

```
runWorkflow()
  1. 從 DB 載入所有 is_active=true 的 topics
  2. 從 DB 載入所有 is_active=true 的 bots
  3. 爬文：對每個 topic 的 board 呼叫 crawlNewPosts() 爬取最新文章
  4. 關鍵字初篩：filter.js 用 topic.keywords 過濾標題
  5. AI 篩選：批次送給 AI（使用 topic.ai_prompt），回傳值得回文的文章清單
  6. 逐帳號回文：
     對每篇入選文章 × 每個 bot：
       a. 查 reply_log，(bot_id, article_link) 已存在則跳過
       b. 用 bot.stance + bot.tone 讓 AI 生成回文內容
       c. 呼叫 posterWS 以 bot 帳號發回文
       d. 成功後寫入 reply_log
```

---

## 篩選邏輯（filter.js）

### 關鍵字初篩
- 對文章標題做字串 includes 比對（大小寫不敏感）
- topic.keywords 為 OR 關係（符合任一關鍵字即入選）

### AI 批次篩選
- 將初篩後的文章標題清單一次送給 AI
- Prompt 結構：`topic.ai_prompt` + 文章標題清單
- AI 回傳值得回文的文章索引清單
- 遵守 `ai.js` 現有的 rate limit（兩次呼叫間隔 ≥ 2 分鐘）

---

## 回文邏輯

- 對每個 bot 依序（非平行）呼叫 posterWS 回文，避免同時登入衝突
- AI 生成回文時，system prompt = `bot.stance`，語氣由 `bot.tone` 補充
- 回文成功才寫 reply_log；失敗則 log error，繼續下一個

---

## 觸發方式

### 手動
```bash
node workflow.js
```

### 排程
```bash
node scheduler.js   # 持續執行，定時觸發 runWorkflow()
```

排程 cron expression 預設 `0 * * * *`（每小時整點），可透過 `.env` 的 `CRON_SCHEDULE` 覆蓋。

---

## 錯誤處理

- 爬文失敗：log 並跳過該 topic，不中斷整體流程
- AI 呼叫失敗（rate limit 或 API 錯誤）：log 並跳過該文章
- 回文失敗（PTT 連線問題）：log 並跳過，reply_log 不寫入
- 所有錯誤均 console.error，不 process.exit

---

## 不在範圍內

- 管理後台 UI（帳號/主題的 CRUD 介面）
- 推文（push）功能，只做回文（reply）
- 多執行緒或 worker pool
