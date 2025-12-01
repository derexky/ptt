const fs = require('fs')

const devideParagraph = (raw, lengthPerLine = 50) => {
  if (!raw) return ''

  // 1. 標準化所有換行符號為單一的 \n，方便後續處理。
  let normalizedContent = raw.replace(/\r\n/g, '\n')

  // 2. 將文章內容依據一個或多個換行符號分割成多個「段落」
  const paragraphs = normalizedContent.split('\n')

  const formattedParagraphs = paragraphs.map(paragraph => {
    // 移除段落前後的空白字元
    let cleanParagraph = paragraph.trim()

    if (cleanParagraph.length === 0) {
      // 如果原本就是空行，則保留為 \n（map 最後會 join()，所以這裡回傳空字串即可）
      return ''
    }

    // 3. 針對長度超過 lengthPerLine 的段落進行強制分行
    if (cleanParagraph.length > lengthPerLine) {
      // 創建正規表達式：(.{1,N})，匹配 1 到 N 個字元
      const regex = new RegExp(`(.{1,${lengthPerLine}})`, 'g')
      
      // 在每個匹配的區塊後面加入 \n
      // 使用 trim() 避免在段落結尾多一個 \n
      return cleanParagraph.replace(regex, '$1\n').trim()
    } else {
      // 如果段落長度沒超過，則完整保留該段落
      return cleanParagraph
    }
  })

  // 4. 使用 \n 將所有處理後的段落重新連接起來
  // 如果原始內容有多個連續換行，如 \n\n，map 會產生 ['', 'paragraph', '']
  // join('\n') 後仍會是 \n\nparagraph\n
  return formattedParagraphs.join('\n')
}

const readFile = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text
  } catch (err) {
    console.error('Text file error:', err.message)
  }
}

const writeFile = (text, path = './tmp') => {
  fs.writeFile(path, text, 'utf8', (err) => {
    if (err) {
      console.error('覆蓋錯誤：', err);
      return
    }
    console.log(`覆蓋寫入完成！檔案：${path}`)
  })
}

const getRandomInt = (min, max) => {
  // 1. 確保 min 和 max 是整數，並處理浮點數輸入
  min = Math.ceil(min)
  max = Math.floor(max)
  
  // 2. 核心公式：
  // Math.random() 產生 [0, 1)
  // 乘以 (max - min + 1) 讓範圍變成 [0, max - min + 1)
  // Math.floor() 讓結果變成 [0, max - min] 的整數
  // 最後加上 min，將範圍平移到 [min, max]
  return Math.floor(Math.random() * (max - min + 1)) + min
}

module.exports = {
  devideParagraph,
  readFile,
  writeFile,
  getRandomInt,
}