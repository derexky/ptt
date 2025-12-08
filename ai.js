require('dotenv').config()
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

// 【新增】記錄上次成功呼叫的時間
let lastCallTime = 0
// 【新增】設定最小間隔時間（2 分鐘 = 120,000 毫秒）
const MIN_INTERVAL = 120000


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
async function generateContentByGoogle({ prompt, stance, target, isTroll = true }) {
  let viewpoint = stance || `你是一位資深鄉民，回文中會帶著低俗詼諧且有點嘲諷的語氣` 
  if(target) viewpoint += `以${isTroll ? '諷刺' : '讚揚'}${target}的客觀態度來回應問題`
  const now = Date.now()
  const timeElapsed = now - lastCallTime

  // 【新增】檢查是否已滿足最小間隔時間
  if (lastCallTime !== 0 && timeElapsed < MIN_INTERVAL) {
    const timeToWait = MIN_INTERVAL - timeElapsed
    const minutesToWait = (timeToWait / 60000).toFixed(2)
    
    console.warn(`\n[AI Rate Limit] 距離上次呼叫 AI 不足 2 分鐘，請等待 ${minutesToWait} 分鐘後再試。`)
    // 您可以選擇在這裡拋出錯誤，或回傳一個空字串/預設值
    return
    // 或者可以拋出錯誤讓外部處理：
    // throw new Error(`Rate limit: Must wait ${minutesToWait} minutes before calling AI again.`)
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',//'gemini-2.5-pro', //目前免費金鑰可以使用的最高階 Pro 模型。約 5 RPM（每分鐘請求數）和約 100 RPD（每日請求數）
    systemInstruction: viewpoint,
  })
  const contents = [
    { role: "user", parts: [{ text: prompt }] } // 修正: 將 prompt 包裝成 user 內容
  ]
  const result = await model.generateContent({ contents })

  // 【修改】成功呼叫後，更新上次呼叫時間
  lastCallTime = Date.now()

  // console.log(result.response.text())
  return result.response.text()
}


module.exports = {
  generateContentByGoogle
}