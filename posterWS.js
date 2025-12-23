// ptt-controller.js

const readline = require('readline') // 引入 readline 用於進度條
const { w3cwebsocket } = require('websocket')
const { generateContentByGoogle } = require('./ai') // 假設這是您的 AI 函式
const { divideParagraph, writeFile, readFile, getRandomInt } = require('./helper') // 假設這是您的輔助函式
const iconv = require('iconv-lite')

// --- 狀態與關鍵字定義 (通常會放在獨立檔案，這裡為方便展示，直接定義) ---
const status = {
  init: 0,
  login: 1,
  welcome: 2,
  mainMenu: 3,
  searchBoard: 4,
  atArticleTitle: 5,
  onBoard: 6,
  writeQuit: 10,
  newPost: 11,
  startPost: 12,
  posting: 13,
  readArticle: 14,
  respPost: 15,
  postDone: 16,
} 

// 注意：board 關鍵字會動態產生
const keywordMap = {
  account: '請輸入代號',
  password: '請輸入您的密碼',
  deleteLink: '刪除其他重複登入的連線',
  welcome: '請按任意鍵繼續',
  mainMenu: '主功能表',
  searchBoard: '請輸入看板名稱',
  // onBoard: dynamic
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
  input_down:'\x1b[B',  // 向下鍵
  input_right:'\x1b[C', // 向右鍵
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
    this.ws = null

    this.currentState = status.init
    this.buffer = ''
    this.isProcessing = false
    this.postContent = ''
    this.isSendByWord = true // 預設使用 postEachWord

    // 任務參數
    this.board = null
    this.title = null
    this.aid = null
    this.contentPath = null
    this.target = null
    this.stance = null
    this.isNewPost = false
  }

  handleSend = (text) => {
    const binaryData = iconv.encode(text, 'big5')
    this.ws.send(binaryData)
  }
  delayWrite = (text, delay = 500) => {
    return new Promise(resolve => {
      setTimeout(() => {
        this.handleSend(text)
        
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
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(output)
      
      if (current === total) {
        process.stdout.write('\n') // 完成後換行
      }
    }

    /**
     * 逐字發文 (帶進度條)
     */
    postEachWord = async () => {
      // 將內容處理為單一字串：替換 \n 為 \r\n，\t 為空格
      let fullContent = this.postContent.replace(/\n/g, '\r\n').replace(/\t/g, ' ')
      let idx = 0
      
      const sendChar = () => {
        const rndDelay = getRandomInt(1000, 1100)
        return new Promise(resolve => {
          if (idx < fullContent.length) {
            this.updatePostingProgress(idx, fullContent.length, 'Char')
            this.handleSend(fullContent[idx])
            idx++
            setTimeout(() => resolve(false), rndDelay)
          } else {
            resolve(true) // 發送完成
          }
        })
      }
      
      let done = false
      while (!done) {
        done = await sendChar()
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
        const rndDelay = getRandomInt(600, 1200)
        return new Promise(resolve => {
          if (idx < lines.length) {
            this.updatePostingProgress(idx, lines.length, 'Line')
            const line = lines[idx].replace(/\t/g, ' ')
            this.handleSend(line + keywordMap.input_enter)
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
      const formattedParagraphs = paragraphs.map(paragraph => {
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
      cleanedContent = cleanedContent.replace(/ ?\[\d{0,3}(?:;\d{1,3})*[A-Za-zKmlH] ?/g, '')
      
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
        if (trimmedLine.startsWith(keywordMap.author) || 
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
        if (trimmedLine.startsWith(keywordMap.site) || 
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

    /**
     * 核心狀態處理機
     */
    handleState = async (chunk, resolve, reject) => {
      // console.log(chunk)
      if (this.isProcessing) return

      this.buffer += chunk
      this.isProcessing = true
        
      const previousState = this.currentState 
        
      // 優先處理雜訊 (不受狀態影響)
      if (chunk.includes(keywordMap.welcome)) {
        this.handleSend(keywordMap.input_down)
        this.buffer = '' 
        this.isProcessing = false 
        return 
      }

      if (chunk.includes(keywordMap.writeQuit)) {
        console.log('\n[Auto] Quit board...') 
        this.handleSend(keywordMap.input_Quit) 
        this.buffer = ''  
        this.isProcessing = false 
        return 
      }

      if (chunk.includes(keywordMap.deleteLink)) {
        console.log('\n[Auto] Delete link...') 
        this.handleSend(keywordMap.input_Yes) 
        this.buffer = ''  
        this.isProcessing = false 
        return 
      }

      // --- 狀態機邏輯 ---
      switch (this.currentState) {
        case status.init:
          if (this.buffer.includes(keywordMap.account)) {
              console.log('\n[Auto] Sending ID...') 
              this.delayWrite(this.id + keywordMap.input_enter) 
              this.currentState = status.login 
          }
          break 

        case status.login:
          if (this.buffer.includes(keywordMap.password)) {
            console.log('\n[Auto] Sending password...') 
            await this.delayWrite(this.password + keywordMap.input_enter) 
            this.currentState = status.welcome 
          }
          break 

        case status.welcome:
          this.currentState = status.mainMenu 
          break 

        case status.mainMenu:
          if (this.buffer.includes(keywordMap.mainMenu)) {
            console.log('\n[Auto] At main menu, entering board search...')     
            await this.delayWrite(keywordMap.input_search) 
            this.currentState = status.searchBoard 
          }
          break 
            
        case status.searchBoard:
          if (this.buffer.includes(keywordMap.searchBoard)) {
            console.log('\n[Auto] Searching board...') 
            await this.delayWrite(this.board + keywordMap.input_enter) 
            this.currentState = status.onBoard 
          }
          break 

        case status.onBoard:
          if (this.buffer.toLowerCase().includes(`看板《${this.board.toLowerCase()}`)) {
            console.log('\n[Auto] On board, search/starting post...') 
            if (this.isNewPost) {
              const content = readFile(this.contentPath) 
              this.postContent = divideParagraph(content) 
              await this.delayWrite(keywordMap.input_post)
              this.currentState = status.newPost  
            } else {
              await this.delayWrite(`${this.aid}${keywordMap.input_enter}`) 
              this.currentState = status.atArticleTitle 
            }
          }
          break 

        case status.atArticleTitle:
          console.log('\n[Auto] At title, entering article...') 
          await this.delayWrite(keywordMap.input_right)  // 向右鍵
          this.currentState = status.readArticle 
          break 
        
        case status.readArticle:
          console.log(`\n[Auto] Read article...`)
          if (!chunk.toLowerCase().includes(`看板《${this.board.toLowerCase()}`)) {
            this.buffer += chunk
          }
          const match = chunk.match(/文章網址\s*:\s*(https?:\/\/www\.ptt\.cc\/bbs\/[^\/]+\/M\.\d+\.[A-Z]\.\w+\.html)/i) 
          if(match) {
            const link = match[1] 
            console.log(`\n[Auto] Get link, ${link}...`) 

           
            const rawContent = this.buffer 
            const content = this.extractPttContent(rawContent)
            // writeFile(content) 
            const article = { content }//await getArticle(link)
            
            if(article) {
              writeFile(article.content, `./backup/${this.board.toLowerCase()}-${this.aid}`) 

              const backupPath = `./backup/RE:${this.board.toLowerCase()}-${this.aid}` 
              const backupContent = readFile(backupPath) 

              let contentToPost = '' 
              if(backupContent) {
                contentToPost = divideParagraph(backupContent) 
              } else {
                // AI 生成內容
                const prompt = article.content + '\r\n根據上述內容發表看法,\r\n回覆的文章不要包括上述內容的引文和推文,\r\n也不需要作者,看板,標題,時間的格式化部分'
                const aiContent = await generateContentByGoogle({prompt, stance: this.stance, target: this.target}) 
                if(aiContent) {
                  contentToPost = divideParagraph(aiContent) 
                  writeFile(contentToPost, backupPath) 
                }
              }
              this.postContent = contentToPost 
              await this.delayWrite(keywordMap.input_resp) 
              this.currentState = status.respPost
            }
          } else {
            console.log('-> Reading...') 
            this.delayWrite(keywordMap.input_right)  // 向右鍵
          }
          break 

        case status.respPost:
            // 引用原文、引用回覆標題
            await this.delayWrite(keywordMap.input_Yes)  // 採用原標題
            await this.delayWrite(keywordMap.input_No)  // 不引用原文
            this.currentState = status.startPost 
            break 

        case status.newPost:
          // 1. 選擇文章類型
          await this.delayWrite(keywordMap.input_1)  
          // 2. 輸入標題
          await this.delayWrite(this.title + keywordMap.input_enter) 
          this.currentState = status.startPost 
          break 

        case status.startPost:
          console.log('\n[Auto] Start post...') 
          if(this.postContent.length) {
            this.postContent = this.insertNewlinesPreservingExisting(this.postContent)  
            
            this.currentState = status.posting 
            // 延遲 1 秒後開始發文
            if (this.isSendByWord) {
              this.postEachWord() 
            } else {
              this.postEachLine() 
            }
          } else {
            console.log('\n[Auto] Content is empty, skipping post.') 
            this.currentState = status.postDone 
          }
          break 

        case status.postDone:
          console.log('\n[Auto] Post done.') 
          this.ws.close() 
          resolve({ success: true, message: 'Article posted successfully.' }) 
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
      const { board, title, aid, contentPath, target, isSendByWord } = options 

      // 注入參數
      this.board = board 
      this.title = title 
      this.aid = aid 
      this.contentPath = contentPath 
      this.target = target 
      this.isNewPost = !Number(aid) // 檢查是否為新文章 (不是回文)
      this.isSendByWord = isSendByWord

      return new Promise((resolve, reject) => {
        this.ws = new w3cwebsocket(
          'wss://ws.ptt.cc/bbs',  // 參數 1: PTT WebSocket 網址
          'bbs',                  // 參數 2: Protocol (通訊協定，設為 'bbs' 或 undefined)
          'https://term.ptt.cc',  // 參數 3: Origin (來源偽裝)
          {                       // Headers (表頭)
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          }
        )

        this.ws.onopen = () => {
          console.log('WSS 連線成功！現在連到 PTT')

          // 重要：把所有從伺服器來的資料餵給你的狀態機
          this.ws.onmessage = (msg) => {
            const buffer = Buffer.from(msg.data)
            const chunk = iconv.decode(buffer, 'big5')
          
            this.handleState(chunk, resolve, reject)
          }
        }
        this.ws.onerror = (e) => reject(e)
        this.ws.onclose = () => {
          if (this.currentState !== status.postDone) {
            reject(new Error('WSS 斷線'))
          }
        }
    }) 
  }
}

module.exports = { Poster } 
