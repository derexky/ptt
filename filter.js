function keywordFilter(articles, keywords) {
  if (!keywords || keywords.length === 0) return articles
  const lower = keywords.map(k => k.toLowerCase())
  return articles.filter(a =>
    lower.some(k => a.title.toLowerCase().includes(k))
  )
}

module.exports = { keywordFilter }
