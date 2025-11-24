const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise"); // 新增：MySQL 模組（支援 Promise）
const config = require("./config");

// 物件定義後生成檔案路徑
config.statsFileName = path.join(__dirname, `${config.boardName}_stats.json`);

// MySQL 連接物件
let mysqlConnection;

/**
 * 初始化 MySQL 連接並建立表
 */
async function initDatabase() {
  try {
    console.log("嘗試連接 MySQL...");
    mysqlConnection = await mysql.createConnection(config.mysql);

    // 建立 articles 表
    await mysqlConnection.execute(`
        CREATE TABLE IF NOT EXISTS articles (
            id INT AUTO_INCREMENT PRIMARY KEY,
            push VARCHAR(50) NOT NULL,
            title TEXT NOT NULL,
            author VARCHAR(50) NOT NULL,
            date VARCHAR(20) NOT NULL,
            commentCounts INT NOT NULL DEFAULT 0,
            link VARCHAR(255) NOT NULL UNIQUE,
            INDEX idx_link (link)
        )
    `);

    // 建立 stats 表
    await mysqlConnection.execute(`
        CREATE TABLE IF NOT EXISTS stats (
            \`key\` VARCHAR(50) PRIMARY KEY,
            value TEXT
        )
    `);

    console.log(`✅ MySQL 初始化完成：資料庫 ${config.mysql.database}`);
  } catch (err) {
    console.error("❌ MySQL 初始化錯誤:", err.message);
    process.exit(1);
  }
}

/**
 * 將單篇文章插入 MySQL（避免重複）
 * @param {Object} article - 文章物件
 */
async function insertArticle(article) {
  try {
    if (!mysqlConnection) {
      console.error("❌ MySQL 未初始化");
      return false;
    }

    const sql = `
        INSERT INTO articles (push, title, author, date, link)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            push = VALUES(push),
            title = VALUES(title)`;
    const [result] = await mysqlConnection.execute(sql, [
      article.push,
      article.title,
      article.author,
      article.date,
      article.link,
    ]);
    // console.log(result)
    const isNew = result.insertId != 0 && result.affectedRows === 1;
    const isUpdated = result.affectedRows === 2;
    const isDuplicateNoChange =
      result.insertId === 0 && result.changedRows === 0;

    if (isNew) {
      console.log(
        `✅ 新增文章: ${article.title.substring(0, 20)}... (push: ${
          article.push
        })`
      );
    } else if (isUpdated) {
      console.log(
        `🔄 更新文章 push/title: ${article.title.substring(
          0,
          20
        )}... (新 push: ${article.push})`
      );
    } else if (isDuplicateNoChange) {
      // 這是最常見的結果，表示文章已存在，但推文數等未變動
      console.log(
        `⭕ 檢查無須更新: ${article.title.substring(0, 20)}... (push: ${
          article.push
        })`
      );
    } else {
      // 處理其他極端情況，雖然不常見
      console.log(
        `⚠️ 意外結果 (affectedRows: ${
          result.affectedRows
        }): ${article.title.substring(0, 20)}...`
      );
    }
    await crawlContentAndComments(result.insertId, article.link);
    return isNew || isUpdated;
  } catch (err) {
    console.error(`插入錯誤: ${err.message}`);
    return false;
  }
}

/**
 * 從 MySQL 計算統計資料
 */
