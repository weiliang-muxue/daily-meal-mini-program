'use strict'

const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ZERO_OID = /^0+$/
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024
const REGULAR_FILE_MODES = new Set(['100644', '100755'])
const TEXT_BASENAMES = new Set([
  '.gitignore', '.gitattributes', 'license', 'license.txt', 'notice', 'notice.txt',
])
const TEXT_PATH_ALLOWLIST = new Set(['.githooks/pre-commit', '.githooks/pre-push'])
const ROOT_TEXT_ALLOWLIST = new Set([
  '.gitignore', '.gitattributes', '.env.example',
  'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md',
  'LICENSE', 'LICENSE.txt', 'NOTICE', 'NOTICE.txt',
  'database.indexes.json', 'database.rules.json', 'storage.rules.json', 'release-manifest.json',
  'project.config.example.json', 'project.private.config.example.json',
])
const TEXT_DIRECTORY_ALLOWLIST = [
  '.github/', '.githooks/', 'cloudfunctions/', 'docs/', 'miniprogram/', 'scripts/', 'shared/', 'tools/',
]
const TEXT_EXTENSIONS = new Set([
  '.css', '.example', '.html', '.js', '.json', '.md', '.mjs', '.cjs', '.sh', '.txt',
  '.wxml', '.wxss', '.yaml', '.yml',
])
const ASSET_ALLOWLIST = Object.freeze({
  'source-assets/meal-plan-gpt-image-2.png': Object.freeze({
    maxBytes: 3 * 1024 * 1024,
    sha256: '71ff710cb6577f2bc48c168176ef113dc21f40bbce3ce32d66d104778571f927',
    signature: Buffer.from('89504e470d0a1a0a', 'hex'),
  }),
  'miniprogram/assets/meal-plan-cover.jpg': Object.freeze({
    maxBytes: 256 * 1024,
    sha256: '29aea82c675c55ae70c58667030445f676e873c721f04dff3bfc7046c8200024',
    signature: Buffer.from('ffd8ff', 'hex'),
  }),
})
const forbiddenPaths = [
  /(^|\/)project\.config\.json$/i,
  /(^|\/)project\.private\.config\.json$/i,
  /(^|\/)miniprogram\/config\.js$/i,
  /(^|\/)miniprogram\/config\.local\.js$/i,
  /(^|\/)\.cloudbaserc\.json$/i,
  /(^|\/)\.env(?:\..+)?$/i,
  /(^|\/)\.local(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)(?:local-data|private-data|user-data|exports|backups|uploads|health-photos|avatars|logs)(\/|$)/i,
  /(^|\/)[^/]*(?:secret|credentials)[^/]*\.json$/i,
  /\.(?:pem|key|p12|pfx|crt|cer|jks|keystore|db|db-journal|sqlite|sqlite3|dump|log|har)$/i,
]
const allowedExamples = /(?:\.example(?:\.[^/]+)?|\.env\.example)$/i
const directSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bwx[a-zA-Z0-9]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[opurs]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b/,
  /\bOWNER_BOOTSTRAP_CODE_HASH\s*=\s*(?!YOUR_|<)[a-f0-9]{64}\b/i,
]
const sensitiveAssignment = /\b(OPENAI_API_KEY|AI_API_KEY|API_KEY|APPSECRET|APP_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PRIVATE_KEY|AI_PROVIDER_HEADER_VALUE|PASSWORD|PASSWD|PASSPHRASE)\b\s*[:=]\s*['"]?([^\s'",}#;]+)/gi
const identityAssignment = /\b(_?OPENID|UNIONID|SESSION_KEY)\b\s*[:=]\s*['"]?([A-Za-z0-9_/-]{20,})/gi
const safeValuePrefixes = ['YOUR_', 'PLACEHOLDER', 'TEST_', 'EXAMPLE_', 'MOCK_', 'FAKE_', '<', '${', 'process.env', 'env.']

function normalizedPath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function extension(file) {
  const name = normalizedPath(file).split('/').pop().toLowerCase()
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index) : ''
}

function safePlaceholder(value) {
  return safeValuePrefixes.some((prefix) => value.toUpperCase().startsWith(prefix.toUpperCase()))
}

function pathReason(file) {
  const normalized = normalizedPath(file)
  if (
    !normalized
    || normalized.includes('\0')
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || /(^|\/)\.\.(\/|$)/.test(normalized)
  ) return '文件路径无效'
  if (!allowedExamples.test(normalized) && forbiddenPaths.some((pattern) => pattern.test(normalized))) {
    return '本机配置、密钥文件或个人数据目录禁止提交'
  }
  if (Object.prototype.hasOwnProperty.call(ASSET_ALLOWLIST, normalized)) return ''
  if (!ROOT_TEXT_ALLOWLIST.has(normalized) && !TEXT_DIRECTORY_ALLOWLIST.some((prefix) => normalized.startsWith(prefix))) {
    return '文件路径不在公开源码目录白名单'
  }
  if (TEXT_PATH_ALLOWLIST.has(normalized)) return ''
  const basename = normalized.split('/').pop().toLowerCase()
  if (!TEXT_BASENAMES.has(basename) && !TEXT_EXTENSIONS.has(extension(normalized))) {
    return '文件类型不在公开文本源码白名单，二进制与用户媒体禁止提交'
  }
  return ''
}

function secretReason(text) {
  if (directSecretPatterns.some((pattern) => pattern.test(text))) return '检测到疑似真实密钥、AppID 或私钥'
  for (const pattern of [sensitiveAssignment, identityAssignment]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text))) {
      const name = String(match[1] || '').toUpperCase()
      const value = String(match[2] || '')
      const publicProtocolScalar = name === 'AI_PROVIDER_HEADER_VALUE' && /^\d{1,3}$/.test(value)
      if (value && !safePlaceholder(value) && !publicProtocolScalar) {
        return pattern === identityAssignment ? '检测到疑似硬编码微信身份标识' : '检测到疑似真实密钥变量赋值'
      }
    }
  }
  return ''
}

