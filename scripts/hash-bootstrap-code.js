const crypto = require('crypto')

const code = process.argv[2]
if (!code) {
  console.error('用法: node scripts/hash-bootstrap-code.js "你的部署口令"')
  process.exit(1)
}
console.log(crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex'))
