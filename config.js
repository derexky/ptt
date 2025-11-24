// --- 設定 ---
module.exports = {
    // MySQL 連接設定（請根據環境修改）
    mysql: {
        host: 'localhost',
        user: 'root', // 預設 MySQL 用戶
        password: 'passwd', // 請修改密碼
        database: 'ptt', // 資料庫名稱
        port: 3306
    },
    boardName: 'Gossiping', // 可修改看板名稱
    startPage: 1,
    endPage: 10, // 預設：若未動態偵測，爬 10 頁；會被 getTotalPages 覆寫
    maxCrawlPages: 50, // 上限，避免爬太多頁（Gossiping 常上千頁）
    delayMs: 500, // 請求間延遲（修復：加大避免 ban）
    maxLinks: 10, // 新增：最多處理 N 個 link（測試用，調整以避免過多請求）
    headers: { 'Cookie': 'over18=1' } // 繞過 18 禁
}