async function computeStatsFromDB() {
  try {
    if (!mysqlConnection) {
      throw new Error("MySQL 未初始化");
    }

    const [totalRow] = await mysqlConnection.execute(`
            SELECT COUNT(*) as totalArticles, 
                   SUM(CASE WHEN push = '100+' THEN 100 
                            WHEN push = '爆' THEN 100 
                            ELSE CAST(REPLACE(push, '+', '') AS UNSIGNED) END) as totalPushes 
            FROM articles
        `);

    const totalArticles = totalRow[0].totalArticles;
    if (totalArticles === 0) {
      return { totalArticles: 0 };
    }

    const totalPushes = totalRow[0].totalPushes || 0;
    const avgPushes = totalPushes / totalArticles;

    const [pushRow] = await mysqlConnection.execute(`
            SELECT MAX(CASE WHEN push = '100+' THEN 100 
                            WHEN push = '爆' THEN 100 
                            ELSE CAST(REPLACE(push, '+', '') AS UNSIGNED) END) as maxPushes, 
                   MIN(CASE WHEN push = '100+' THEN 100 
                            WHEN push = '爆' THEN 100 
                            ELSE CAST(REPLACE(push, '+', '') AS UNSIGNED) END) as minPushes 
            FROM articles
        `);

    const [dateRows] = await mysqlConnection.execute(`
            SELECT date, COUNT(*) as count FROM articles GROUP BY date ORDER BY date
        `);
    const dateCounts = {};
    dateRows.forEach((r) => (dateCounts[r.date] = r.count));

    const [authorRows] = await mysqlConnection.execute(`
            SELECT author, COUNT(*) as count FROM articles GROUP BY author ORDER BY count DESC LIMIT 5
        `);
    const topAuthors = authorRows.map((r) => ({
      author: r.author,
      count: r.count,
    }));

    return {
      totalArticles,
      totalPushes,
      avgPushes: Math.round(avgPushes * 100) / 100,
      maxPushes: pushRow[0].maxPushes || 0,
      minPushes: pushRow[0].minPushes || 0,
      dateCounts,
      topAuthors,
    };
  } catch (err) {
    console.error("統計查詢錯誤:", err.message);
    throw err;
  }
}

/**
 * 產生單頁 URL
 */
function generateUrl(pageNum) {
  const pageSuffix = pageNum === undefined ? "" : pageNum;
  return `https://www.ptt.cc/bbs/${config.boardName}/index${pageSuffix}.html`;
}

/**
 * 偵測總頁數
 */
async function getTotalPages() {
  const url = generateUrl(); // 首頁
  console.log(`偵測總頁數：請求 ${url}...`)

  try {
    const response = await axios.get(url, {
      headers: config.headers,
      timeout: 10000,
    })

    if (response.status !== 200) {
      console.error("偵測總頁數失敗，狀態碼:", response.status);
      return config.endPage;
    }

    const $ = cheerio.load(response.data);

    // Debug：輸出導航連結
    const links = $(".btn-group-paging a");
    console.log("導航連結文字列表：");
    links.each((i, el) => {
      console.log(
        `  Link ${i}: "${$(el).text().trim()}" (href: ${
          $(el).attr("href") || "無"
        })`
      )
    })

    // 用 '上頁' 匹配
    const upperLink = $(".btn-group-paging a")
      .filter((i, el) => $(el).text().trim().includes("上頁"))
      .attr("href")

    if (!upperLink) {
      console.log("未找到包含「上頁」的連結，預設總頁為 1。");
      return 1
    }

    // 解析 href
    const match = upperLink.match(/index(\d+)\.html$/);
    const total = match ? parseInt(match[1], 10) : 1;

    console.log(
      `✅ 從最新頁偵測到總頁數：${total} (從 '上頁' href: ${upperLink})`
    );
    return total
  } catch (error) {
    console.error("偵測總頁數錯誤:", error.message);
    return config.endPage
  }
}

/**
 * 爬取單一頁面
 */
async function crawlSinglePage(pageNum) {
  const url = generateUrl(pageNum)
  console.log(`正在爬取第 ${pageNum ? pageNum : "首"} 頁 (URL: ${url})`)

  try {
    const response = await axios.get(url, {
      headers: config.headers,
      timeout: 10000,
    });

    if (response.status !== 200) {
      console.error(`第 ${pageNum} 頁請求失敗，狀態碼: ${response.status}`)
      return []
    }

    const $ = cheerio.load(response.data)
    const posts = $(".r-ent");
    const articleList = [];

    // 改用 for...of + await 確保插入順序
    for (let index = 0; index < posts.length; index++) {
      const $element = $(posts[index])

      if (
        $element.find(".title a").length === 0 ||
        $element.find(".mark").text().trim() === "公告"
      ) {
        continue;
      }

      const title = $element.find(".title a").text().trim()
      const author = $element.find(".author").text().trim()
      const date = $element.find(".date").text().trim()
      let push = $element.find(".nrec").text().trim()

      if (push === "爆") {
        push = "100+"
      } else if (push === "") {
        push = "0"
      }

      const link = $element.find(".title a").attr("href")
      if (!link) continue

      const article = {
        title,
        author,
        date,
        push,
        link: `https://www.ptt.cc${link}`,
      }

      // 插入 DB
      await insertArticle(article)
      articleList.push(article)
    }

    console.log(
      `第 ${pageNum} 頁完成，抓到 ${articleList.length} 篇文章（已插入 DB）。`
    );
    return articleList
  } catch (error) {
    console.error(`第 ${pageNum} 頁爬取錯誤: ${error.message}`)
    return []
  }
}

