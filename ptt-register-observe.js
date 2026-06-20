'use strict'
const { w3cwebsocket } = require('websocket')
const iconv = require('iconv-lite')

const ws = new w3cwebsocket(
  'wss://ws.ptt.cc/bbs',
  'bbs',
  'https://term.ptt.cc',
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  }
)

let allData = ''

const decode = (data) => {
  if (data instanceof Buffer) return iconv.decode(data, 'big5')
  if (data instanceof ArrayBuffer) return iconv.decode(Buffer.from(data), 'big5')
  return String(data)
}
const stripAnsi = (s) => s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '')
const send = (text, label) => {
  console.log(`\n>>> [${label}]`)
  ws.send(iconv.encode(text, 'big5'))
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

ws.onopen = async () => {
  console.log('[connected]\n')

  // 等待登入畫面載入
  await sleep(3000)
  send('new\r', 'step1: enter new')

  // 等 PTT 載入條款並翻過 6 頁 (每頁按 space)
  await sleep(2000)
  for (let i = 1; i <= 6; i++) {
    send(' ', `step2: terms page ${i}`)
    await sleep(1500)
  }

  // 第 6 頁後出現 (yes/no) 確認畫面，等待穩定後送 y
  await sleep(2000)
  send('y', 'step3: agree terms → y')
  await sleep(10000)
  // 如果沒有回應，按 Enter 觸發
  send('\r', 'step4: press enter after y')
  await sleep(5000)

  // 顯示此時畫面（應為申請帳號表單）
  const plain = stripAnsi(allData.slice(-4000))
  console.log('\n' + '='.repeat(60))
  console.log('[同意條款後的畫面（應為申請帳號表單）]:')
  console.log(plain.trim())
  console.log('='.repeat(60))
  ws.close()
}

ws.onmessage = (e) => {
  const text = decode(e.data)
  allData += text
  process.stdout.write(text)
}

ws.onerror = (err) => console.error('[ws error]', err.message || err)
ws.onclose = () => { console.log('\n[connection closed]'); process.exit(0) }

setTimeout(() => { console.log('\n[timeout 60s]'); ws.close() }, 60000)
