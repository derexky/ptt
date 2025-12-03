// ptt-controller.js

const { Client } = require('ssh2')
const readline = require('readline') // 引入 readline 用於進度條
const { generateContentByGoogle } = require('./ai')
const {
  devideParagraph,
  writeFile,
  readFile,
  getRandomInt,
} = require('./helper')

const isDev = process.env.NODE_ENV === 'develop'

const status = {
  init: 0,
  login: 1,
  mainMenu: 3,
  searchBoard: 4,
  searchArticle: 8,
  atArticleTitle: 5,
  onBoard: 6,
  pause: 7,
  writeQuit: 10,
  newPost: 11,
  startPost: 12,
  posting: 13,
  readArticle: 14,
  respPost: 15,
  postDone: 16,

  end: 99,
}

// 注意：board 關鍵字會動態產生
const keywordMap = {
  account: '請輸入代號',
  password: '請輸入您的密碼',
  deleteLink: '刪除其他重複登入的連線',
  welcome: '請按任意鍵繼續',
  mainMenu: '主功能表',
  searchBoard: '請輸入看板名稱',
  overload: '請勿頻繁登入以免造成系統過度負荷',
  writeQuit: '您有一篇文章尚未完成，',
  postType: '種類：',
  postTitle: '標題：',
  reTitle: '採用原標題',
  reContent: '引用原文嗎',
  author: '作者',
  title: '標題',
  time: '時間',
  board: '看板',
  site: '發信站:',
  articleLink: '文章網址:',
  read: '瀏覽',

  input_ctl_x: '\x18\r\n', // Ctrl + X
  input_Save: 'S\r\n', // 選擇發表 (S)
  input_Yes: 'Y\r\n', // 確認 (Y)
  input_No: 'N\r\n',
  input_Quit: 'Q\r\n', // 結束編輯 (Q)
  input_enter: '\r\n',
  input_down: '\x1b[B', // 向下鍵
  input_right: '\x1b[C', // 向右鍵
  input_search: 's',
  input_post: '\x10', // Ctrl + P
  input_resp: 'r\r\n',
  input_1: '1\r\n',
}
// --- 狀態與關鍵字定義結束 ---

class Poster {
  constructor(id, password) {
    this.id = id
    this.password = password
    this.conn = null
    this.stream = null
    this.currentState = status.init
    this.buffer = ''
    this.isProcessing = false
    this.postContent = ''
    this.isSendByWord = true

    this.abortSignal = false
    this.aiContent = null

    this.retryCount = 0

    this.contentReady = new Promise((resolve, reject) => {
      this._contentReadyResolve = resolve // 儲存 resolve 函式
      this._contentReadyReject = reject
    })
    this.finalResolve = null // 最終 Promise 的 resolve
    this.finalReject = null

    // 任務參數
    this.board = null
    this.title = null
    this.aid = null
    this.draft = null
    this.target = null
    this.stance = null
    this.isNeedBackup = false
  }

  continueState = () => {
    if (this.stream) {
      console.log('\n[Auto] Resuming PTT process...')
      const isNewPost = !this.aid
      this.currentState = isNewPost ? status.newPost : status.respPost
      this.isProcessing = false
      const input = isNewPost ? keywordMap.input_post : keywordMap.input_resp
      this.stream.write(input)
    }
  }

