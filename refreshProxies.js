require('dotenv').config()
const https = require('https')
const mysql = require('mysql2/promise')
const config = require('./config')

const API_KEY = process.env.WEBSHARE_API_KEY
if (!API_KEY) {
  console.error('❌ 缺少 WEBSHARE_API_KEY，請在 .env 設定')
  process.exit(1)
}

function fetchProxies() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'proxy.webshare.io',
      path: '/api/v2/proxy/list/?mode=direct&page=1&page_size=25',
      headers: { Authorization: `Token ${API_KEY}` },
    }
    https.get(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (!json.results) return reject(new Error(data))
          resolve(json.results)
        } catch (e) {
          reject(new Error('API 回應解析失敗: ' + data.slice(0, 200)))
        }
      })
    }).on('error', reject)
  })
}

async function refresh() {
  const proxies = await fetchProxies()
  console.log(`API 回傳 ${proxies.length} 個 proxy`)

  const conn = await mysql.createConnection(config.mysql)
  try {
    let updated = 0
    let inserted = 0
    for (let i = 0; i < proxies.length; i++) {
      const p = proxies[i]
      const host = p.proxy_address
      const port = p.port
      const username = p.username
      const password = p.password
      const label = `webshare_${i + 1}`

      const [rows] = await conn.execute(
        'SELECT id FROM proxies WHERE label = ?', [label]
      )
      if (rows.length > 0) {
        await conn.execute(
          'UPDATE proxies SET host=?, port=?, username=?, password=? WHERE label=?',
          [host, port, username, password, label]
        )
        updated++
      } else {
        await conn.execute(
          'INSERT INTO proxies (host, port, username, password, label) VALUES (?,?,?,?,?)',
          [host, port, username, password, label]
        )
        inserted++
      }
    }

    const [rows] = await conn.execute('SELECT id, host, port, label FROM proxies ORDER BY id')
    console.log(`\n✅ 更新 ${updated} 筆，新增 ${inserted} 筆`)
    console.table(rows)
  } finally {
    await conn.end()
  }
}

refresh().catch(err => { console.error('❌', err.message); process.exit(1) })
