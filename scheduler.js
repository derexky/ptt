// scheduler.js
require('dotenv').config()
const schedule = require('node-schedule')
const { runWorkflow } = require('./workflow')

const cronExpr = process.env.CRON_SCHEDULE || '0 * * * *'

let running = false

const job = schedule.scheduleJob(cronExpr, async () => {
  if (running) {
    console.log(`[${new Date().toISOString()}] Previous run still in progress, skipping.`)
    return
  }
  running = true
  console.log(`[${new Date().toISOString()}] Scheduled run starting...`)
  try {
    await runWorkflow()
  } catch (err) {
    console.error(`[Scheduler] Error:`, err.message)
  } finally {
    running = false
  }
})

console.log(`Scheduler started. Cron: "${cronExpr}"`)
console.log(`Next fire: ${job.nextInvocation()}`)
console.log('Press Ctrl+C to stop.')
