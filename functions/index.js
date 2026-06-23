/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
const crypto = require('crypto')
const admin = require('firebase-admin')
const { FieldValue } = require('firebase-admin/firestore')
const { Poster } = require('./external/posterWS')
const { logger } = require('firebase-functions')
const { onRequest } = require('firebase-functions/v2/https')

if (!admin.apps.length) {
  admin.initializeApp()
}

const db = admin.firestore()

/** @param {Record<string, unknown>} ev */
function buildProgressPatch(ev) {
  const patch = {
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (ev.status != null) patch.status = ev.status
  if (ev.phase != null) patch.phase = ev.phase
  if (ev.percent != null) patch.percent = ev.percent
  if (ev.type != null) patch.progressType = ev.type
  if (ev.current != null) patch.progressCurrent = ev.current
  if (ev.total != null) patch.progressTotal = ev.total
  if (ev.error != null) patch.error = String(ev.error)
  if (ev.message != null) patch.message = String(ev.message)
  if (ev.replyUrl != null) patch.replyUrl = String(ev.replyUrl)
  if (ev.jobId != null) patch.jobId = String(ev.jobId)
  return patch
}

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

async function runPost(config, progressCtx = {}) {
  // 從 config 中解構 (Destructure) 參數
  const { id, password, args, isNewPost } = config
  const { jobId, jobRef, onProgress } = progressCtx

  // 檢查關鍵參數是否存在
  if (!id || !password || !args || !args.board) {
    throw new Error('Missing required parameters (id, password, args.board).')
  }

  const controller = new Poster(id, password)
  const finalPostPromise = controller.postArticle({
    board: args.board,
    title: isNewPost ? args.subject : null,
    category: Number(args.category) || 1,
    aid: isNewPost ? null : args.reply.replace(/^#/, ''),
    stance: args.stance,
    target: isNewPost ? null : args.target,
    isSendByWord: args.isSendByWord,
    draft: isNewPost ? args.draft : null,
    isNeedBackup: false,
    jobId,
    jobRef,
    onProgress,
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
  timeoutSeconds: 300,
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
  logger.info('post request', {
    isNewPost: body.isNewPost === true,
    board: body.args?.board,
    hasCredentials: !!(body.id && body.password),
  })

  const jobId = crypto.randomUUID()
  const jobRef = db.collection('postJobs').doc(jobId)

  // 3. 呼叫核心邏輯並處理結果
  try {
    await jobRef.set({
      jobId,
      status: 'running',
      phase: 'queued',
      percent: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    const onProgress = async (ev) => {
      try {
        await jobRef.set(buildProgressPatch(ev), { merge: true })
      } catch (e) {
        logger.error('postJobs progress write failed:', e.message)
      }
    }

    const postConfig = {
      id: body.id,
      password: body.password,
      args: body.args || {}, // 確保 args 至少是個空對象
      isNewPost: body.isNewPost === true, // 確保為布林值
      isSendByWord: body.isSendByWord === true, // 確保為布林值
    }

    const progressCtx = { jobId, jobRef, onProgress }
    const result = await runPost(postConfig, progressCtx)
    const { aiContent, reply, message, controller, finalPostPromise } = result

    response.status(200).json({
      success: true,
      jobId,
      message,
      aiContent,
      reply,
    })

    if (controller) {
      console.log(`\n[Auto] Resuming task in background.`)
      controller.continueState()
      try {
        await finalPostPromise
        await jobRef.set(
          buildProgressPatch({
            status: 'done',
            phase: 'completed',
            percent: 100,
            message: 'finalPostPromise settled',
          }),
          { merge: true }
        )
      } catch (err) {
        await jobRef.set(
          buildProgressPatch({
            status: 'failed',
            phase: 'failed',
            error: err?.message || String(err),
          }),
          { merge: true }
        )
        logger.error('Background posting failed:', err?.message || err)
      }
      console.log(
        `\n[Auto] Background task finished and cleared from activeTasks.`
      )
    }
  } catch (error) {
    try {
      await jobRef.set(
        buildProgressPatch({
          status: 'failed',
          phase: 'failed',
          error: error.message || String(error),
        }),
        { merge: true }
      )
    } catch (e) {
      logger.error('postJobs failed patch error:', e.message)
    }
    // 失敗：返回 500 Internal Server Error
    logger.error('Function execution error:', error.message)
    response.status(500).json({
      success: false,
      jobId,
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