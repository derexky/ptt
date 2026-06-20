require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')
const { Poster } = require('./posterWS')
const { readFile } = require('./helper')
const aliasMap = {
  b: 'board',
  s: 'subject',
  r: 'reply',
  a: 'aid',
  p: 'path',
  t: 'target',
  k: 'kind',
  c: 'category',
  i: 'id',
  w: 'password',
  x: 'proxy',
}

const rawArgs = process.argv.slice(2)
const args = {}

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]

  if (arg.startsWith('--')) {
    // 長參數，如 --board
    const key = arg.slice(2)
    const value = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[i + 1] : true
    args[key] = value;
  } else if (arg.startsWith('-')) {
    // 短參數，如 -b
    const shortKey = arg.slice(1)
    const key = aliasMap[shortKey]
    if (key) {
      const value = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[i + 1] : true
      args[key] = value
    }
  }
}

// 檢查必要參數
if (!args.board) {
  console.error('❌ 缺少必要參數: --board <看板名稱>')
  console.error('用法:')
  console.error('  新文章: node runPost.js --board Gossiping --subject "標題" --content ./content')
  console.error('  回文:   node runPost.js --board Gossiping --reply 123456 --target ABCD')
  process.exit(1)
}

const isNeedBackup = process.env.NODE_ENV === 'develop'
const isDryRun = !!args['dry-run']

const isNewPost = !!args.subject

const isSendByWord = true

async function resolveCredentials() {
  const id = args.id || process.env.PTT_ID
  const password = args.password || process.env.PTT_PASSWORD
  if (!id || !password) {
    console.error('❌ 缺少帳號密碼：請用 --id / --password 或設定 PTT_ID / PTT_PASSWORD 環境變數')
    process.exit(1)
  }

  // --proxy 或 PTT_PROXY 優先；否則從 DB 查 bots 關聯的 proxy
  let proxyUrl = args.proxy || process.env.PTT_PROXY || null
  if (!proxyUrl) {
    let conn
    try {
      conn = await mysql.createConnection(config.mysql)
      const [rows] = await conn.execute(
        `SELECT p.host, p.port, p.username, p.password
         FROM bots b
         JOIN proxies p ON p.id = b.proxy_id AND p.is_active = TRUE
         WHERE b.ptt_id = ? AND b.is_active = TRUE
         LIMIT 1`,
        [id]
      )
      if (rows.length > 0) {
        const { host, port, username, password: pw } = rows[0]
        proxyUrl = `http://${username}:${pw}@${host}:${port}`
        console.log(`[DB] 使用 proxy: ${host}:${port}`)
      }
    } catch (e) {
      console.warn(`[DB] 查詢 proxy 失敗，直連：${e.message}`)
    } finally {
      if (conn) await conn.end()
    }
  }

  return { id, password, proxyUrl }
}

async function runPost() {
  const { id, password, proxyUrl } = await resolveCredentials()
  const controller = new Poster(id, password)
  const draft = isNewPost && args.path ? readFile(args.path) : null

  const _ = controller
      .postArticle({
        board: args.board,
        title: isNewPost ? args.subject : null,
        category: isNewPost ? Number(args.category) : 0,
        aid: isNewPost ? null : (args.aid ? String(args.aid).replace(/^#/, '') : (args.reply ? String(args.reply).replace(/^#/, '') : null)),
        stance: args.stance,
        target: args.target,
        isSendByWord,
        draft,
        isNeedBackup,
        dryRun: isDryRun,
        proxyUrl,
      })
      .catch((err) => {
        // 捕獲並記錄背景發文的最終錯誤
        logger.error(`Background posting failed:`, err.message)
      })
  try {
    const result = await controller.contentReady
    console.log("Content Result:", result.content)
    controller.continueState()
  } catch (error) {
    console.error("Controller Error:", error.message) 
  }
}

runPost() 