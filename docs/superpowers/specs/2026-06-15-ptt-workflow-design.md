# PTT Workflow 設計文件

**日期：** 2026-06-15
**狀態：** 已批准

---

## 概述

建立一個獨立的 `ptt-workflow` 專案，實現以下自動化流程：

**抓取文章列表 → 關鍵字初篩 → AI 選題 → 多帳號自動回文**

此專案作為獨立 Node.js 應用加入工作區，核心邏輯（`posterWS.js`、`ai.js`）從原 `ptt` 專案以相對路徑 require，不複製程式碼。

---

## 架構

### 專案結構

```
ptt-workflow/
├── index.js          # 手動觸發入口（node index.js）
├── workflow.js       # 主流程協調器
├── db.js             # MySQL 連線 + 初始化 schema
├── filter.js         # 關鍵字初篩 + AI 批次篩選
├── replier.js        # 呼叫 posterWS 回文
├── scheduler.js      # node-schedule 定時排程入口
├── package.json
└── .env              # DB 連線、Gemini API key
```

### 相依關係

- `ptt-workflow` 直接 require `../ptt/posterWS.js` 和 `../ptt/ai.js`
- 共用同一個 MySQL 資料庫（同一 DB instance，新增三張表）

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
  3. 爬文：對每個 topic 的 board 爬取最新文章列表
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
- AI 回傳值得回文的文章索引或連結清單
- 遵守 `ai.js` 現有的 rate limit（兩次呼叫間隔 ≥ 2 分鐘）

---

## 回文邏輯（replier.js）

- 對每個 bot 依序（非平行）呼叫 posterWS 回文，避免同時登入衝突
- AI 生成回文時，system prompt = `bot.stance`，語氣由 `bot.tone` 補充
- 回文成功才寫 reply_log；失敗則 log error，繼續下一個

---

## 觸發方式

### 手動
```bash
node index.js
```

### 排程
```bash
node scheduler.js   # 持續執行，依 DB 設定的 cron expression 定時觸發
```

排程 cron expression 寫在 `scheduler.js` 中，預設 `0 * * * *`（每小時整點），可透過 `.env` 的 `CRON_SCHEDULE` 覆蓋。

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
