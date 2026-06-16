// ptt-controller.js
const fs = require('fs') // 假設您已引入
const readline = require('readline') // 引入 readline 用於進度條
const { w3cwebsocket } = require('websocket')
const iconv = require('iconv-lite')
const { generateContentByGoogle } = require('./ai') // 假設這是您的 AI 函式
const config = require('./config')
const {
  divideParagraph,
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
  onBoard: 5,
  searchArticle: 6,
  atArticleTitle: 7,
 
  pause: 8,
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
  searchArticle: '搜尋文章代碼(AID)',
  inArticle: '目前顯示: 第',
  overload: '請勿頻繁登入以免造成系統過度負荷',
  writeQuit: '您有一篇文章尚未完成，',
  onCategory: '種類：',
  onTitle: '標題：',
  reTitle: '採用原標題',
  reContent: '引用原文嗎',
  author: '作者',
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
  input_resp: 'y\r\n',
  input_1: '1\r\n',
}
// --- 狀態與關鍵字定義結束 ---

class Poster {
  constructor(id, password) {
    this.id = id
    this.password = password

    this.stream = null
    this.currentState = status.init
    this.buffer = ''
    this.isProcessing = false
    this.postContent = ''
    this.isSendByWord = true

    this.abortSignal = false
    this.aiContent = null
    this._searchArticleTimer = null

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
    this.category = 1
    this.isNeedBackup = false
    /** WSS 在雲端常把一屏切成多個 frame，單包可能不含完整《看板》字樣 */
    this.onBoardScreenBuf = ''

    /** 可選：發文進度回呼（例如寫入 Firestore） */
    this._onProgress = null
    this.jobId = null
    /** 可選，僅供呼叫端識別（例如 Firestore DocumentReference） */
    this.jobRef = null
    this._progressThrottleMs = 3000
    this._progressMinPercentDelta = 5
    this._lastProgressAt = 0
    this._lastReportedPercent = -1
    this._postReject = null
    this._jobFailed = false
    this._completedOk = false
    this._onPostDone = null
  }

  /**
   * @param {object} payload
   * @param {{ immediate?: boolean }} [opts]
   */
  emitProgress = async (payload, opts = {}) => {
    if (!this._onProgress) return
    const { immediate = false } = opts
    const full = { ...payload, jobId: this.jobId ?? undefined }

    if (!immediate && payload.percent != null) {
      const now = Date.now()
      const delta = Math.abs(payload.percent - this._lastReportedPercent)
      const below100 = payload.percent < 100
      if (
        below100 &&
        now - this._lastProgressAt < this._progressThrottleMs &&
        delta < this._progressMinPercentDelta
      ) {
        return
      }
      this._lastProgressAt = now
      this._lastReportedPercent = payload.percent
    } else if (immediate && payload.percent != null) {
      this._lastReportedPercent = payload.percent
      this._lastProgressAt = Date.now()
    }

    await this._onProgress(full)
  }

  /** 非阻塞；避免 Firestore 延遲卡住 PTT 狀態機 */
  reportProgress = (payload, opts) => {
    void this.emitProgress(payload, opts).catch((e) =>
      console.error('[Poster] onProgress error:', e.message)
    )
  }

  failJob = async (err) => {
    if (this._jobFailed) return
    this._jobFailed = true
    const message = err?.message || String(err)
    try {
      await this.emitProgress(
        { status: 'failed', phase: 'failed', error: message },
        { immediate: true }
      )
    } catch (e) {
      console.error('[Poster] failJob emitProgress:', e.message)
    }
    if (this._postReject) {
      try {
        this._postReject(err instanceof Error ? err : new Error(message))
      } catch (_) {}
    }
  }

  send = (text, callback) => {
    const binaryData = iconv.encode(text, 'big5')
    this.stream.send(binaryData)
    callback && callback()
  }

  continueState = () => {
    if (this.stream) {
      console.log('\n[Auto] Resuming PTT process...')
      this.reportProgress(
        { status: 'running', phase: 'resumed', message: 'Client resumed after content_ready' },
        { immediate: true }
      )
      const isNewPost = !this.aid
      this.currentState = isNewPost ? status.newPost : status.respPost
      this.isProcessing = false
      const input = isNewPost ? keywordMap.input_post : keywordMap.input_resp
      this.send(input)
    }
  }

