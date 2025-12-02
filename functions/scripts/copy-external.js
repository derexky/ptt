const fs = require('fs')
const path = require('path')

function safeCopy(src, dest) {
  try {
    fs.copyFileSync(src, dest)
    console.log(`Copied ${src} -> ${dest}`)
  } catch (err) {
    console.error(`Failed to copy ${src} -> ${dest}:`, err.message)
    process.exitCode = 1
  }
}

const functionsDir = path.resolve(__dirname, '..')
const projectRoot = path.resolve(functionsDir, '..')

// Copy .env
const srcEnv = path.join(projectRoot, '.env')
const destEnv = path.join(functionsDir, '.env')
if (fs.existsSync(srcEnv)) {
  safeCopy(srcEnv, destEnv)
} else {
  console.warn('.env not found in project root, skipping .env copy')
}

// Ensure external directory
const externalDir = path.join(functionsDir, 'external')
fs.mkdirSync(externalDir, { recursive: true })

const filesToCopy = ['poster.js', 'ai.js', 'helper.js']
filesToCopy.forEach((f) => {
  const src = path.join(projectRoot, f)
  const dest = path.join(externalDir, f)
  if (fs.existsSync(src)) safeCopy(src, dest)
  else console.warn(`${f} not found in project root, skipping`)
})

console.log('Copy script finished')
