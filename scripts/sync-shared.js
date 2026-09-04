'use strict'

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const cliArgs = process.argv.slice(2)
const checkOnly = cliArgs.includes('--check')
if (cliArgs.some((argument) => argument !== '--check')) {
  throw new Error('仅支持 --check 参数')
}
const copies = [
  ['shared/user-state.js', 'miniprogram/services/user-state-core.js'],
  ['shared/user-state.js', 'cloudfunctions/userData/user-state.js'],
  ['shared/user-state.js', 'cloudfunctions/aiPlanner/user-state.js'],
  ['shared/image-file.js', 'cloudfunctions/auth/image-file.js'],
  ['shared/image-file.js', 'cloudfunctions/health/image-file.js'],
  ['shared/image-source.js', 'cloudfunctions/auth/image-source.js'],
  ['shared/image-source.js', 'cloudfunctions/health/image-source.js'],
  ['shared/upload-ticket.js', 'cloudfunctions/auth/upload-ticket.js'],
  ['shared/upload-ticket.js', 'cloudfunctions/health/upload-ticket.js'],
  ['shared/upload-ticket.js', 'cloudfunctions/privacy/upload-ticket.js'],
  ['miniprogram/data/meal-plan.js', 'cloudfunctions/userData/legacy-plan.js'],
  ['cloudfunctions/membership/core.js', 'cloudfunctions/privacy/membership-core.js'],
]

copies.forEach(([source, destination]) => {
  const sourcePath = path.join(root, source)
  const destinationPath = path.join(root, destination)
  if (checkOnly) {
    if (!fs.existsSync(destinationPath) || !fs.readFileSync(sourcePath).equals(fs.readFileSync(destinationPath))) {
      throw new Error(`${destination} 与 ${source} 不一致，请先运行 node scripts/sync-shared.js`)
    }
    return
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.copyFileSync(sourcePath, destinationPath)
})

console.log(checkOnly ? `共享副本检查通过：${copies.length} 个部署副本一致。` : `已同步 ${copies.length} 个部署副本。`)
