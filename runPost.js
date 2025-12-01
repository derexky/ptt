require('dotenv').config()
const { Poster } = require('./poster')
const {readFile} = require('./helper')
const aliasMap = {
  b: 'board',
  s: 'subject',
  r: 'reply',
  p: 'path',
  t: 'target',
  k: 'kind',
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

const isNewPost = !!args.subject

const id = process.env.PTT_ID || 'your_ptt_id'
const password = process.env.PTT_PASSWORD || 'your_ptt_password'
const isSendByWord = true

async function runPost() {
  const controller = new Poster(id, password)
  const draft = isNewPost && args.path ? readFile(args.path) : null
  const _ = controller
      .postArticle({
        board: args.board,
        title: isNewPost ? args.subject : null,
        articleNumber: isNewPost ? null : args.reply,
        stance: args.stance,
        target: args.target,
        isSendByWord,
        draft,
      })
      .catch((err) => {
        // 捕獲並記錄背景發文的最終錯誤
        logger.error(`Background posting failed:`, err.message)
      })
  try {
    const result = await controller.contentReady
    console.log("Content Result:", result.content)
    await controller.continueState()
  } catch (error) {
    console.error("Controller Error:", error.message) 
  }
}

runPost() 