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
      aid: isNewPost ? null : args.reply.replace(/^#/, ''),
      stance: args.stance,
      target: isNewPost ? null : args.target,
      isSendByWord: args.isSendByWord,
      draft: isNewPost ? args.draft : null,
      isNeedBackup: false,
    })
    .catch((err) => {
      // 捕獲並記錄背景發文的最終錯誤
      logger.error(`Background posting failed:`, err.message)
    })

  try {
    // 根據 isNewPost 判斷是發新文章還是回覆
    const aiResult = await controller.contentReady

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

const config =  {
  timeoutSeconds: 120,
}

const createStreamHandler = async (request, response) => {
  // 1. 設置 CORS 標頭 (必須為所有請求設置，包括 OPTIONS)
  response.set('Access-Control-Allow-Origin', '*')
  response.set('Access-Control-Allow-Methods', 'POST, OPTIONS') // 允許 POST 和 OPTIONS
  response.set('Access-Control-Allow-Headers', 'Content-Type') // 允許 Content-Type 標頭

  // 1.1 處理 OPTIONS 預檢請求 (Preflight Request)
  if (request.method === 'OPTIONS') {
    // 如果是 OPTIONS 請求，只需返回 204 (No Content) 狀態碼
    // 瀏覽器收到這些標頭後就會允許後續的 POST 請求
    response.status(204).send('')
    return
  }
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
      controller.continueState()
      await finalPostPromise.finally(() => {
        console.log(
          `\n[Auto] Background task finished and cleared from activeTasks.`
        )
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

// 區域 A: us-central1 (default)(Iowa)
exports.postUs = onRequest(config, createStreamHandler)

// 區域 B: asia-east1 (Taiwan)
exports.post = onRequest({ ...config,region: 'asia-east1' }, createStreamHandler)

// 區域 C: europe-west1 (Belgium)
exports.postEu = onRequest({ ...config, region: 'europe-west1' }, createStreamHandler)

// // 區域 D: us-east1 (South Carolina)
// exports.postUs_sc = onRequest({ ...config, region: 'us-east1' }, createStreamHandler)

// // 區域 E: us-west1 (Oregon)
// exports.postUs_o = onRequest({ ...config, region: 'us-west1' }, createStreamHandler)

// // 區域 F: asia-east2 (Hong Kong)
// exports.postAsia_h = onRequest({ ...config, region: 'asia-east2' }, createStreamHandler)

// // 區域 G: europe-north1 (Finland)
// exports.postEu_f = onRequest({ ...config, region: 'europe-west2' }, createStreamHandler)

// // 區域 H: asia-northeast1 (Tokyo)
// exports.postAsia_t = onRequest({ ...config, region: 'asia-northeast1' }, createStreamHandler)