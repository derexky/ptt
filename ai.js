const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
// const OpenAI = require('openai')
const { GoogleGenerativeAI } = require('@google/generative-ai')
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
// console.log(process.env.DEEPSEEK_API_KEY)
// const openai = new OpenAI({
//   apiKey: process.env.DEEPSEEK_API_KEY,  // 改用 DeepSeek Key
//   baseURL: 'https://api.deepseek.com/v1',  // 改端點
// })

// async function generateContentByOpenai(prompt) {
//   const completion = await openai.chat.completions.create({
//     // model: 'gpt-4o',
//     model: 'deepseek-chat',
//     messages: [
//       {
//         role: 'system',
//         content: '你是一位堅定的民進黨黨工，總是以反對泛藍陣營的立場回應所有問題，回文中會帶著輕鬆詼諧病有點反諷的語氣。'
//       },
//       {
//         role: 'user',
//         content: prompt
//       }
//     ],
//   })
//   console.log(completion.choices[0].message.content)
// }

const isDev = process.env.NODE_ENV === 'develop'

// 【新增】記錄上次成功呼叫的時間
let lastCallTime = 0
// 【新增】設定最小間隔時間（2 分鐘 = 120,000 毫秒）
const MIN_INTERVAL = 10000


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
async function generateContentByGoogle({ prompt, stance, target, isTroll = true, maxTokens = 800, maxRetries = 5, retryDelay = 30000, isCancelled }) {
  let viewpoint = stance || `你是一位資深鄉民，回文中會帶著低俗詼諧且有點嘲諷的語氣`
  if(target) viewpoint += `以${isTroll ? '諷刺' : '讚揚'}${target}的客觀態度來回應問題`
  const now = Date.now()
  const timeElapsed = now - lastCallTime

  if (lastCallTime !== 0 && timeElapsed < MIN_INTERVAL) {
    const timeToWait = MIN_INTERVAL - timeElapsed
    const secToWait = (timeToWait / 1000).toFixed(3)
    const errorMessage = `Rate limit: Must wait ${secToWait} minutes before calling AI again.`
    console.warn(`\n[AI Rate Limit] ${errorMessage}`)
    return { success: false, message: errorMessage }
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: viewpoint,
  })
  const contents = [{ role: "user", parts: [{ text: prompt }] }]

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (isCancelled?.()) return { success: false, message: 'Cancelled' }
    try {
      const result = await model.generateContent({ contents, generationConfig: { maxOutputTokens: maxTokens } })
      lastCallTime = Date.now()
      return { success: true, value: result.response.text() }
    } catch (error) {
      console.error(`\n[AI Error] 呼叫 Google Generative AI 失敗 (第 ${attempt + 1} 次):`, error.message)
      if (isDev && attempt < maxRetries) {
        if (isCancelled?.()) return { success: false, message: 'Cancelled' }
        console.warn(`[AI Retry] ${retryDelay / 1000} 秒後重試...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      } else {
        return { success: false, message: error.message }
      }
    }
  }
}


module.exports = {
  generateContentByGoogle
}