  abort = () => {
    this.abortSignal = true
    clearTimeout(this._searchArticleTimer)
    if (this.stream) {
      console.log('\n[Auto] Aborting connection...')
      this.stream.close() // 強制終止連線
    }
  }
  
  delayWrite = (text, delay = 500) => {
    return new Promise(resolve => {
      setTimeout(() => {
        this.send(text)
        resolve()
      }, delay)
    })
  }

  /**
   * PTT 發文流程結束
   */
  finishPost = async () => {
    this.reportProgress(
      { status: 'posting', phase: 'saving', message: 'Sending save (Ctrl+X / S)' },
      { immediate: true }
    )
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
    if (isDev && process.stdout.isTTY) {
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(`\r[Auto] Posting (${type}) Progress: ${progress}% (${current}/${total})`)
      if (current === total) process.stdout.write('\n')
    } else {
      console.log(`[Auto] Posting (${type}) Progress: ${progress}% (${current}/${total})`)
    }

    const immediate = current === total || progress >= 100
    this.reportProgress(
      {
        status: 'posting',
        phase: 'posting',
        percent: progress,
        type,
        current,
        total,
      },
      { immediate }
    )
  }

  /**
   * 逐字發文 (帶進度條)
   */
  postEachWord = async () => {
    let fullContent = this.postContent
      .replace(/\n/g, '\r\n')
      .replace(/\t/g, ' ')
    let idx = 0

    const sendSize = isDev ? 1 : Math.ceil(fullContent.length / 500)

    console.log(`[Auto] Posting: ${fullContent.length} chars, sendSize=${sendSize}, delay=[${config.postMinDelayMs},${config.postMaxDelayMs}]ms`)

    const sendCharBatch = () => {
      return new Promise((resolve) => {
        if (idx < fullContent.length) {
          const end = Math.min(idx + sendSize, fullContent.length)
          const batch = fullContent.slice(idx, end)
          this.updatePostingProgress(end, fullContent.length, 'Char')
          this.send(batch)
          idx = end
          setTimeout(() => resolve(false), getRandomInt(config.postMinDelayMs, config.postMaxDelayMs))
        } else {
          resolve(true)
        }
      })
    }

    let done = false
    while (!done) {
      done = await sendCharBatch()
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
          this.send(line + keywordMap.input_enter)
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
        trimmedLine.startsWith(keywordMap.onTitle) ||
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
      this.reportProgress(
        {
          status: 'failed',
          phase: 'failed',
          error: 'Content is empty.',
        },
        { immediate: true }
      )
      this.stream.close()
      this.isProcessing = false
      this.finalResolve({
        success: false,
        message: 'Content is empty.',
      })
      return
    }

    if (this._contentReadyResolve) {
      this.reportProgress(
        {
          status: 'content_ready',
          phase: 'content_ready',
          percent: 0,
          message: 'Content ready; awaiting continueState / post',
          replyUrl: link,
        },
        { immediate: true }
      )
      this._contentReadyResolve({
        message: 'Content ready, proceeding to post.',
        content: text,
        url: link,
      })
      this._contentReadyResolve = null // 確保只呼叫一次
      console.log(`\n[Auto] Content ready, pausing task for index.js callback.`)
    }
    // readArticle 會提早 return 而跳過 handleState 結尾的 isProcessing = false；
    // 切換到 pause 防止 AI 生成期間收到的 PTT 封包誤觸 readArticle 邏輯送出 input_right 讓畫面跑掉。
    this.currentState = status.pause
    this.isProcessing = false
  }

