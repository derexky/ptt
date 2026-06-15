require('dotenv').config()
const mysql = require('mysql2/promise')
const config = require('./config')

async function createConnection() {
  return mysql.createConnection(config.mysql)
}

async function initSchema(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS bots (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      ptt_id    VARCHAR(50) NOT NULL,
      password  VARCHAR(100) NOT NULL,
      stance    TEXT,
      tone      VARCHAR(200),
      is_active BOOLEAN DEFAULT TRUE
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS topics (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      board     VARCHAR(50) NOT NULL,
      keywords  JSON NOT NULL,
      ai_prompt TEXT,
      is_active BOOLEAN DEFAULT TRUE
    )
  `)
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS reply_log (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      bot_id       INT NOT NULL,
      article_link VARCHAR(255) NOT NULL,
      replied_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_reply (bot_id, article_link),
      FOREIGN KEY (bot_id) REFERENCES bots(id)
    )
  `)
  console.log('✅ Schema initialised')
}

module.exports = { createConnection, initSchema }
