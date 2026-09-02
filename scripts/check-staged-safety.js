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
  '.css', '.example', '.html', '.js', '.json', '.md', '.mjs', '.cjs', '.ps1', '.sh', '.txt',
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
const environmentFilePath = /(^|\/)\.env(?:\..+)?$/i
const forbiddenPaths = [
  /(^|\/)project\.config\.json$/i,
  /(^|\/)project\.private\.config\.json$/i,
  /(^|\/)miniprogram\/config\.js$/i,
  /(^|\/)miniprogram\/config\.local\.js$/i,
  /(^|\/)\.cloudbaserc\.json$/i,
  environmentFilePath,
  /(^|\/)\.local(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)(?:local-data|private-data|user-data|exports|backups|uploads|health-photos|avatars|logs)(\/|$)/i,
  /(^|\/)[^/]*(?:secret|credentials)[^/]*\.json$/i,
  /\.(?:pem|key|p12|pfx|crt|cer|jks|keystore|db|db-journal|sqlite|sqlite3|dump|log|har)$/i,
]
const allowedEnvironmentExample = /(?:^|\/)\.env\.example$/i
const directSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bwx[a-zA-Z0-9]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[opurs]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b/,
  /\bOWNER_BOOTSTRAP_CODE_HASH\s*=\s*(?!YOUR_|<)[a-f0-9]{64}\b/i,
  /(^|[^A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])/,
]
const assignmentFieldKinds = new Map([
  ...[
    'MEALAILIVETESTKEY', 'OPENAIAPIKEY', 'AIAPIKEY', 'APIKEY', 'APPSECRET',
    'ACCESSTOKEN', 'REFRESHTOKEN', 'CLIENTSECRET', 'PRIVATEKEY',
    'AIPROVIDERHEADERVALUE', 'PASSWORD', 'PASSWD', 'PASSPHRASE',
  ].map((name) => [name, 'secret']),
  ...[
    'CLOUDENVID', 'CLOUDENVIRONMENTID', 'CLOUDENV', 'ENVID',
  ].map((name) => [name, 'cloud']),
  ...['OPENID', 'UNIONID', 'SESSIONKEY'].map((name) => [name, 'identity']),
])
const safePlaceholderValuesByName = new Map([
  ['AIAPIKEY', new Set(['YOUR_AI_API_KEY', 'YOUR_AI_KEY', 'TEST_PLACEHOLDER_ONLY'])],
  ['APIKEY', new Set(['YOUR_API_KEY', 'YOUR_KEY_VALUE', 'TEST_PLACEHOLDER_ONLY'])],
  ['APPSECRET', new Set(['YOUR_APP_SECRET', 'YOUR_APPSECRET'])],
  ['ACCESSTOKEN', new Set(['YOUR_ACCESS_TOKEN'])],
  ['REFRESHTOKEN', new Set(['YOUR_REFRESH_TOKEN'])],
  ['CLIENTSECRET', new Set(['YOUR_CLIENT_SECRET'])],
  ['PRIVATEKEY', new Set(['YOUR_PRIVATE_KEY'])],
  ['AIPROVIDERHEADERVALUE', new Set(['TEST_ATTACKER_VALUE'])],
  ['OPENID', new Set(['YOUR_OPENID'])],
  ['UNIONID', new Set(['YOUR_UNIONID'])],
  ['SESSIONKEY', new Set(['YOUR_SESSION_KEY'])],
  ...['CLOUDENVID', 'CLOUDENVIRONMENTID', 'CLOUDENV', 'ENVID']
    .map((name) => [name, new Set(['YOUR_CLOUD_ENV_ID'])]),
])
const quotedAssignmentField = /(['"`])([A-Za-z_][A-Za-z0-9 _-]{0,63})\1\s*\]?\s*(?::|=(?!=))\s*/g
const bareAssignmentField = /\b([A-Za-z_][A-Za-z0-9_]*)\b\s*\]?\s*(?::|=(?!=))\s*/g
const separatedAssignmentField = /\b((?:MEAL[ _-]*AI[ _-]*LIVE[ _-]*TEST[ _-]*KEY|OPENAI[ _-]*API[ _-]*KEY|AI[ _-]*API[ _-]*KEY|API[ _-]*KEY|APP[ _-]*SECRET|ACCESS[ _-]*TOKEN|REFRESH[ _-]*TOKEN|CLIENT[ _-]*SECRET|PRIVATE[ _-]*KEY|AI[ _-]*PROVIDER[ _-]*HEADER[ _-]*VALUE|CLOUD[ _-]*ENV(?:IRONMENT)?[ _-]*ID|CLOUD[ _-]*ENV|ENV[ _-]*ID|OPEN[ _-]*ID|UNION[ _-]*ID|SESSION[ _-]*KEY))\b\s*(?::|=(?!=))\s*/gi
const PERSONAL_RECORD_WINDOW = 900
const isoDateLiteral = /['"`](?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])['"`]/g
const weightLiteral = /(?:['"`])?(?:weightKg|weight_kg|weight)(?:['"`])?\s*:\s*(?:['"`])?(?:[2-9]\d|[1-3]\d{2})(?:\.\d{1,2})?(?:['"`])?/gi
const weightContainerLiteral = /(?:['"`])?(?:weightRecords|weight_records)(?:['"`])?\s*:\s*\[[\s\S]{0,900}?(?:['"`])?(?:weightKg|weight_kg|weight)(?:['"`])?\s*:\s*(?:['"`])?(?:[2-9]\d|[1-3]\d{2})(?:\.\d{1,2})?(?:['"`])?/gi
const exerciseDurationLiteral = /(?:['"`])?(?:durationMinutes|duration_minutes|exerciseMinutes|exercise_minutes)(?:['"`])?\s*:\s*(?:['"`])?(?:[1-9]\d{0,2})(?:['"`])?/gi
const exerciseLiteral = /(?:['"`])?exercise(?:['"`])?\s*:\s*\{[\s\S]{0,500}?(?:(?:['"`])?(?:durationMinutes|duration_minutes|exerciseMinutes|exercise_minutes)(?:['"`])?\s*:\s*(?:['"`])?[1-9]\d{0,2}(?:['"`])?|(?:['"`])?completed(?:['"`])?\s*:\s*true)/gi
const exerciseContainerLiteral = /(?:['"`])?(?:exerciseRecords|exercise_records|activityRecords|activity_records)(?:['"`])?\s*:\s*\[[\s\S]{0,900}?(?:['"`])?(?:durationMinutes|duration_minutes|exerciseMinutes|exercise_minutes)(?:['"`])?\s*:\s*(?:['"`])?[1-9]\d{0,2}(?:['"`])?/gi
const mealContainerLiteral = /(?:['"`])?(?:mealRecords|meal_records|dietRecords|diet_records|foodRecords|food_records|foodLogs|food_logs|dietLogs|diet_logs|consumptionRecords|consumption_records)(?:['"`])?\s*:\s*\[[\s\S]{0,900}?(?:['"`])?(?:mealType|meal_type|meal|food|foods|dish|dishes)(?:['"`])?\s*:\s*(?:['"`]|\[\s*['"`])/gi
const mealLogLiteral = /(?:['"`])?(?:actualMeal|actual_meal|mealLog|meal_log|foodLog|food_log|dietLog|diet_log|eatenFoods|eaten_foods|consumedFoods|consumed_foods|ate|eaten|consumed|实际餐食|饮食记录|餐食记录|吃了什么)(?:['"`])?\s*:\s*(?:['"`][^'"`\r\n]{1,160}['"`]|\[\s*['"`][^'"`\r\n]{1,160}['"`])/gi

function normalizedPath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function extension(file) {
  const name = normalizedPath(file).split('/').pop().toLowerCase()
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index) : ''
}

function safePlaceholder(value, name = '') {
  const normalized = String(value || '').trim()
  const allowed = safePlaceholderValuesByName.get(normalizedAssignmentName(name))
  return Boolean(allowed && allowed.has(normalized))
    || /^<[^<>\r\n]{1,80}>$/.test(normalized)
    || /^\$\{[A-Z][A-Z0-9_]{0,63}\}$/.test(normalized)
    || /^(?:process\.)?env\.[A-Z][A-Z0-9_]{0,63}$/.test(normalized)
}

function normalizedAssignmentName(name) {
  return String(name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function assignmentFieldKind(name) {
  const normalized = normalizedAssignmentName(name)
  const unprefixed = normalized.replace(/^(?:(?:TEST|MOCK|FAKE|EXAMPLE|PLACEHOLDER)+)/, '')
  const canonical = assignmentFieldKinds.has(normalized) ? normalized : unprefixed
  const kind = assignmentFieldKinds.get(canonical)
  return kind ? { canonical, kind } : null
}

function assignmentExpression(text, offset) {
  const source = String(text).slice(offset, offset + 8192)
  let quote = ''
  let escaped = false
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      const before = source.slice(0, index).trimEnd()
      if (character === '`' && before && !/(?:\|\||\?\?|[=?:([{,+\-*/])$/.test(before)) {
        return source.slice(0, index)
      }
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) return source.slice(0, index)
      depth -= 1
    } else if (depth === 0 && (character === ',' || character === ';')) return source.slice(0, index)
    else if (depth === 0 && (character === '\r' || character === '\n')) {
      const before = source.slice(0, index).trimEnd()
      const after = source.slice(index + 1).trimStart()
      const continues = !before
        || /(?:\|\||\?\?|[=?:([{,+\-*/])$/.test(before)
        || /^(?:\|\||\?\?|[?:.)\]])/.test(after)
      if (!continues) return source.slice(0, index)
    }
  }
  return source
}

function assignmentStarts(text) {
  const results = []
  const patterns = [quotedAssignmentField, bareAssignmentField, separatedAssignmentField]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text))) {
      const name = match[2] || match[1] || ''
      const normalized = normalizedAssignmentName(name)
      const field = assignmentFieldKind(normalized)
      const previous = String(text).slice(0, match.index).trimEnd().slice(-1)
      if (field && previous !== '?') {
        results.push({ name: field.canonical, kind: field.kind, offset: pattern.lastIndex })
      }
    }
  }
  return results.filter((entry, index, all) => all.findIndex((candidate) => (
    candidate.name === entry.name && candidate.offset === entry.offset
  )) === index)
}

function unsafeAssignmentReason(text) {
  for (const assignment of assignmentStarts(text)) {
    const { name, kind } = assignment
    const expression = assignmentExpression(text, assignment.offset).trim()
    if (!expression || expression.startsWith('{') || expression.startsWith('[')) continue
    const literalPattern = /(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g
    let literal
    let sawLiteral = false
    while ((literal = literalPattern.exec(expression))) {
      sawLiteral = true
      const value = String(literal[2] || '')
      const fieldReference = normalizedAssignmentName(value) === name
      const publicProtocolScalar = name === 'AIPROVIDERHEADERVALUE' && /^\d{1,3}$/.test(value)
      if (value && !fieldReference && !safePlaceholder(value, name) && !publicProtocolScalar) {
        if (kind !== 'identity' || /^[A-Za-z0-9_+/=-]{20,}$/.test(value)) {
          return kind === 'identity' ? '检测到疑似硬编码微信身份标识' : '检测到疑似真实密钥变量赋值'
        }
      }
    }
    const scalar = expression.match(/^([^\s,;}]+)/)
    if (!sawLiteral && scalar) {
      const value = scalar[1]
      const environmentReference = /^(?:process\.)?env\.[A-Z][A-Z0-9_]*$/i.test(value)
      const sameFieldReference = normalizedAssignmentName(value) === name
      const shortDynamicReference = /^(?:[a-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)
        && value.length <= 20
      const safeReference = /^(?:null|undefined)$/.test(value)
        || environmentReference
        || sameFieldReference
        || shortDynamicReference
      const publicProtocolScalar = name === 'AIPROVIDERHEADERVALUE' && /^\d{1,3}$/.test(value)
      if (!safeReference && !safePlaceholder(value, name) && !publicProtocolScalar
        && (/^[+-]?\d/.test(value) || /^[A-Za-z0-9_+/-]{12,}$/.test(value))) {
        return kind === 'identity' ? '检测到疑似硬编码微信身份标识' : '检测到疑似真实密钥变量赋值'
      }
    }
  }
  return ''
}

function patternMatches(pattern, text) {
  pattern.lastIndex = 0
  const matches = []
  let match
  while ((match = pattern.exec(text))) {
    matches.push({ index: match.index, length: match[0].length })
    if (!match[0].length) pattern.lastIndex += 1
  }
  return matches
}

function nearbyRecordSignals(text, leftPattern, rightPattern) {
  const left = patternMatches(leftPattern, text)
  const right = patternMatches(rightPattern, text)
  return left.some((first) => right.some((second) => {
    const firstEnd = first.index + first.length
    const secondEnd = second.index + second.length
    return Math.max(first.index, second.index) - Math.min(firstEnd, secondEnd) <= PERSONAL_RECORD_WINDOW
  }))
}

function isSyntheticFixture(file, text) {
  const normalized = normalizedPath(file).toLowerCase()
  const basename = normalized.split('/').pop()
  const conventionalTest = /(?:^|[.-])test(?:[.-]|$)/.test(basename)
    || /\.spec\.[cm]?js$/.test(basename)
  const validationFixture = normalized === 'scripts/validate.js'
    || normalized === 'scripts/wx-automator/visual-regression.js'
  const explicitFixture = /@synthetic-fixture\b|\bsynthetic[ _-]fixture\b|明确合成测试(?:数据|夹具)?/i.test(text)
  const fixturePath = /(?:^|\/)scripts\/(?:fixtures?|test-data|synthetic)(?:\/|[._-])/.test(normalized)
  return conventionalTest || validationFixture || (fixturePath && explicitFixture)
}

function personalDataReason(file, text) {
  const source = String(text || '')
  const containsPrivateRecord = patternMatches(weightContainerLiteral, source).length > 0
    || patternMatches(exerciseContainerLiteral, source).length > 0
    || patternMatches(mealContainerLiteral, source).length > 0
    || nearbyRecordSignals(source, isoDateLiteral, weightLiteral)
    || nearbyRecordSignals(source, isoDateLiteral, exerciseLiteral)
    || nearbyRecordSignals(source, isoDateLiteral, exerciseDurationLiteral)
    || nearbyRecordSignals(source, isoDateLiteral, mealLogLiteral)
  if (!containsPrivateRecord || isSyntheticFixture(file, source)) return ''
  return '检测到疑似真实个人体重、运动或饮食记录'
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
  for (const pattern of forbiddenPaths) {
    if (pattern.test(normalized)) {
      const environmentExample = pattern === environmentFilePath && allowedEnvironmentExample.test(normalized)
      if (!environmentExample) return '本机配置、密钥文件或个人数据目录禁止提交'
    }
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
  return unsafeAssignmentReason(text)
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
  const text = content.toString('utf8')
  return secretReason(text) || personalDataReason(file, text)
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
