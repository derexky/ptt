const axios = require("axios")
const mysql = require("mysql2/promise") // MySQL 模組（支援 Promise）
const config = require("./config")

// MySQL 連接物件
let mysqlConnection

/**
 * 初始化 MySQL 連接並升級 articles 表 + 建立 comments 表（修復：檢查欄位存在再 ADD）
 */
async function initDatabase() {
  try {
    console.log("嘗試連接 MySQL...");
    mysqlConnection = await mysql.createConnection(config.mysql);
    console.log(`✅ MySQL 初始化完成：資料庫 ${config.mysql.database}`);
  } catch (err) {
    console.error("❌ MySQL 初始化錯誤:", err.message);
    process.exit(1)
  }
}

/**
 * 從 DB 抓取一批 articles 的 link 和 id
 */
async function fetchLinksFromDB() {
  try {
    if (!mysqlConnection) {
      throw new Error("MySQL 未初始化");
    }

    const [rows] = await mysqlConnection.execute(`
            SELECT id, link FROM articles 
            WHERE content IS NULL OR content = 'x'
            LIMIT ${config.maxLinks}
        `)

    console.log(`從 DB 抓取一批 ${rows.length} 個 link`)
    return rows
  } catch (err) {
    console.error("抓取 link 錯誤:", err.message)
    return []
  }
}

async function modifyContent(articleId, link) {
  console.log(`正在爬取文章 ${articleId} 內容: ${link}`);
  try {
    const response = await axios.get(link, {
      headers: config.headers,
      timeout: 10000,
    })

    if (response.status !== 200) {
      console.error(`文章 ${articleId} 請求失敗: ${response.status}`);
      await mysqlConnection.execute(
        `
                UPDATE articles 
                SET content = '?'   
                WHERE id = ?
            `,
        [articleId]
      )
      return
    }
    await mysqlConnection.execute(
      `
            UPDATE articles 
            SET content = 'xxx'   
            WHERE id = ?
        `,
      [articleId]
    )
  } catch (err) {
    console.error(`文章 ${articleId} 爬取錯誤: ${err.message}`);
  }
}

async function modify() {
  console.log("開始批次處理文章內容和推文...");

  try {
    await initDatabase(); // 初始化 MySQL

    let batchCount = 0;
    while (true) {
      // 抓取一批 link
      const links = await fetchLinksFromDB();
      if (links.length === 0) {
        console.log("無需處理的文章（所有內容已爬取）。");
        break;
      }

      batchCount++
      console.log(
        `\n=== 處理第 ${batchCount} 批次 (${links.length} 個文章) ===`
      )

      // 逐一處理批次內文章
      for (const { id, link } of links) {
        await modifyContent(id, link)
      }

      console.log(`第 ${batchCount} 批次完成\n`)
    }

    console.log(`✅ 所有批次處理完成！總批次: ${batchCount}`)
  } catch (error) {
    console.error("❌ 整體處理錯誤:", error.message)
  } finally {
    if (mysqlConnection) {
      await mysqlConnection.end()
      console.log("MySQL 連接已關閉")
    }
  }
}

module.exports = {
  modify
}