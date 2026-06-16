// --- 設定 ---
module.exports = {
    replyTimeoutMs: 1200000,  // 20 minutes — workflow.js Promise.race timeout
    postMinDelayMs: 1001,     // ms — PTT requires ≥1s per char to earn P coins
    postMaxDelayMs: 1050,     // ms — upper bound for per-char random delay
    postMaxChars: 900,        // max AI content chars before sentence-boundary truncation
    // MySQL 連接設定（請根據環境修改）
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || 'passwd',
        database: process.env.MYSQL_DATABASE || 'ptt',
        port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    },
    boardName: 'Gossiping', // 可修改看板名稱
    startPage: 1,
    endPage: 10, // 預設：若未動態偵測，爬 10 頁；會被 getTotalPages 覆寫
    maxCrawlPages: 50, // 上限，避免爬太多頁（Gossiping 常上千頁）
    delayMs: 500, // 請求間延遲（修復：加大避免 ban）
    maxLinks: 10, // 新增：最多處理 N 個 link（測試用，調整以避免過多請求）
    headers: { 'Cookie': 'over18=1' } // 繞過 18 禁
}