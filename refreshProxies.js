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

    // 將使用到停用 proxy 的 bot 重新分配給未被使用的活躍 proxy
    const [affectedBots] = await conn.execute(
      `SELECT b.id AS bot_id FROM bots b
       JOIN proxies p ON p.id = b.proxy_id
       WHERE p.is_active = FALSE`
    )
    let reassigned = 0
    if (affectedBots.length > 0) {
      const [unusedProxies] = await conn.execute(
        `SELECT p.id FROM proxies p
         WHERE p.is_active = TRUE
         AND p.id NOT IN (SELECT proxy_id FROM bots WHERE proxy_id IS NOT NULL AND is_active = TRUE)
         ORDER BY p.id`
      )
      for (const bot of affectedBots) {
        const proxy = unusedProxies.shift()
        if (!proxy) break
        await conn.execute('UPDATE bots SET proxy_id = ? WHERE id = ?', [proxy.id, bot.bot_id])
        reassigned++
      }
      const unhandled = affectedBots.length - reassigned
      if (unhandled > 0) {
        console.warn(`⚠️  ${unhandled} 個 bot 無可用 proxy 分配，仍指向停用的 proxy`)
      }
    }

    const [rows] = await conn.execute('SELECT id, host, port, label, is_active FROM proxies ORDER BY id')
    console.log(`\n✅ 更新 ${updated} 筆，新增 ${inserted} 筆，停用 ${deactivated} 筆，重新分配 bot ${reassigned} 個`)
    console.table(rows)
  } finally {
    await conn.end()
  }
}

module.exports = { refresh }
if (require.main === module) {
  refresh().catch(err => { console.error('❌', err.message); process.exit(1) })
}