  getAiText = async (drift) => {
    if (this.preGeneratedContent) {
      return divideParagraph(this.preGeneratedContent, getRandomInt(35, 65))
    }
    const prompt = drift +
      '\r\n根據前述內容延伸並發表看法,\r\n回覆的文章不要包括上述內容的引文和推文,\r\n也不需要作者,看板,標題,時間的格式化部分'
    const isUseAI = this.stance || this.target
    let rawText = drift
    if (isUseAI) {
      const aiContent = await generateContentByGoogle({
        prompt,
        stance: this.stance,
        target: this.target,
      })
      if (aiContent.success) {
        rawText = aiContent.value
      } else {
        throw new Error(aiContent.message)
      }
    }
    const rnd = getRandomInt(35, 65)
    const text = divideParagraph(rawText, rnd)
    if (text.length <= config.postMaxChars) return text
    const cut = text.slice(0, config.postMaxChars)
    const lastEnd = Math.max(...['。', '！', '？', '…'].map(c => cut.lastIndexOf(c)))
    if (lastEnd > 0) return cut.slice(0, lastEnd + 1).trimEnd()
    const lastNl = cut.lastIndexOf('\n')
    return lastNl > 0 ? cut.slice(0, lastNl) : cut
  }

  handleNoise = (chunk) => {
    let handled = false
    let logMessage = ''
    let writeInput = ''

    if ((chunk.includes(keywordMap.welcome) || chunk.includes(keywordMap.overload))
        && this.currentState !== status.searchArticle) {
      writeInput = keywordMap.input_right
      logMessage = chunk.includes(keywordMap.welcome) ? 'Skipping welcome screen.' : 'Skipping overload warning.'
      handled = true
    } else if (chunk.includes(keywordMap.writeQuit)) {
      writeInput = keywordMap.input_Quit
      logMessage = 'Quitting unfinished article/draft.'
      handled = true
    } else if (chunk.includes(keywordMap.deleteLink)) {
      writeInput = isDev ? keywordMap.input_No : keywordMap.input_Yes;
      logMessage = `Handling existing link deletion (Input: ${isDev ? 'No' : 'Yes'}).`
      handled = true
    }

    if (handled) {
      console.log(`\n[Auto] Noise Handler (State ${this.currentState}): ${logMessage}`)
      this.send(writeInput)
      this.buffer = ''
      this.isProcessing = false
    }
    return handled
  }

