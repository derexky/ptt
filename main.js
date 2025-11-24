const axios = require("axios")
const cheerio = require("cheerio")
const mysql = require("mysql2/promise") // MySQL 模組（支援 Promise）
const config = require("./config")
const schedule = require("node-schedule")
const { crawlNewPosts } = require("./crawl")
// MySQL 連接物件
let mysqlConnection

/**
 * 初始化 MySQL 連接並升級 articles 表 + 建立 comments 表（修復：檢查欄位存在再 ADD）
 */
async function initDatabase() {
  try {
    console.log("嘗試連接 MySQL...");
    mysqlConnection = await mysql.createConnection(config.mysql);

    // 升級 articles 表：檢查並新增 content, createdAt, updatedAt 欄位
    const columnsToAdd = [
      { name: "content", type: "TEXT" },
      { name: "createdAt", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
      {
        name: "updatedAt",
        type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
      },
      { name: "postTime", type: "DATETIME" },
      { name: "ip", type: "VARCHAR(50)" },
    ];

    for (const col of columnsToAdd) {
      const [checkRow] = await mysqlConnection.execute(
        `
                SELECT COUNT(*) as colCount 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_SCHEMA = ? 
                AND TABLE_NAME = 'articles' 
                AND COLUMN_NAME = ?
            `,
        [config.mysql.database, col.name]
      );

      if (checkRow[0].colCount === 0) {
        await mysqlConnection.execute(
          `ALTER TABLE articles ADD COLUMN ${col.name} ${col.type}`
        )
        console.log(`✅ 新增欄位: ${col.name}`)
      } else {
        console.log(`⏭️ 欄位已存在: ${col.name}`)
      }
    }

    // 建立 comments 表
    await mysqlConnection.execute(`
            CREATE TABLE IF NOT EXISTS comments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                articleId INT NOT NULL,
                comment TEXT NOT NULL,
                userId VARCHAR(50),
                ip VARCHAR(50),
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

                UNIQUE KEY unique_comment (articleId, userId, comment(200)),
                FOREIGN KEY (articleId) REFERENCES articles(id) ON DELETE CASCADE
            )
        `)

    console.log(`✅ MySQL 初始化完成：資料庫 ${config.mysql.database}`)
  } catch (err) {
    console.error("❌ MySQL 初始化錯誤:", err.message)
    process.exit(1)
  }
}

/**
 * 從 DB 抓取一批 articles 的 link 和 id
 */
async function fetchLinksFromDB() {
  try {
    if (!mysqlConnection) {
      throw new Error("MySQL 未初始化")
    }

    const [rows] = await mysqlConnection.execute(`
            SELECT id, link FROM articles 
            WHERE content IS NULL OR content = ''
            LIMIT ${config.maxLinks}
        `)

    console.log(`從 DB 抓取一批 ${rows.length} 個 link`)
    return rows
  } catch (err) {
    console.error("抓取 link 錯誤:", err.message)
    return []
  }
}

/**
 * 爬取單篇文章內容和推文，並存入 articles 和 comments（新增：IP 提取）
 * @param {number} articleId - 文章 ID
 * @param {string} link - 文章 URL
 */
async function crawlContentAndComments(articleId, link) {
  console.log(`正在爬取文章 ${articleId} 內容: ${link}`)
  try {
    const response = await axios.get(link, {
      headers: config.headers,
      timeout: 10000,
    })

    if (response.status !== 200) {
      console.error(`文章 ${articleId} 請求失敗: ${response.status}`)
      await mysqlConnection.execute(
        `UPDATE articles SET content = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
        ["x", articleId]
      )
      return
    }

    const $ = cheerio.load(response.data)

    // 轉換 postTimeStr 為 UTC+0 (GMT) DATETIME 格式
    let formattedPostTime = null
    const timestampMatch = link.match(/M\.(\d+)\./)
    if (timestampMatch) {
      const unixTimestamp = parseInt(timestampMatch[1], 10) * 1000; // PTT timestamp 是秒，轉毫秒
      const dt = new Date(unixTimestamp);
      if (!isNaN(dt.getTime())) {
        // 轉為 UTC+0 DATETIME
        formattedPostTime = dt.toISOString().slice(0, 19).replace("T", " ")
      }
    }

    // 新增：提取文章 IP（從 From: 行）
    let articleIp = "";
    const fromMatch = response.data.match(
      /:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/
    )
    if (fromMatch) {
      articleIp = fromMatch[1]
    } else {
      await mysqlConnection.execute(
        `UPDATE articles SET content = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
        ["x", articleId]
      )
      return
    }

    // 提取正文（排除所有 .article-metaline）
    let content
    const bbsContent = $(".bbs-screen.bbs-content")
    if (bbsContent.length > 0) {
      // 複製元素，移除 metaline 和 push
      const contentClone = bbsContent.clone()
      contentClone.find(".article-metaline").remove() // 排除 metaline
      contentClone.find(".article-metaline-right").remove() // 排除 metaline-right
      contentClone.find(".push").remove(); // 排除推文
      content = contentClone.text().trim() || "x"
    }
    // 清理多餘空白
    content = content.replace(/\s+/g, " ").trim()

    // 提取推文：每個 .push 元素（新增 IP 提取）
    const comments = []
    $(".push").each((i, el) => {
      const $push = $(el)
      const pushText = $push.text().trim()
      const userId = $push.find(".push-userid").text().trim() // 新增：推文者 ID
      const comment = $push.find(".push-content").text().trim() // 推文內容
      if (comment && comment.length > 0) {
        // 提取推文 IP（從行尾匹配）
        const ipMatch = pushText.match(/(\d+\.\d+\.\d+\.\d+)/)
        const pushIp = ipMatch ? ipMatch[1] : ""
        comments.push({ userId, comment, ip: pushIp })
      }
    })

    // 更新 articles 表：content, postTime, ip, createdAt, updatedAt
    await mysqlConnection.execute(
      `UPDATE articles SET content = ?, postTime = ?, ip = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
      [content, formattedPostTime, articleIp, articleId]
    )

    // 單獨 INSERT 每個推文（含 IP）
    if (comments.length > 0) {
      for (const { userId, comment, ip } of comments) {
        await mysqlConnection.execute(
          `INSERT IGNORE INTO comments (articleId, userId, comment, ip) 
                     VALUES (?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE updatedAt = CURRENT_TIMESTAMP`,
          [articleId, userId, comment, ip]
        );
      }
      console.log(`  插入 ${comments.length} 則推文(重複已忽略)`)
    }

    console.log(
      `✅ 文章 ${articleId} 處理完成: ${
        content.length > 50 ? content.substring(0, 50) + "..." : content
      } | 發文時間 (UTC+0): ${formattedPostTime || "無"} | IP: ${
        articleIp || "無"
      }`
    )

    // 延遲避免 ban
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
  } catch (err) {
    await mysqlConnection.execute(
      `UPDATE articles SET content = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
      ["x", articleId]
    );
    console.error(`文章 ${articleId} 爬取錯誤: ${err.message}`)
  }
}

/**
 * 主函式：批次抓取 link 並處理內容
 */
async function main() {
  console.log("開始批次處理文章內容和推文...")

  try {
    await initDatabase(); // 初始化 MySQL

    let batchCount = 0;
    while (true) {
      // 抓取一批 link
      const links = await fetchLinksFromDB();
      if (links.length === 0) {
        console.log("無需處理的文章（所有內容已爬取）。")
        break
      }

      batchCount++;
      console.log(
        `\n=== 處理第 ${batchCount} 批次 (${links.length} 個文章) ===`
      )

      // 逐一處理批次內文章
      for (const { id, link } of links) {
        await crawlContentAndComments(id, link);
      }

      console.log(`第 ${batchCount} 批次完成\n`);
    }

    console.log(`✅ 所有批次處理完成！總批次: ${batchCount}`);
  } catch (error) {
    console.error("❌ 整體處理錯誤:", error.message);
  } finally {
    if (mysqlConnection) {
      await mysqlConnection.end();
      console.log("MySQL 連接已關閉");
    }
  }
}

// 執行主函式
// main()

schedule.scheduleJob('* * * * *', () => {
    console.log('每分鐘任務:', new Date().toISOString())
    crawlNewPosts()
})