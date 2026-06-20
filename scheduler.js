// scheduler.js
require('dotenv').config()
const schedule = require('node-schedule')
const { runWorkflow, runCrawl, runScheduledPosts, initSchema, createPool } = require('./workflow')
const { refresh: refreshProxies } = require('./refreshProxies')

const crawlCron = process.env.CRAWL_SCHEDULE || '*/30 * * * *'
const cronExpr  = process.env.CRON_SCHEDULE  || '10,40 * * * *'

const runningBots = new Set()

// Ensure all tables exist before any jobs fire
;(async () => {
  const pool = createPool()
  try {
    await initSchema(pool)
  } catch (err) {
    console.error('[Scheduler] initSchema failed:', err.message)
  } finally {
    await pool.end()
  }
})()

const botJob = schedule.scheduleJob(cronExpr, async () => {
  console.log(`[${new Date().toISOString()}] Scheduled run starting...`)
  try {
    await runWorkflow(runningBots)
  } catch (err) {
    console.error(`[Scheduler] Error:`, err.message)
  }
})

let crawling = false
const crawlJob = schedule.scheduleJob(crawlCron, async () => {
  if (crawling) {
    console.log(`[${new Date().toISOString()}] Crawl still in progress, skipping.`)
    return
  }
  crawling = true
  try {
    await runCrawl()
  } catch (err) {
    console.error(`[Crawl] Error:`, err.message)
  } finally {
    crawling = false
  }
})

let scheduledPosting = false
schedule.scheduleJob('* * * * *', async () => {
  if (scheduledPosting) {
    console.log(`[ScheduledPost] Still in progress, skipping.`)
    return
  }
  scheduledPosting = true
  try {
    await runScheduledPosts()
  } catch (err) {
    console.error(`[ScheduledPost] Error:`, err.message)
  } finally {
    scheduledPosting = false
  }
})

// 每週日 00:00 (Asia/Taipei) = 週六 16:00 UTC 更新 proxy
const proxyCron = process.env.PROXY_REFRESH_SCHEDULE || '0 16 * * 6'
if (process.env.WEBSHARE_API_KEY) {
  schedule.scheduleJob(proxyCron, async () => {
    console.log(`[${new Date().toISOString()}] Weekly proxy refresh starting...`)
    try {
      await refreshProxies()
    } catch (err) {
      console.error(`[ProxyRefresh] Error:`, err.message)
    }
  })
  console.log(`  Proxy cron: "${proxyCron}"`)
} else {
  console.log(`  Proxy cron: skipped (WEBSHARE_API_KEY not set)`)
}

if (!botJob || !crawlJob) {
  console.error('Invalid cron expression in CRON_SCHEDULE or CRAWL_SCHEDULE.')
  process.exit(1)
}

console.log(`Scheduler started.`)
console.log(`  Bot cron:   "${cronExpr}"  → next: ${botJob.nextInvocation()}`)
console.log(`  Crawl cron: "${crawlCron}" → next: ${crawlJob.nextInvocation()}`)
console.log('Press Ctrl+C to stop.')