  /**
   * 核心狀態處理機
   */
  handleState = async (chunk, resolve, reject) => {
    // console.log(`[State${this.currentState}]${this.isProcessing} ${chunk}`)
    if (isDev) {
        // 將接收到的 chunk 寫入 log 檔案
      fs.appendFileSync(
        'debug.log', 
        `\r\n\n---Processing: ${this.isProcessing}, STATE: ${this.currentState}, TIME: ${new Date().toISOString()} ---\n` + chunk
      )
    }

    if (this.isProcessing) return

    this.isProcessing = true

    const previousState = this.currentState
    let match

    // 優先處理雜訊 (不受狀態影響)
    if(this.handleNoise(chunk)) return

    // --- 狀態機邏輯 ---
    switch (this.currentState) {
      case status.init:
        if (chunk.includes(keywordMap.account)) {
          console.log('\n[Auto] Sending ID...')
          this.reportProgress({ status: 'running', phase: 'sent_id' }, { immediate: true })

          this.send(
            this.id + keywordMap.input_enter,
            _ => this.currentState = status.login
          )
        }
        break

      case status.login:
        if (chunk.includes(keywordMap.password)) {
          console.log('\n[Auto] Sending password...')
          this.reportProgress({ status: 'running', phase: 'sent_password' }, { immediate: true })

          this.send(
            this.password + keywordMap.input_enter,
            _ => this.currentState = status.mainMenu
          ) 
        }
        break

      case status.mainMenu:
        if (chunk.includes(keywordMap.mainMenu)) {
          console.log('\n[Auto] At main menu, entering board search...')
          this.reportProgress({ status: 'running', phase: 'main_menu' }, { immediate: true })

          this.send(
            keywordMap.input_search,
            _ => this.currentState = status.searchBoard
          )
        }
        break

      case status.searchBoard:
        if (chunk.includes(keywordMap.searchBoard)) {
          console.log('\n[Auto] Searching board...')
          this.reportProgress({ status: 'running', phase: 'searching_board' }, { immediate: true })

          this.send(
            this.board + keywordMap.input_enter,
            _ => {
              this.currentState = status.onBoard
              this.onBoardScreenBuf = ''
            }
          )
        }
        break

      case status.onBoard: {
        const boardMark = `《${this.board.toLowerCase()}》`
        this.onBoardScreenBuf += chunk
        if (this.onBoardScreenBuf.length > 24000) {
          this.onBoardScreenBuf = this.onBoardScreenBuf.slice(-24000)
        }
        if (this.onBoardScreenBuf.toLowerCase().includes(boardMark)) {
          console.log('\n[Auto] On board, search/starting post...')
          this.onBoardScreenBuf = ''
          const isNewPost = !this.aid // 檢查是否為新文章 (不是回文)
          this.reportProgress({ status: 'running', phase: 'on_board' }, { immediate: true })
          if (isNewPost) {
            this.reportProgress({ status: 'running', phase: 'ai_generating' }, { immediate: true })
            this.postContent = await this.getAiText(this.draft)
            this.handleResolve({ text: this.postContent })
          } else {
            this.send(`#`, _ => {
              this.currentState = status.searchArticle
              this.onBoardScreenBuf = ''
              this._searchArticleTimer = setTimeout(() => {
                if (this.currentState === status.searchArticle) {
                  void this.failJob(new Error('Search article timeout: PTT did not respond to # command'))
                }
              }, 30000)
            })
          }
        }
        break
      }
      case status.searchArticle:
        if(chunk.includes(keywordMap.searchArticle)) {
          clearTimeout(this._searchArticleTimer)
          console.log('\n[Auto] On board, searching article...')
          this.reportProgress({ status: 'running', phase: 'searching_article' }, { immediate: true })

          this.send(
            `${this.aid}`+ keywordMap.input_enter,
            _ => this.currentState = status.atArticleTitle
          )
        }
        break
      case status.atArticleTitle:
        match = chunk.match(/\s*(\x08*)?[●>]?\s*\d+\s*/)
        if (match) {
          console.log('\n[Auto] At title, entering article...')
          this.reportProgress({ status: 'running', phase: 'reading_article' }, { immediate: true })
          
          this.send(
            keywordMap.input_right,
            _ => this.currentState = status.readArticle
          )
        }
        break

      case status.readArticle:
        console.log(`\n[Auto] Read article`)

        if (!chunk.toLowerCase().includes(`看板《${this.board.toLowerCase()}`)) {
          this.buffer += chunk
        }

        match = chunk.match(
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
              this.reportProgress(
                { status: 'running', phase: 'ai_generating_reply' },
                { immediate: true }
              )
              this.postContent = await this.getAiText(article.content)

              if (this.isNeedBackup) writeFile(this.postContent, backupPath)
            }

            this.handleResolve({ text: this.postContent, link })

            return // 暫停；isProcessing 在 handleResolve 已清除
          }
        } else {
          console.log('-> Reading...')
          this.retryCount++
          if (this.retryCount >= 30) {
            console.error('\n[Auto] Failed to extract article link after retries.')
            throw new Error('Failed to extract article link.')
          }
          this.send(
            keywordMap.input_right,
            _ => this.isProcessing = false
          )
          return
        }
        break

      case status.pause:
        // 等 index.js 呼叫 continueState()，此間仍接收封包但不推進狀態
        break

      case status.respPost:
        if (chunk.includes(keywordMap.reTitle)) {
          console.log(`\n[Auto] Run response process...`)
          this.send(keywordMap.input_Yes) // 採用原標題
        }
        if (chunk.includes(keywordMap.reContent)) {
          this.currentState = status.startPost
          this.send(keywordMap.input_No) // 不引用原文
        }
        break

      case status.newPost:
        console.log('\n[Auto] Run new post process...') 
        if (chunk.includes(keywordMap.onCategory)) {
          // 1. 選擇文章類型
          this.send(`${this.category}` + keywordMap.input_enter)
        }
        if (chunk.includes(keywordMap.onTitle)) {
          this.currentState = status.startPost
          // 2. 輸入標題
          this.send(this.title + keywordMap.input_enter)
        }
        break