  abort = () => {
    this.abortSignal = true
    if (this.conn) {
      console.log('\n[Auto] Aborting connection...')
      this.conn.end() // 強制終止 SSH 連線
    }
  }
  /**
   * 輔助函式：延遲寫入
   */
  delayWrite = (text, delay = 500) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.stream.write(text)
        resolve()
      }, delay)
    })
  }

  /**
   * PTT 發文流程結束
   */
  finishPost = async () => {
    // 發送完畢後，結束編輯：Ctrl + X (\x18)
    this.currentState = status.postDone
    await this.delayWrite(keywordMap.input_ctl_x)
    await this.delayWrite(keywordMap.input_Save)
  }

  /**
   * 處理發文進度條 (使用 readline 確保在同一行)
   */
  updatePostingProgress = (current, total, type) => {
    const progress = Math.round((current / total) * 100)
    // 使用 \r 確保在同一行
    const output = `\r[Auto] Posting (${type}) Progress: ${progress}% (${current}/${total})`
    if (isDev) {
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(output)

      if (current === total) {
        process.stdout.write('\n')
      }
    } else {
      console.log(`[Auto] Posting (${type}) Progress: ${progress}% (${current}/${total})`)
    }
  }

  /**
   * 逐字發文 (帶進度條)
   */
  postEachWord = async () => {
    // 將內容處理為單一字串：替換 \n 為 \r\n，\t 為空格
    let fullContent = this.postContent
      .replace(/\n/g, '\r\n')
      .replace(/\t/g, ' ')
    let idx = 0
    const sendCharBatch = (batchSize = 2) => {
      const rndDelay = getRandomInt(1000, 1100)

      return new Promise((resolve) => {
        if (idx < fullContent.length) {
          // 計算這次要發送的範圍，避免超出陣列長度
          const end = Math.min(idx + batchSize, fullContent.length)
          const batch = fullContent.slice(idx, end)

          this.updatePostingProgress(end, fullContent.length, 'Char')

          this.stream.write(batch)

          idx = end

          setTimeout(() => resolve(false), rndDelay)
        } else {
          resolve(true) // 已全部發送完畢
        }
      })
    }
  
    const sendSize = isDev ? 1 : Math.ceil(fullContent.length / 500) // functions上的存活時間大約500次(每秒一次)發送完畢
    let done = false
    while (!done) {
      done = await sendCharBatch(sendSize)
    }

    await this.finishPost()
  }

  /**
   * 逐行發文 (帶進度條)
   */
  postEachLine = async () => {
    const lines = this.postContent.split('\n')
    let idx = 0

    const sendLine = () => {
      const rndDelay = getRandomInt(1000, 1200)
      return new Promise((resolve) => {
        if (idx < lines.length) {
          this.updatePostingProgress(idx, lines.length, 'Line')
          const line = lines[idx].replace(/\t/g, ' ')
          this.stream.write(line + keywordMap.input_enter)
          idx++
          setTimeout(() => resolve(false), rndDelay)
        } else {
          resolve(true)
        }
      })
    }

    let done = false
    while (!done) {
      done = await sendLine()
    }

    await this.finishPost()
  }

  /**
   * 強制分行函式 (維持原有換行，並對超長行進行斷行)
   */
  insertNewlinesPreservingExisting = (content, lengthPerLine = 60) => {
    if (!content) return ''

    let normalizedContent = content.replace(/\r\n/g, '\n')
    const paragraphs = normalizedContent.split('\n')
    const formattedParagraphs = paragraphs.map((paragraph) => {
      let cleanParagraph = paragraph.trim()

      if (cleanParagraph.length === 0) {
        return ''
      }

      if (cleanParagraph.length > lengthPerLine) {
        const regex = new RegExp(`(.{1,${lengthPerLine}})`, 'g')
        return cleanParagraph.replace(regex, '$1\n').trim()
      } else {
        return cleanParagraph
      }
    })

    return formattedParagraphs.join('\n')
  }

  /**
   * PTT 內容提取函式 (修正版)
   */
  extractPttContent = (rawContent) => {
    // 1. 處理換行符號，將所有可能的換行轉為 \n，並移除 \r
    let cleanedContent = rawContent.replace(/\r/g, '')

    // 2. 移除 ANSI 顏色/游標控制碼 ([\d*(;\d+)*[A-Za-zKmlH])
    // 匹配：[ 後面跟著數字、分號、或字母的序列 (例如：[34;47m, [H, [K)
    // 移除所有控制碼及其可能前後的單一空格
    cleanedContent = cleanedContent.replace(
      / ?\[\d{0,3}(?:;\d{1,3})*[A-Za-zKmlH] ?/g,
      ''
    )

    // 3. 移除行首的來源標籤 (如果檔案中存在)
    cleanedContent = cleanedContent.replace(/^\\s*/gm, '')

    // 4. 按行處理，去除標頭和標尾
    const lines = cleanedContent.split('\n')
    const contentLines = []
    let inContentArea = false
    let isHeader = true
    let emptyLineCount = 0

    for (const line of lines) {
      // 去除行首和行尾空白
      const trimmedLine = line.trim()

      // 判斷是否為標頭關鍵字
      if (
        trimmedLine.startsWith(keywordMap.author) ||
        trimmedLine.startsWith(keywordMap.title) ||
        trimmedLine.startsWith(keywordMap.time) ||
        trimmedLine.startsWith(keywordMap.board)
      ) {
        isHeader = true
        continue
      }

      // 判斷是否為邊界/分隔線 (例如 --- 或 ─ 组成的行)
      if (trimmedLine.match(/^-{1,}|^─+$/)) {
        isHeader = true
        continue
      }

      // 判斷是否為文章結尾資訊 (包含推文)
      if (
        trimmedLine.startsWith(keywordMap.site) ||
        trimmedLine.startsWith(keywordMap.articleLink) ||
        trimmedLine.startsWith(keywordMap.read) ||
        trimmedLine.startsWith('※') ||
        trimmedLine === '--' ||
        trimmedLine.match(/^(推|噓|→)\s/i) // 排除推文
      ) {
        // 遇到結尾，停止提取
        break
      }

      // 文章開始的判斷點: 遇到第一個非標頭、非分隔符的行
      if (isHeader && trimmedLine.length > 0) {
        inContentArea = true
        isHeader = false
      }

      if (inContentArea) {
        if (trimmedLine.length > 0) {
          contentLines.push(trimmedLine)
          emptyLineCount = 0
        } else if (emptyLineCount === 0) {
          // 保留一個空行作為段落分隔，忽略連續空行
          contentLines.push('')
          emptyLineCount++
        }
      }
    }

    // 5. 將所有行組合成最終內容
    return contentLines.join('\n').trim()
  }

  handleResolve = ({ text, link }) => {
     this.currentState = status.pause

     if (!text || !text.length) {
      this.conn.end()
      this.finalResolve({
        success: false,
        message: 'Content is empty.',
      })
      return
    }

    if (this._contentReadyResolve) {
      this._contentReadyResolve({
        message: 'Content ready, proceeding to post.',
        content: text,
        url: link,
      })
      this._contentReadyResolve = null // 確保只呼叫一次
      console.log(`\n[Auto] Content ready, pausing task for index.js callback.`)
    }
  }

  getAiText = async (drift) => {
    const prompt = drift +
      '\r\n根據前述內容延伸並發表看法,\r\n回覆的文章不要包括上述內容的引文和推文,\r\n也不需要作者,看板,標題,時間的格式化部分'
    const isUseAI = this.stance || this.target
    let rawText = drift
    if(isUseAI) {
      const aiContent = await generateContentByGoogle({
        prompt,
        stance: this.stance,
        target: this.target,
      })
      rawText = aiContent
    }

    return devideParagraph(rawText)
  }

  /**
   * 核心狀態處理機
   */
  handleState = async (chunk, resolve, reject) => {
    // console.log(`[State${this.currentState}]${this.isProcessing} ${chunk}`)
    if (this.isProcessing) return

    this.isProcessing = true

    const previousState = this.currentState

    // 優先處理雜訊 (不受狀態影響)
    if (chunk.includes(keywordMap.welcome) || chunk.includes(keywordMap.overload)) {
      this.stream.write(keywordMap.input_down)
      this.buffer = ''
      this.isProcessing = false
      return
    }

    if (chunk.includes(keywordMap.writeQuit)) {
      console.log('\n[Auto] Quit board...')
      this.stream.write(keywordMap.input_Quit)
      this.buffer = ''
      this.isProcessing = false
      return
    }

    if (chunk.includes(keywordMap.deleteLink)) {
      console.log('\n[Auto] Delete link...')
      this.stream.write(keywordMap.input_Yes)
      this.buffer = ''
      this.isProcessing = false
      return
    }

    // --- 狀態機邏輯 ---
    switch (this.currentState) {
      case status.init:
        if (chunk.includes(keywordMap.account)) {
          console.log('\n[Auto] Sending ID...')
          this.currentState = status.login
          this.stream.write(this.id + keywordMap.input_enter)
        }
        break

      case status.login:
        if (chunk.includes(keywordMap.password)) {
          console.log('\n[Auto] Sending password...')
          this.currentState = status.mainMenu
          this.stream.write(this.password + keywordMap.input_enter) 
        }
        break

      case status.mainMenu:
        if (chunk.includes(keywordMap.mainMenu)) {
          console.log('\n[Auto] At main menu, entering board search...')
          this.currentState = status.searchBoard
          this.stream.write(keywordMap.input_search)         
        }
        break

      case status.searchBoard:
        if (chunk.includes(keywordMap.searchBoard)) {
          console.log('\n[Auto] Searching board...')
          this.currentState = status.onBoard
          this.stream.write(this.board + keywordMap.input_enter)
        }
        break

      case status.onBoard:
        if (chunk.toLowerCase().includes(`看板《${this.board.toLowerCase()}`)) {
          console.log('\n[Auto] On board, search/starting post...')
          const isNewPost = !this.aid // 檢查是否為新文章 (不是回文)
          if (isNewPost) {
            this.postContent = await this.getAiText(this.draft)
            this.handleResolve({ text: this.postContent })
          } else {
            this.currentState = status.searchArticle
            this.stream.write('#')
          }
        }
        break
      case status.searchArticle:
        this.currentState = status.atArticleTitle
        this.stream.write(
          `${this.aid}`+ keywordMap.input_enter
        )
        break
      case status.atArticleTitle:
        console.log('\n[Auto] At title, entering article...')
        this.currentState = status.readArticle
        this.stream.write(keywordMap.input_right) // 向右鍵
        break

      case status.readArticle:
        console.log(`\n[Auto] Read article, ${chunk}`)
       
        if (!chunk.toLowerCase().includes(`看板《${this.board.toLowerCase()}`)) {
          this.buffer += chunk
        }

        const match = chunk.match(
          /文章網址\s*:\s*(https?:\/\/www\.ptt\.cc\/bbs\/[^\/]+\/M\.\d+\.[A-Z]\.\w+\.html)/i
        )
        if (match) {
          const link = match[1]
          console.log(`\n[Auto] Get link, ${link}...`)
        
          const rawContent = this.buffer
          const content = this.extractPttContent(rawContent)
          // writeFile(content)
          const article = { content } //await getArticle(link)

          if (article) {
            if (this.isNeedBackup)
              writeFile(
                article.content,
                `./backup/${this.board.toLowerCase()}-${this.aid}`
              )

            const backupPath = `./backup/RE:${this.board.toLowerCase()}-${
              this.aid
            }`
            const backupContent = readFile(backupPath)

            if (backupContent) {
              this.postContent = backupContent
            } else {
              this.postContent = await this.getAiText(article.content)

              if (this.isNeedBackup) writeFile(this.postContent, backupPath)
            }

            this.handleResolve({ text: this.postContent, link })

            return // 暫停執行 跳過最後的this.isProcessing = false
          }
        } else {
          console.log('-> Reading...')
          this.retryCount++
          if (this.retryCount >= 10) {
            console.error('\n[Auto] Failed to extract article link after retries.')
            throw new Error('Failed to extract article link.')
          }
          this.delayWrite(keywordMap.input_right)
        }
        break

      case status.respPost:
        // if (chunk.includes(keywordMap.reTitle)) {
          console.log(`\n[Auto] Run response process...`)
          this.stream.write(keywordMap.input_Yes) // 採用原標題
 
          // if (chunk.includes(keywordMap.reContent)) {
          await this.delayWrite(keywordMap.input_No) // 不引用原文
          this.currentState = status.startPost // 確認發送完畢後才切換狀態
        // }
        break

      case status.newPost:
        console.log('\n[Auto] Run new post process...')
        // 1. 選擇文章類型
        this.stream.write(keywordMap.input_1)
        // 2. 輸入標題
        await this.delayWrite(this.title + keywordMap.input_enter)
        this.currentState = status.startPost
        break

      case status.startPost:
        console.log('\n[Auto] Start post...')
        if (this.postContent.length) {
          this.postContent = this.insertNewlinesPreservingExisting(
            this.postContent
          )

          this.currentState = status.posting
          if (this.isSendByWord) {
            this.postEachWord()
          } else {
            this.postEachLine()
          }
        } else {
          console.log('\n[Auto] Content is empty, skipping post.')
          this.currentState = status.postDone
          this.stream.write(keywordMap.input_enter)
        }
        break

      case status.postDone:
        console.log('\n[Auto] Post done.')
        this.conn.end()
        this.currentState = status.end
        this.finalResolve({
          success: true,
          message: 'Article posted successfully.',
          aiContent: this.aiContent,
        })
        break

      default:
        break
    }
    // --- 狀態機邏輯結束 ---

    // 只有在狀態成功切換時才清空緩衝區
    if (this.currentState !== previousState) {
      this.buffer = ''
    }

    this.isProcessing = false
  }

  /**
   * Controller 主執行方法，負責建立連線並啟動狀態機
   * @param {object} options - 包含發文所需的所有參數
   * @returns {Promise<object>} - 包含執行結果的 Promise
   */
  postArticle = (options) => {
    const {
      board,
      title,
      aid,
      draft,
      target,
      stance,
      isSendByWord,
      isNeedBackup,
    } = options

    // 注入參數
    this.board = board
    this.title = title
    this.aid = aid
    this.draft = draft
    this.target = target
    this.stance = stance

    this.isSendByWord = !!isSendByWord
    this.isNeedBackup = !!isNeedBackup

    return new Promise((resolve, reject) => {
      this.conn = new Client()

      this.conn
        .on('ready', () => {
          console.log('Connected to PTT (UTF-8)')
          this.conn.shell(
            {
              pty: {
                term: 'vt100',
                cols: 80,
                rows: 24,
                width: 640,
                height: 480,
              },
            },
            (err, stream) => {
              if (err) return reject(new Error(`Shell error: ${err.message}`))

              this.stream = stream

              stream
                .on('close', () => {
                  console.log(`Stream closed.`)
                  this.conn.end()
                  if (this.currentState !== status.postDone) {
                    reject(
                      new Error(
                        'Connection closed unexpectedly before post done.'
                      )
                    )
                  }
                })
                .on('error', (err) => {
                  console.error('Stream error:', err.message)
                  reject(err)
                })
                .on('data', (data) => {
                  const chunk = data.toString('utf8')
                  this.handleState(chunk, resolve, reject)
                })
            }
          )
        })
        .on('error', (err) => {
          console.error('Connection error:', err)
          reject(err)
        })
        .connect({
          host: 'ptt.cc',
          port: 22,
          username: 'bbsu',
          keepAliveInterval: 60000,
          keepAliveCountMax: 10,
        })

      this.finalResolve = resolve
      this.finalReject = reject
    })
  }
}

module.exports = { Poster }
