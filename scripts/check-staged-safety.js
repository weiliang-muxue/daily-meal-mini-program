const { execFileSync } = require('child_process')

const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
const files = output.toString('utf8').split('\0').filter(Boolean)
const errors = []

const forbiddenPaths = [
  /(^|\/)project\.config\.json$/i,
  /(^|\/)project\.private\.config\.json$/i,
  /(^|\/)miniprogram\/config\.js$/i,
  /(^|\/)\.env(?:\..+)?$/i,
  /(^|\/)(?:local-data|private-data|user-data|exports|backups|uploads|health-photos|avatars)(\/|$)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|db|sqlite3?|dump)$/i,
]

const allowedExamples = /(?:\.example(?:\.[^/]+)?|\.env\.example)$/i
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bwx[a-zA-Z0-9]{16}\b/,
  /\b(?:AppSecret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"](?!YOUR_|PLACEHOLDER|<)[^'"\r\n]{8,}['"]/i,
  /\bOWNER_BOOTSTRAP_CODE_HASH\s*=\s*(?!YOUR_|<)[a-f0-9]{64}\b/i,
]

for (const file of files) {
  if (!allowedExamples.test(file) && forbiddenPaths.some(pattern => pattern.test(file))) {
    errors.push(`${file}: 本机配置、密钥文件或个人数据目录禁止提交`)
    continue
  }

  let content
  try {
    content = execFileSync('git', ['show', `:${file}`], { maxBuffer: 8 * 1024 * 1024 })
  } catch (_) {
    continue
  }
  if (content.includes(0)) continue
  const text = content.toString('utf8')
  if (!allowedExamples.test(file) && secretPatterns.some(pattern => pattern.test(text))) {
    errors.push(`${file}: 检测到疑似真实密钥、AppID 或私钥`)
  }
}

if (errors.length) {
  console.error('提交已阻止：检测到不能进入 GitHub 的内容：')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`提交安全检查通过：已检查 ${files.length} 个暂存文件。`)
