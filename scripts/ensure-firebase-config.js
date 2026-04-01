#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '../public/firebase-config.js')
const sample = path.join(__dirname, '../public/firebase-config.sample.js')

if (fs.existsSync(target)) {
  process.exit(0)
}

console.error(
  '缺少 public/firebase-config.js。\n' +
    '請執行: npm run setup:firebase-config\n' +
    '或手動: cp public/firebase-config.sample.js public/firebase-config.js\n' +
    '再填入 Firebase Console 網頁應用程式設定。'
)
process.exit(1)
