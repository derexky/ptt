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
    const hosts = proxies.map(p => p.proxy_address)
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
        'SELECT id FROM proxies WHERE host = ?', [host]
      )
      if (rows.length > 0) {
        await conn.execute(
          'UPDATE proxies SET port=?, username=?, password=?, is_active=TRUE WHERE host=?',
          [port, username, password, host]
        )
        updated++
      } else {
        await conn.execute(
          'INSERT INTO proxies (host, port, username, password, label, is_active) VALUES (?,?,?,?,?,TRUE)',
          [host, port, username, password, label]
        )
        inserted++
      }
    }

    // 停用不在 API 清單中的 webshare proxy
    let deactivated = 0
    if (hosts.length > 0) {
      const placeholders = hosts.map(() => '?').join(',')
      const [result] = await conn.execute(
        `UPDATE proxies SET is_active=FALSE WHERE label LIKE 'webshare_%' AND host NOT IN (${placeholders})`,
        hosts
      )
      deactivated = result.affectedRows
    }

    const [rows] = await conn.execute('SELECT id, host, port, label, is_active FROM proxies ORDER BY id')
    console.log(`\n✅ 更新 ${updated} 筆，新增 ${inserted} 筆，停用 ${deactivated} 筆`)
    console.table(rows)
  } finally {
    await conn.end()
  }
}

module.exports = { refresh }
if (require.main === module) {
  refresh().catch(err => { console.error('❌', err.message); process.exit(1) })
}