function validUtf8(content) {
  if (content.includes(0)) return false
  const decoded = content.toString('utf8')
  return !decoded.includes('\ufffd') && Buffer.from(decoded, 'utf8').equals(content)
}

function blobReason(file, content) {
  const pathError = pathReason(file)
  if (pathError) return pathError
  const normalized = normalizedPath(file)
  const asset = ASSET_ALLOWLIST[normalized]
  if (asset) {
    if (content.length > asset.maxBytes) return '许可视觉素材超过大小上限'
    if (!content.subarray(0, asset.signature.length).equals(asset.signature)) return '许可视觉素材的文件签名无效'
    const digest = crypto.createHash('sha256').update(content).digest('hex')
    if (digest !== asset.sha256) return '许可视觉素材内容与仓库基线不一致'
    return ''
  }
  if (content.length > MAX_TEXT_BYTES) return '公开文本源码超过大小上限'
  if (!validUtf8(content)) return '公开文本源码必须是有效 UTF-8 且不能包含二进制内容'
  return secretReason(content.toString('utf8'))
}

function metadataReason(text) {
  const value = String(text || '')
  if (Buffer.byteLength(value, 'utf8') > MAX_METADATA_BYTES) return 'Git 元数据超过大小上限'
  return secretReason(value)
}

function refReason(ref) {
  const value = String(ref || '')
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.endsWith('/')) {
    return '待推送 ref 名称无效或不在公开分支/Tag 范围'
  }
  return metadataReason(value)
}

function git(args, options = {}) {
  return execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024, ...options })
}

function indexEntries() {
  return git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map((record) => {
    const match = record.match(/^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/)
    if (!match) return { file: record, mode: '', objectId: '', stage: -1 }
    return { mode: match[1], objectId: match[2], stage: Number(match[3]), file: match[4] }
  })
}

function gitEntryReason(mode, type = 'blob', stage = 0) {
  if (stage !== 0) return '暂存索引存在未解决的合并阶段'
  if (type !== 'blob' || !REGULAR_FILE_MODES.has(mode)) {
    return '符号链接、Git 子模块或特殊文件禁止提交'
  }
  return ''
}

function inspectBlob(file, content, errors, label = '') {
  const reason = blobReason(file, content)
  if (reason) errors.push(`${label}${file}: ${reason}`)
}

