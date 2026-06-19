# 預約發文功能設計

**日期：** 2026-06-19  
**範圍：** 一次性排程，讓指定 bot 在指定時間於 PTT 發新文（非回文）

---

## 需求摘要

- 使用者事先在資料庫建立「預約發文」記錄，設定看板、標題、內容與發文時間
- 到達發文時間時系統自動以指定 bot 登入 PTT 發新文
- 內容可手動填寫，或僅提供 AI prompt，由系統在發文時生成
- 透過 CLI 腳本（`schedule-post.js`）建立預約記錄

---

## 資料模型

新增 `scheduled_posts` 資料表：

```sql
CREATE TABLE scheduled_posts (
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
```

**欄位規則：**
- `content` 與 `ai_prompt` 至少填一個；`content` 優先，為 NULL 時呼叫 AI
- `scheduled_at` 以 ISO 8601 格式輸入（如 `2026-06-20T15:30:00+08:00`），存入 DB 前轉為 UTC
- `status` 防止重複發文：撈出後立即 UPDATE 為 `'done'`，失敗再改為 `'failed'`

---

## 元件

### `workflow.js` — 新增 `runScheduledPosts()`

```
1. 查詢 WHERE status='pending' AND scheduled_at <= UTC_TIMESTAMP()
2. 對每筆記錄：
   a. 查出 bot（帳號/密碼/proxy）
   b. 若 content 為 NULL → 呼叫 AI 生成（帶 ai_prompt）
   c. 呼叫 Poster.postArticle({ board, title, category, content })
   d. 成功 → status='done', posted_at=NOW()
   e. 失敗 → status='failed', error_msg=錯誤訊息
```

`initSchema()` 中加入 `scheduled_posts` 建表與 ALTER TABLE 遷移。

### `scheduler.js` — 新增每分鐘 cron job

```js
schedule.scheduleJob('* * * * *', async () => {
  await runScheduledPosts()
})
```

### `schedule-post.js`（新檔）— CLI 腳本

**必填參數：** `--bot-id`、`--board`、`--title`、`--at`（ISO 8601，如 `2026-06-20T15:30:00+08:00`）  
**選填參數：** `--content`、`--ai-prompt`、`--category`（預設 1）

```bash
# 手動內容
node schedule-post.js \
  --bot-id 1 \
  --board Gossiping \
  --title "測試標題" \
  --content "文章內文..." \
  --at "2026-06-20T15:30:00+08:00"

# AI 生成
node schedule-post.js \
  --bot-id 1 \
  --board Gossiping \
  --title "測試標題" \
  --ai-prompt "請寫一篇關於..." \
  --at "2026-06-20T15:30:00+08:00"
```

---

## 錯誤處理

| 情況 | 處理方式 |
|------|----------|
| 發文失敗 | `status='failed'` + 記錄 `error_msg`，不自動重試 |
| AI 生成失敗 | `status='failed'`，不繼續發文 |
| 防重複發文 | 發文前先 UPDATE status='done'（樂觀鎖定） |
| CLI 參數錯誤 | 印出錯誤訊息並以非零 exit code 退出 |
| 重試 | 手動將 `status` 改回 `'pending'` |

---

## 不在範圍內

- Web UI 管理介面
- 週期性重複發文
- 多 bot 輪流發同一預約
