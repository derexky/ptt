// test-crawl-ai.js
require('dotenv').config()
const { crawlNewPosts } = require('./crawl')
const { aiFilter, keywordFilter } = require('./filter')
const mysql = require('mysql2/promise')
const config = require('./config')

async function main() {
  // 1. 抓最新 2 頁
  console.log('=== Step 1: Crawl ===')
  await crawlNewPosts(2, 'Gossiping')

  // 2. 從 DB 拿文章
  console.log('\n=== Step 2: Load from DB ===')
  const conn = await mysql.createConnection(config.mysql)
  const [articles] = await conn.execute(
    `SELECT id, title, link FROM articles WHERE link LIKE ? ORDER BY id DESC LIMIT 30`,
    [`%/bbs/Gossiping/%`]
  )
  await conn.end()
  console.log(`DB returned ${articles.length} articles`)
  articles.slice(0, 5).forEach(a => console.log(' -', a.title))

  // 3. Keyword filter
  console.log('\n=== Step 3: Keyword Filter ===')
  const keywords = ['問卦', '新聞', 'Re']
  const keyFiltered = keywordFilter(articles, keywords)
  console.log(`After keyword filter: ${keyFiltered.length} articles`)

  // 4. AI filter
  console.log('\n=== Step 4: AI Filter ===')
  const aiPrompt = '請選出政治相關且討論熱度高的文章'
  const selected = await aiFilter(keyFiltered.slice(0, 10), aiPrompt)
  console.log(`AI selected ${selected.length} articles:`)
  selected.forEach(a => console.log(' ✅', a.title))
}

main().catch(console.error)
