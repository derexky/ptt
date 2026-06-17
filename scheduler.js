// scheduler.js
require('dotenv').config()
const schedule = require('node-schedule')
const { runWorkflow, runCrawl } = require('./workflow')

const crawlCron = process.env.CRAWL_SCHEDULE || '*/30 * * * *'
const cronExpr  = process.env.CRON_SCHEDULE  || '10,40 * * * *'

const runningBots = new Set()

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

if (!botJob || !crawlJob) {
  console.error('Invalid cron expression in CRON_SCHEDULE or CRAWL_SCHEDULE.')
  process.exit(1)
}

console.log(`Scheduler started.`)
console.log(`  Bot cron:   "${cronExpr}"  → next: ${botJob.nextInvocation()}`)
console.log(`  Crawl cron: "${crawlCron}" → next: ${crawlJob.nextInvocation()}`)
console.log('Press Ctrl+C to stop.')