      case status.startPost:
        console.log('\n[Auto] Start post...')
        if (this.postContent.length) {
          this.postContent = this.insertNewlinesPreservingExisting(
            this.postContent
          )

          this.currentState = status.posting
          this.reportProgress(
            { status: 'posting', phase: 'posting', percent: 0, message: 'Started sending body' },
            { immediate: true }
          )
          if (this.isSendByWord) {
            void this.postEachWord().catch((e) => void this.failJob(e))
          } else {
            void this.postEachLine().catch((e) => void this.failJob(e))
          }
        } else {
          console.log('\n[Auto] Content is empty, skipping post.')
          this.currentState = status.postDone
          this.send(keywordMap.input_enter)
        }
        break

      case status.postDone:
        console.log('\n[Auto] Post done.')
        this._completedOk = true
        if (this._onPostDone) {
          try { await this._onPostDone() } catch (e) { console.error('[Poster] onPostDone error:', e.message) }
        }
        try {
          await this.emitProgress(
            {
              status: 'done',
              phase: 'post_done',
              percent: 100,
              message: 'Article posted successfully.',
            },
            { immediate: true }
          )
        } catch (e) {
          console.error('[Poster] emitProgress post_done:', e.message)
        }
        this.stream.close()
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
      category,
      isSendByWord,
      isNeedBackup,
      onProgress,
      onPostDone,
      jobRef,
      jobId: jobIdOpt,
      progressThrottleMs,
      progressMinPercentDelta,
    } = options

    this._onProgress = typeof onProgress === 'function' ? onProgress : null
    this._onPostDone = typeof onPostDone === 'function' ? onPostDone : null
    this.jobRef = jobRef != null ? jobRef : null
    this.jobId =
      jobIdOpt != null
        ? String(jobIdOpt)
        : this.jobRef && typeof this.jobRef.id === 'string'
          ? this.jobRef.id
          : null
    this._progressThrottleMs =
      typeof progressThrottleMs === 'number' ? progressThrottleMs : 3000
    this._progressMinPercentDelta =
      typeof progressMinPercentDelta === 'number'
        ? progressMinPercentDelta
        : 5
    this._lastProgressAt = 0
    this._lastReportedPercent = -1
    this._jobFailed = false
    this._completedOk = false

    // 注入參數（HTTP JSON 常帶入尾端空白；比對《看板》須精確）
    this.board = board != null ? String(board).trim() : null
    this.title = title
    this.aid = aid
    this.draft = draft
    this.target = target
    this.stance = stance
    this.category = category
    this.preGeneratedContent = options.preGeneratedContent || null

    this.isSendByWord = !!isSendByWord
    this.isNeedBackup = !!isNeedBackup

    return new Promise((resolve, reject) => {
      this._postReject = reject
      this.finalResolve = resolve
      this.finalReject = reject

      this.stream = new w3cwebsocket(
        'wss://ws.ptt.cc/bbs',  // 參數 1: PTT WebSocket 網址
        'bbs',                  // 參數 2: Protocol (通訊協定，設為 'bbs' 或 undefined)
        'https://term.ptt.cc',  // 參數 3: Origin (來源偽裝)
        {                       // Headers (表頭)
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        }
      )

      this.stream.onopen = () => {
        console.log('WSS 連線成功！現在連到 PTT')
        this.reportProgress({ status: 'running', phase: 'wss_open' }, { immediate: true })

        // 重要：把所有從伺服器來的資料餵給你的狀態機
        this.stream.onmessage = async (msg) => {
          try {
            const buffer = Buffer.from(msg.data)
            const chunk = iconv.decode(buffer, 'big5')

            await this.handleState(chunk, resolve, reject)
          } catch (err) {
            await this.failJob(err)
          }
        }
      }
      this.stream.onerror = () => {
        void this.failJob(new Error('WSS error'))
      }
      this.stream.onclose = () => {
        if (!this._completedOk && !this._jobFailed) {
          void this.failJob(new Error('WSS 斷線'))
        }
      }
    }) 
  }
}

module.exports = { Poster } 
