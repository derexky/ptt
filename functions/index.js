/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
const { Poster } = require('./external/poster')
const { logger } = require('firebase-functions')
const { onRequest } = require('firebase-functions/v2/https')

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

async function runPost(config) {
  // 從 config 中解構 (Destructure) 參數
  const { id, password, args, isNewPost } = config

  // 檢查關鍵參數是否存在
  if (!id || !password || !args || !args.board) {
    throw new Error('Missing required parameters (id, password, args.board).')
  }

  const controller = new Poster(id, password)
  const finalPostPromise = controller
    .postArticle({
      board: args.board,
      title: isNewPost ? args.subject : null,
      articleNumber: isNewPost ? null : args.reply,
      stance: args.stance,
      target: isNewPost ? null : args.target,
      isSendByWord: args.isSendByWord,
    })
    .catch((err) => {
      // 捕獲並記錄背景發文的最終錯誤
      logger.error(`Background posting failed:`, err.message)
    })

  try {
    // 根據 isNewPost 判斷是發新文章還是回覆
    const aiResult = await controller.aiContentReady

    return {
      message: aiResult.message,
      aiContent: aiResult.content,
      reply: aiResult.url,
      controller,
      finalPostPromise,
    }
  } catch (error) {
    logger.error('Controller Error:', error.message)
    // 拋出錯誤，讓外部捕捉
    throw new Error(`Posting failed: ${error.message}`)
  }
}

exports.post = onRequest(
  {
    timeoutSeconds: 120,
  },
  async (request, response) => {
    // 1. 設置 CORS 標頭 (可選，如果您從前端網頁調用)
    // response.set('Access-Control-Allow-Origin', '*');

    // 2. 獲取 HTTP 請求 Body 中的 JSON 數據
    const body = request.body
    logger.info('Received request body:', body)

    // 3. 呼叫核心邏輯並處理結果
    try {
      const postConfig = {
        id: body.id,
        password: body.password,
        args: body.args || {}, // 確保 args 至少是個空對象
        isNewPost: body.isNewPost === true, // 確保為布林值
        isSendByWord: body.isSendByWord === true, // 確保為布林值
      }

      const result = await runPost(postConfig)
      const { aiContent, reply, message, controller, finalPostPromise } = result

      response.status(200).json({
        success: true,
        message,
        aiContent,
        reply,
      })

      if (controller) {
        console.log(`\n[Auto] Resuming task in background.`)
        await controller.continueState()
        await finalPostPromise.finally(() => {
          console.log(`\n[Auto] Background task finished and cleared from activeTasks.`)
        })
      }
    } catch (error) {
      // 失敗：返回 500 Internal Server Error
      logger.error('Function execution error:', error.message)
      response.status(500).json({
        success: false,
        error: error.message || 'An unknown error occurred during posting.',
      })
    }
  }
)