function checkIndex() {
  const entries = indexEntries()
  const files = [...new Set(entries.map((entry) => entry.file))]
  const errors = []
  for (const entry of entries) {
    const { file } = entry
    const entryError = gitEntryReason(entry.mode, 'blob', entry.stage)
    if (entryError) {
      errors.push(`${file}: ${entryError}`)
      continue
    }
    let content
    try {
      content = git(['show', `:${file}`])
    } catch (_) {
      errors.push(`${file}: 无法读取暂存文件内容`)
      continue
    }
    inspectBlob(file, content, errors)
  }
  return { files, commits: [], refs: [], errors }
}

function checkWorktree() {
  const root = path.resolve(git(['rev-parse', '--show-toplevel']).toString('utf8').trim())
  const entries = indexEntries()
  const entriesByFile = new Map()
  for (const entry of entries) {
    const current = entriesByFile.get(entry.file) || []
    current.push(entry)
    entriesByFile.set(entry.file, current)
  }
  const candidates = [...new Set(
    git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .toString('utf8').split('\0').filter(Boolean),
  )]
  const files = []
  const errors = []
  const rootPrefix = `${root}${path.sep}`.toLowerCase()
  for (const file of candidates) {
    const pathError = pathReason(file)
    if (pathError) {
      errors.push(`${file}: ${pathError}`)
      continue
    }
    const trackedEntries = entriesByFile.get(file) || []
    const entryError = trackedEntries.map((entry) => gitEntryReason(entry.mode, 'blob', entry.stage)).find(Boolean)
    if (entryError) {
      errors.push(`${file}: ${entryError}`)
      continue
    }
    const absolute = path.resolve(root, normalizedPath(file))
    if (!absolute.toLowerCase().startsWith(rootPrefix)) {
      errors.push(`${file}: 文件路径超出仓库根目录`)
      continue
    }
    let stat
    try {
      stat = fs.lstatSync(absolute)
    } catch (error) {
      if (error && error.code === 'ENOENT' && trackedEntries.length) continue
      errors.push(`${file}: 无法读取公开候选文件`)
      continue
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      errors.push(`${file}: 符号链接、Git 子模块或特殊文件禁止提交`)
      continue
    }
    let content
    try {
      content = fs.readFileSync(absolute)
    } catch (_) {
      errors.push(`${file}: 无法读取公开候选文件`)
      continue
    }
    files.push(file)
    inspectBlob(file, content, errors)
  }
  return { files, commits: [], refs: [], errors }
}

function objectType(objectId) {
  try {
    return git(['cat-file', '-t', objectId]).toString('utf8').trim()
  } catch (_) {
    return ''
  }
}

function peelCommit(objectId) {
  try {
    return git(['rev-parse', '--verify', `${objectId}^{commit}`]).toString('utf8').trim()
  } catch (_) {
    return ''
  }
}

function commitList(base, head) {
  const target = peelCommit(head || 'HEAD')
  if (!target) return []
  if (!base || ZERO_OID.test(base)) return git(['rev-list', '--reverse', target]).toString('utf8').trim().split(/\r?\n/).filter(Boolean)
  const baseCommit = peelCommit(base)
  if (!baseCommit) return git(['rev-list', '--reverse', target]).toString('utf8').trim().split(/\r?\n/).filter(Boolean)
  return git(['rev-list', '--reverse', `${baseCommit}..${target}`]).toString('utf8').trim().split(/\r?\n/).filter(Boolean)
}

function checkCommitMetadata(commit, errors) {
  try {
    const message = git(['show', '-s', '--format=%B', commit]).toString('utf8')
    const reason = metadataReason(message)
    if (reason) errors.push(`${commit.slice(0, 12)}:commit-message: ${reason}`)
  } catch (_) {
    errors.push(`${commit.slice(0, 12)}:commit-message: 无法读取提交说明`)
  }
}

