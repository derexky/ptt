// filter.js
const { generateContentByGoogle } = require('./ai')

function keywordFilter(articles, keywords) {
  if (!keywords || keywords.length === 0) return articles
  const lower = keywords.map(k => k.toLowerCase())
  return articles.filter(a =>
    lower.some(k => a.title.toLowerCase().includes(k))
  )
}

async function aiFilter(articles, aiPrompt) {
  if (articles.length === 0) return []

  const titlesText = articles.map((a, i) => `${i}: [push:${a.push ?? 0}] ${a.title}`).join('\n')
  const prompt = [
    aiPrompt,
    '',
    '以下是文章標題清單（格式：索引: [push:推文數] 標題），push 數字越高代表討論熱度越高，「100+」或「爆」代表超過 100 則推文：',
    titlesText,
    '',
    '請從中選出值得回文的文章，優先考慮 push 數較高的文章，以 JSON 陣列格式回傳選出的索引，例如：[0, 2, 5]。只輸出 JSON，不要其他說明文字。',
  ].join('\n')

  const result = await generateContentByGoogle({
    prompt,
    stance: '你是一個文章選題助手，根據使用者的指示，從文章標題清單中選出值得回應的文章。',
  })

  if (!result.success) {
    console.error('[AI Filter] Call failed:', result.message)
    return []
  }

  try {
    const match = result.value.match(/\[[\d,\s]*\]/)
    if (!match) {
      console.error('[AI Filter] Cannot parse response:', result.value)
      return []
    }
    const indices = JSON.parse(match[0])
    return indices
      .filter(i => Number.isInteger(i) && i >= 0 && i < articles.length)
      .map(i => articles[i])
  } catch (e) {
    console.error('[AI Filter] Parse error:', e.message)
    return []
  }
}

module.exports = { keywordFilter, aiFilter }