/**
 * 爬取 PTT 看板並儲存到 MySQL
 */
async function crawlAllPosts() {
  console.log(`開始爬取 PTT 看板：${config.boardName}...`)

  try {
    await initDatabase() // 初始化 MySQL

    // 等待連接穩定
    await new Promise((resolve) => setTimeout(resolve, 500))

    config.endPage = await getTotalPages()

    console.log(
      `設定爬取範圍：第 ${config.startPage} 至 ${config.endPage} 頁...`
    )

    let allArticles = [];
    for (let page = config.startPage; page <= config.endPage; page++) {
      const articles = await crawlSinglePage(page)
      allArticles = allArticles.concat(articles)

      if (page < config.endPage) {
        console.log(`等待 ${config.delayMs / 1000} 秒...`)
        await new Promise((resolve) => setTimeout(resolve, config.delayMs))
      }
    }

    if (allArticles.length === 0) {
      console.error("❌ 未抓到任何文章，請檢查設定或網路。")
      return
    }

    const stats = await computeStatsFromDB()

    fs.writeFileSync(config.statsFileName, JSON.stringify(stats, null, 2), {
      encoding: "utf8",
    });

    console.log("---------------------------------");
    console.log(
      `✅ 爬取完成！總共抓到 ${stats.totalArticles} 篇文章（總頁數 ${config.endPage}）。`
    );
    console.log(`資料已儲存至 MySQL: ${config.mysql.database}`)
    console.log(`統計已儲存至: ${config.statsFileName}`)
    console.log("\n=== 統計摘要 ===")
    console.log(`總推文數: ${stats.totalPushes}`)
    console.log(`平均推文數: ${stats.avgPushes}`)
    console.log(`最高推文數: ${stats.maxPushes}`)
    console.log(`最低推文數: ${stats.minPushes}`)
    console.log(`前 5 名活躍作者:`, stats.topAuthors)
    console.log(`按日期文章數:`, stats.dateCounts)
  } catch (error) {
    console.error("❌ 整體爬取錯誤:", error.message)
  } finally {
    if (mysqlConnection) {
      await mysqlConnection.end()
      console.log("MySQL 連接已關閉")
    }
  }

  console.log("---------------------------------");
}