function checkCommitTree(commit, errors, inspected) {
  const records = git(['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)
  for (const record of records) {
    const match = record.match(/^(\d{6})\s+(\w+)\s+([a-f0-9]+)\t([\s\S]+)$/)
    if (!match) continue
    const [, mode, type, objectId, file] = match
    const entryError = gitEntryReason(mode, type)
    if (entryError) {
      errors.push(`${commit.slice(0, 12)}:${file}: ${entryError}`)
      continue
    }
    const key = `${objectId}\0${file}`
    if (inspected.has(key)) continue
    inspected.add(key)
    let content
    try {
      content = git(['cat-file', 'blob', objectId])
    } catch (_) {
      errors.push(`${commit.slice(0, 12)}:${file}: 无法读取 Git 对象`)
      continue
    }
    inspectBlob(file, content, errors, `${commit.slice(0, 12)}:`)
  }
}

function tagAnnotation(objectId) {
  if (objectType(objectId) !== 'tag') return ''
  const raw = git(['cat-file', '-p', objectId]).toString('utf8')
  const separator = raw.indexOf('\n\n')
  return separator < 0 ? '' : raw.slice(separator + 2)
}

function checkRange(base, head, options = {}) {
  const errors = []
  const inspected = new Set()
  const refs = []
  const ref = options.ref || ''
  if (ref) {
    refs.push(ref)
    const reason = refReason(ref)
    if (reason) errors.push(`${ref}: ${reason}`)
  }
  const targetType = objectType(head || 'HEAD')
  if (!targetType) errors.push(`${ref || 'HEAD'}: 无法解析待推送对象`)
  if (ref.startsWith('refs/heads/') && targetType && targetType !== 'commit') {
    errors.push(`${ref}: Branch 必须直接指向 commit 对象`)
  }
  if (targetType === 'tag') {
    const reason = metadataReason(tagAnnotation(head))
    if (reason) errors.push(`${ref || String(head).slice(0, 12)}:tag-annotation: ${reason}`)
  } else if (targetType && targetType !== 'commit') {
    errors.push(`${ref || String(head).slice(0, 12)}: 不允许推送非 commit/tag 对象`)
  }

  let commits = commitList(base, head)
  const targetCommit = peelCommit(head || 'HEAD')
  if (targetCommit && !commits.includes(targetCommit)) commits = [...commits, targetCommit]
  commits = [...new Set(commits)]
  for (const commit of commits) {
    checkCommitMetadata(commit, errors)
    checkCommitTree(commit, errors, inspected)
  }
  return { files: [...inspected], commits, refs, errors }
}

function parsePushLines(input) {
  return String(input || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 4) return { error: 'pre-push 输入格式无效' }
    return { localRef: fields[0], localOid: fields[1], remoteRef: fields[2], remoteOid: fields[3] }
  })
}

function checkPushInput(input) {
  const errors = []
  const files = new Set()
  const commits = new Set()
  const refs = []
  for (const update of parsePushLines(input)) {
    if (update.error) {
      errors.push(update.error)
      continue
    }
    if (ZERO_OID.test(update.localOid)) continue
    const result = checkRange(update.remoteOid, update.localOid, { ref: update.remoteRef })
    result.files.forEach((file) => files.add(file))
    result.commits.forEach((commit) => commits.add(commit))
    result.refs.forEach((ref) => refs.push(ref))
    errors.push(...result.errors)
  }
  return { files: [...files], commits: [...commits], refs, errors }
}

function printResult(result, scope) {
  if (result.errors.length) {
    console.error('公开仓库安全检查未通过：')
    result.errors.forEach((error) => console.error(`- ${error}`))
    process.exitCode = 1
    return
  }
  const commitText = result.commits.length ? `、${result.commits.length} 个提交` : ''
  const refText = result.refs.length ? `、${result.refs.length} 个 ref` : ''
  console.log(`公开仓库安全检查通过：已检查${scope}${commitText}${refText}及 ${result.files.length} 个文件版本。`)
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args[0] === '--range') printResult(checkRange(args[1], args[2] || 'HEAD', { ref: args[3] || '' }), '待推送历史')
  else if (args[0] === '--pre-push') {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { input += chunk })
    process.stdin.on('end', () => printResult(checkPushInput(input), '待推送更新'))
  } else if (args[0] === '--worktree') printResult(checkWorktree(), '公开工作树候选')
  else if (!args.length || args[0] === '--staged') printResult(checkIndex(), '暂存索引')
  else {
    console.error('用法：node scripts/check-staged-safety.js [--staged | --worktree | --range <base> <head> [ref] | --pre-push]')
    process.exitCode = 2
  }
}

module.exports = {
  ASSET_ALLOWLIST,
  MAX_TEXT_BYTES,
  pathReason,
  secretReason,
  blobReason,
  metadataReason,
  refReason,
  checkIndex,
  checkWorktree,
  checkRange,
  checkPushInput,
  commitList,
}
