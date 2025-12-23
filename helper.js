const fs = require('fs')

const divideParagraph = (raw, lengthPerLine = 50) => {

  if (!raw) return ''

  // 1. 標準化換行符號
  let normalized = raw.replace(/\r\n/g, '\n')

  // 2. 依照「空白行」來分割段落 (匹配兩個以上的換行)
  // 這樣即使段落內有單個換行，也會被視為同一段
  const paragraphs = normalized.split(/\n\s*\n/)

  // 定義常見的斷句標點符號 (包含中英文)
  const punctuationRegex = /[,.!?;:，。！？；：、]/

  const formattedParagraphs = paragraphs.map(paragraph => {
    // 移除段落內原本所有的換行符號，並將前後空白修掉
    // 這樣段落會變成一條完整的長字串
    let cleanParagraph = paragraph.replace(/\n/g, '').trim()
    if (cleanParagraph.length <= lengthPerLine) return cleanParagraph

    let result = ''
    let currentText = cleanParagraph

    // 3. 迴圈處理長段落
    while (currentText.length > lengthPerLine) {
      // 取得預定長度內的片段
      let chunk = currentText.substring(0, lengthPerLine);
      
      // 尋找該片段中最後一個標點符號的位置
      let lastPuncIndex = -1
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (punctuationRegex.test(chunk[i])) {
          lastPuncIndex = i
          break
        }
      }

      // 如果有找到標點符號，就在該標點後斷行；否則強制在 lengthPerLine 處斷行
      let breakIndex = (lastPuncIndex !== -1) ? lastPuncIndex + 1 : lengthPerLine
      
      result += currentText.substring(0, breakIndex).trim() + '\n'
      currentText = currentText.substring(breakIndex).trim()
    }

    // 加上剩餘的文字
    result += currentText
    return result
  })

  // 4. 最後段落與段落之間，用「兩個換行」連接，產生空白行效果
  return formattedParagraphs.join('\n\n')
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
      console.error('覆蓋錯誤：', err)
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
  divideParagraph,
  readFile,
  writeFile,
  getRandomInt,
}