const getArticle = async (link) => {
  try {
    const response = await axios.get(link, {
      headers: config.headers,
      timeout: 10000,
    })
    if (response.status !== 200) throw ""
    const { formattedPostTime } = parseLink(link)
    const { articleIp, content, comments } = parseArticle(response.data)
    return { formattedPostTime, articleIp, content, comments }
  } catch (e) {
    console.error("❌ 爬取文章失敗", e)
  }
}
const parseLink = (link) => {
  // 轉換 postTimeStr 為 UTC+0 (GMT) DATETIME 格式
  let formattedPostTime = null
  const timestampMatch = link.match(/M\.(\d+)\./);
  if (timestampMatch) {
    const unixTimestamp = parseInt(timestampMatch[1], 10) * 1000 // PTT timestamp 是秒，轉毫秒
    const dt = new Date(unixTimestamp)
    if (!isNaN(dt.getTime())) {
      // 轉為 UTC+0 DATETIME
      formattedPostTime = dt.toISOString().slice(0, 19).replace("T", " ")
    }
  }
  return { formattedPostTime }
}
const parseArticle = (data) => {
  try {
    const $ = cheerio.load(data)

    // 新增：提取文章 IP（從 From: 行）
    let articleIp = ""
    const fromMatch = data.match(/:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (fromMatch) {
      articleIp = fromMatch[1]
    }

    // 提取正文（排除所有 .article-metaline）
    let content;
    const bbsContent = $(".bbs-screen.bbs-content")
    if (bbsContent.length > 0) {
      // 複製元素，移除 metaline 和 push
      const contentClone = bbsContent.clone()
      contentClone.find(".article-metaline").remove() // 排除 metaline
      contentClone.find(".article-metaline-right").remove() // 排除 metaline-right
      contentClone.find(".push").remove(); // 排除推文
      contentClone.find(".f6").remove(); // 排除回應的前文內容
      content = contentClone.text().trim() || "x"
    }
    // 清理多餘空白
    content = content.replace(/\s+/g, " ").trim()

    // 提取推文：每個 .push 元素（新增 IP 提取）
    const comments = [];
    $(".push").each((i, el) => {
      const $push = $(el);
      const userId = $push.find(".push-userid").text().trim(); // 新增：推文者 ID
      const comment = $push.find(".push-content").text().trim(); // 推文內容
      if (comment && comment.length > 0) {
        // 提取推文 IP（從行尾匹配
        const ipMatch = $push
          .find(".push-ipdatetime")
          .text()
          .match(/(\d+\.\d+\.\d+\.\d+)/);
        const pushIp = ipMatch ? ipMatch[1] : "";
        comments.push({ userId, comment, ip: pushIp });
      }
    });
    return { articleIp, content, comments };
  } catch (e) {
    throw `連結 ${link} 解析錯誤: ${e.message}`;
  }
}

async function crawlContentAndComments(articleId, link) {
  if (!articleId) return

  console.log(`正在爬取文章 ${articleId} 內容: ${link}`)
  try {
    const response = await axios.get(link, {
      headers: config.headers,
      timeout: 10000,
    });

    if (response.status !== 200) {
      console.error(`文章 ${articleId} 請求失敗: ${response.status}`)
      await mysqlConnection.execute(
        `UPDATE articles SET content = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
        ["x", articleId]
      );
      return
    }
    const { formattedPostTime } = parseLink(link);
    const { articleIp, content, comments } = parseArticle(response.data)

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
      console.log(`  插入 ${comments.length} 則推文(重複已忽略)`);
    }

    console.log(
      `✅ 文章 ${articleId} 處理完成: ${
        content.length > 50 ? content.substring(0, 50) + "..." : content
      } | 發文時間 (UTC+0): ${formattedPostTime || "無"} | IP: ${
        articleIp || "無"
      }`
    )

    // 延遲避免 ban
    await new Promise((resolve) => setTimeout(resolve, config.delayMs))
  } catch (err) {
    await mysqlConnection.execute(
      `UPDATE articles SET content = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
      ["x", articleId]
    )
    console.error(`文章 ${articleId} 爬取錯誤: ${err.message}`)
  }
}

async function crawlNewPosts(lastestPageCount = 10) {
  console.log(`開始爬取 PTT 看板：${config.boardName}...`);

  try {
    await initDatabase()

    // 等待連接穩定
    await new Promise((resolve) => setTimeout(resolve, 500));

    config.endPage = await getTotalPages();

    console.log(`設定爬取範圍：最新 ${lastestPageCount} 頁`);
    let allArticles = [];
    for (let index = 0; index <= lastestPageCount; index++) {
      const page = index === 0 ? undefined : config.endPage - index;
      const articles = await crawlSinglePage(page);
      allArticles = allArticles.concat(articles);

      if (page < config.endPage) {
        console.log(`等待 ${config.delayMs / 1000} 秒...`);
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
    }

    if (allArticles.length === 0) {
      console.error("❌ 未抓到任何文章，請檢查設定或網路。");
      return
    }
  } catch (error) {
    console.error("❌ 整體爬取錯誤:", error.message);
  } finally {
    if (mysqlConnection) {
      await mysqlConnection.end()
      console.log("MySQL 連接已關閉")
    }
  }

  console.log("---------------------------------");
}

module.exports = {
  getArticle,
  crawlNewPosts,
  crawlAllPosts,
}
