'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const {
  ASSET_ALLOWLIST,
  REVIEWED_HISTORICAL_ASSIGNMENT_ALLOWLIST,
  MAX_TEXT_BYTES,
  pathReason,
  secretReason,
  dotenvAssignmentReason,
  reviewedHistoricalAssignment,
  blobReason,
  metadataReason,
  refReason,
  checkIndex,
  checkWorktree,
  checkRange,
  checkPushInput,
  policyIsolationReason,
  SECURITY_TRUST_ROOT_PATHS,
} = require('./check-staged-safety')

const root = path.resolve(__dirname, '..')
const zeroOid = '0'.repeat(40)
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const write = (cwd, file, content) => {
  const target = path.join(cwd, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
const commit = (cwd, message) => {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}
const initRepo = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-public-gate-'))
  git(cwd, ['init', '-q'])
  git(cwd, ['config', 'user.name', 'Safety Test'])
  git(cwd, ['config', 'user.email', 'safety-test@example.invalid'])
  write(cwd, '.gitignore', '.local/\n*.log\n')
  write(cwd, 'scripts/app.js', "module.exports = 'public'\n")
  commit(cwd, 'test: public baseline')
  return cwd
}
const hasError = (result, fragment) => result.errors.some((error) => error.includes(fragment))

;[
  'project.config.json', 'project.private.config.json', 'miniprogram/config.js',
  'miniprogram/config.local.js', '.cloudbaserc.json', '.env', '.local/state.json',
  'node_modules/pkg/index.js',
  'private-data/profile.json', 'exports/meal.csv', 'logs/request.txt',
  'private-data/.env.example', 'cloudfunctions/private-data/.env.example',
  'config.credentials.json', 'config.credentials.example.json',
  'cloudfunctions/aiPlanner/credentials.example.json',
  'cert.pem', 'cache.db', 'trace.log', 'request.har',
].forEach((file) => assert(pathReason(file), `${file} 必须被路径门禁拒绝`))
;[
  '.gitignore', 'README.md', 'scripts/app.js', 'scripts/deploy-production-function.ps1', 'docs/DEPLOY.md',
  'miniprogram/app.json', '.github/workflows/validate.yml',
  'cloudfunctions/aiPlanner/.env.example', 'cloudfunctions/auth/package-lock.json',
  'project.config.example.json',
].forEach((file) => assert.strictEqual(pathReason(file), '', `${file} 应属于公开文本白名单`))

;['photo.jpg', 'image.png', 'bundle.zip', 'guide.pdf', 'state.db', 'run.log', 'request.har']
  .forEach((file) => assert(blobReason(`scripts/${file}`, Buffer.from('public')), `${file} 必须默认拒绝`))

for (const [file, policy] of Object.entries(ASSET_ALLOWLIST)) {
  const source = fs.readFileSync(path.join(root, file))
  assert.strictEqual(blobReason(file, source), '', `${file} 真实素材应通过`)
  const changed = Buffer.from(source)
  changed[changed.length - 1] ^= 1
  assert(blobReason(file, changed).includes('基线'), `${file} 同路径替换内容必须失败`)
  assert(blobReason(file, Buffer.from('not-an-image')).includes('签名'), `${file} 错误签名必须失败`)
  const oversized = Buffer.concat([policy.signature, Buffer.alloc(policy.maxBytes + 1)])
  assert(blobReason(file, oversized).includes('大小'), `${file} 超限必须失败`)
}

assert(blobReason('scripts/nul.js', Buffer.from([65, 0, 66])).includes('UTF-8'))
assert(blobReason('scripts/invalid.js', Buffer.from([0xff])).includes('UTF-8'))
assert(blobReason('scripts/large.js', Buffer.alloc(MAX_TEXT_BYTES + 1, 65)).includes('大小'))

const keyName = ['API', 'KEY'].join('_')
const headerName = ['AI', 'PROVIDER', 'HEADER', 'VALUE'].join('_')
const identityName = ['OPEN', 'ID'].join('')
const passwordName = ['PASS', 'WORD'].join('')
const cloudEnvironmentName = ['cloud', 'Env', 'Id'].join('')
const aiKeyName = ['AI', 'API', 'KEY'].join('_')
const appSecretName = ['App', 'Secret'].join('')
const accessTokenName = ['access', 'Token'].join('')
const privateKeyName = ['private', 'key'].join('_')
const sessionKeyName = ['session', 'key'].join('_')
const unionIdName = ['union', 'id'].join('')
const fixtureValue = ['live', 'credential', 'value', '123456789'].join('_')
assert(secretReason(`${keyName}=${fixtureValue}`))
assert(secretReason(`${passwordName}:${fixtureValue}`))
assert(secretReason(`${identityName}=${'user'.repeat(7)}`))
assert(secretReason(`${cloudEnvironmentName}='cloud1-production-example'`))
assert(secretReason(`phone=${['138', '0000', '0000'].join('')}`))
assert(secretReason(['sk', 'abcdefghijklmnopqrstuvwx'].join('-')))
assert(secretReason(['wx', '1234567890abcdef'].join('')))
assert.strictEqual(secretReason(`${keyName}=YOUR_KEY_VALUE`), '')
assert.strictEqual(secretReason(`${keyName}=TEST_PLACEHOLDER_ONLY`), '')
assert(secretReason(`${keyName}=YOUR_AI_API_KEY`), '占位符只能用于对应变量名')
assert(secretReason(`${aiKeyName}=YOUR_KEY_VALUE`), '占位符不能跨变量复用')
for (const prefix of ['TEST', 'MOCK', 'FAKE', 'EXAMPLE', 'PLACEHOLDER', 'YOUR']) {
  const disguised = [prefix, 'actual', 'private', 'credential', '123456789'].join('_')
  assert(secretReason(`${keyName}=${disguised}`), `${disguised} 不能仅凭前缀绕过密钥扫描`)
  assert(secretReason(`${appSecretName}=${disguised}`), `${disguised} 不能绕过 AppSecret 扫描`)
}
for (const prefix of ['TEST', 'MOCK', 'FAKE', 'EXAMPLE', 'PLACEHOLDER']) {
  assert(secretReason(`${prefix}_${keyName}=${fixtureValue}`), `${prefix}_ 前缀不能绕过 API Key 扫描`)
  assert(secretReason(`{ "${prefix}_${appSecretName}": "${fixtureValue}" }`),
    `${prefix}_ 前缀不能绕过带引号的 AppSecret 扫描`)
}
const liveTestKeyName = ['MEAL', 'AI', 'LIVE', 'TEST', 'KEY'].join('_')
assert(secretReason(`${liveTestKeyName}=${fixtureValue}`))
assert(secretReason(`${aiKeyName} = process.env.${aiKeyName} || '${fixtureValue}'`))
assert(secretReason(`${aiKeyName}: process.env.${aiKeyName} ?? "${fixtureValue}"`))
assert(secretReason(`${aiKeyName} = enabled ? process.env.${aiKeyName} : '${fixtureValue}'`))
assert(secretReason(`settings.${aiKeyName} = settings.${aiKeyName} || '${fixtureValue}'`))
assert(secretReason(`{ ${aiKeyName}: settings.${aiKeyName} ?? '${fixtureValue}' }`))
assert.strictEqual(secretReason(`${aiKeyName} = process.env.${aiKeyName}`), '')
assert.strictEqual(secretReason(`${aiKeyName} = process.env.${aiKeyName} || 'YOUR_AI_KEY'`), '')
assert.strictEqual(secretReason(`${aiKeyName} = process.env.${aiKeyName} || ''`), '')
assert.strictEqual(secretReason(`${cloudEnvironmentName}='YOUR_CLOUD_ENV_ID'`), '')
assert(secretReason(`${cloudEnvironmentName}='TEST_PLACEHOLDER_ONLY'`), '测试占位符不能跨变量复用')
assert(secretReason(`${cloudEnvironmentName} = process.env.CLOUD_ENV_ID || 'cloud1-production-example'`))
assert(secretReason(`{ ${cloudEnvironmentName}: settings.${cloudEnvironmentName} ?? 'cloud1-production-example' }`))
assert.strictEqual(secretReason("const env = cloudEnvId && cloudEnvId ? cloudEnvId : undefined"), '')
assert.strictEqual(secretReason(`${headerName}: 10`), '')
assert.strictEqual(secretReason(`${headerName}: TEST_ATTACKER_VALUE`), '')
assert(secretReason(`${keyName}=TEST_ATTACKER_VALUE`), '公开请求头测试值不能作为 API Key 占位符')
assert(secretReason(`${headerName}: ${fixtureValue}`))
assert(secretReason(
  `${aiKeyName}=${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')}`,
  { skipUnsafeAssignment: true },
), '历史占位赋值豁免不能绕过直接 Key 特征检查')
for (const source of [
  `${keyName}=abcdefghijklmnop`,
  `${passwordName}=secret123456789`,
  `${accessTokenName.toUpperCase()}=abcdefghijklmnopqrst`,
  `${headerName}=abcdefghijklmnop`,
]) {
  assert(dotenvAssignmentReason('cloudfunctions/example/.env.example', source),
    `.env.example 不能把裸短值误判为 JavaScript 标识符：${source.split('=')[0]}`)
  assert(blobReason('cloudfunctions/example/.env.example', Buffer.from(`${source}\n`)),
    `.env.example 的敏感字段裸短值必须被拒绝：${source.split('=')[0]}`)
}
assert.strictEqual(
  blobReason('cloudfunctions/example/.env.example', Buffer.from(`${keyName}=YOUR_API_KEY\n`)),
  '',
  '.env.example 仍须允许字段对应的精确安全占位符',
)
assert.strictEqual(
  blobReason('cloudfunctions/example/.env.example', Buffer.from([aiKeyName, '=${', aiKeyName, '}\n'].join(''))),
  '',
  '.env.example 仍须允许明确的环境变量引用',
)
for (const source of [
  ['const ', aiKeyName, ' = process.env.', aiKeyName].join(''),
  ['const ', keyName, ' = runtimeApiKey'].join(''),
]) assert.strictEqual(blobReason('scripts/provider.js', Buffer.from(`${source}\n`)), '',
  `JavaScript 动态标识符引用不能因 dotenv 限制而回归：${source}`)
for (const source of [
  `{ "${aiKeyName}": "${fixtureValue}" }`,
  `{ '${keyName}': '${fixtureValue}' }`,
  `{ "${appSecretName}": "${fixtureValue}" }`,
  `{ "${accessTokenName}": "${fixtureValue}" }`,
  `{ "${privateKeyName}": "${fixtureValue}" }`,
  `{ "${cloudEnvironmentName}": "cloud1-production-example" }`,
  `{ "${identityName}": "${'identity'.repeat(4)}" }`,
  `{ "${unionIdName}": "${'union'.repeat(6)}" }`,
  `{ "${sessionKeyName}": "${'session'.repeat(5)}" }`,
  `settings['${aiKeyName}'] = '${fixtureValue}'`,
  `settings["${appSecretName}"] = "${fixtureValue}"`,
]) assert(secretReason(source), `带引号或方括号的敏感赋值必须被拒绝：${source.slice(0, 32)}`)
assert.strictEqual(secretReason(`{ "${aiKeyName}": "YOUR_AI_API_KEY" }`), '')
assert.strictEqual(secretReason(`{ "${appSecretName}": "YOUR_APP_SECRET" }`), '')
assert.strictEqual(secretReason(`{ "${identityName}": "YOUR_OPENID" }`), '')
assert.strictEqual(secretReason(`const value = enabled ? ${identityName} : undefined`), '')
assert.strictEqual(secretReason(`const recordId = ${identityName}:YYYY-MM-DD`), '')
assert.strictEqual(secretReason(`{ ${aiKeyName}: privateApiKey }`), '')
assert(metadataReason(`${keyName}=${fixtureValue}`))
assert(refReason(`refs/heads/${fixtureValue}/${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')}`))
assert.strictEqual(refReason('refs/heads/v0.2.0'), '')
assert.strictEqual(refReason('refs/tags/v0.2.0'), '')
assert(refReason('refs/pull/1/merge'))
assert.strictEqual(policyIsolationReason([
  'scripts/check-staged-safety.js',
  'scripts/check-staged-safety.test.js',
]), '', '扫描器与其行为测试可以作为独立安全策略变更')
assert(policyIsolationReason([
  'scripts/check-staged-safety.js',
  'miniprogram/app.js',
]).includes('独立策略变更'), '扫描器与业务代码同批变更必须失败关闭')
for (const trustRoot of SECURITY_TRUST_ROOT_PATHS) {
  assert(policyIsolationReason([
    trustRoot,
    'miniprogram/app.js',
  ]).includes('独立策略变更'), `${trustRoot} 与业务代码同批变更必须失败关闭`)
}
assert.strictEqual(policyIsolationReason([
  '.github/workflows/validate.yml',
  'miniprogram/app.js',
]), '', '普通候选测试工作流可以随业务版本演进，不充当权威扫描信任根')

const privateWeightRecord = JSON.stringify({
  date: '2027-01-14',
  weight: 64.35,
})
const privateExerciseRecord = JSON.stringify({
  date: '2027-01-15',
  exercise: { completed: true, durationMinutes: 47 },
})
const privateMealRecord = JSON.stringify({
  date: '2027-01-16',
  actualMeal: '示例之外的具体进食记录',
})
for (const [file, source] of [
  ['miniprogram/private-record.json', privateWeightRecord],
  ['cloudfunctions/health/private-record.js', `module.exports = ${privateExerciseRecord}`],
  ['docs/private-record.md', `用户记录：${privateMealRecord}`],
  ['scripts/exported-record.js', `const TEST_record = ${privateWeightRecord}`],
  ['scripts/exported-record.js', `const MOCK_record = ${privateExerciseRecord}`],
]) {
  assert(blobReason(file, Buffer.from(source)).includes('个人'), `${file} 中具体私人记录必须被拒绝`)
}
assert.strictEqual(blobReason('scripts/health-record.test.js', Buffer.from(privateWeightRecord)), '',
  '约定测试文件中的明确合成记录应通过')
assert.strictEqual(blobReason('scripts/fixtures/health.js', Buffer.from(
  `// @synthetic-fixture\nmodule.exports = ${privateExerciseRecord}\n`,
)), '', '明确 fixture 路径及标记中的合成记录应通过')
assert(blobReason('scripts/exported-record.js', Buffer.from(
  `// @synthetic-fixture\nmodule.exports = ${privateExerciseRecord}\n`,
)).includes('个人'), '普通源码不能仅凭 fixture 注释绕过')
for (const source of [
  'const schema = { weight: Number, exercise: Object, meals: Array }',
  '界面文案：可以记录体重、运动和饮食，用户也可稍后清空。',
  'const plannedMeal = { date: startDate, meals: generatedMeals }',
  'const validation = { weight: 0, durationMinutes: 0 }',
]) assert.strictEqual(blobReason('miniprogram/schema-and-copy.js', Buffer.from(source)), '',
  `字段、产品文案或无具体值 schema 不应误报：${source.slice(0, 24)}`)

for (const file of [
  'cloudfunctions/aiPlanner/.env.example',
  'cloudfunctions/aiPlanner/provider-config.test.js',
]) {
  const source = fs.readFileSync(path.join(root, file))
  assert.strictEqual(blobReason(file, source), '', `${file} 的明确占位符和测试值不应触发误报`)
}

const reviewedFixturePath = 'cloudfunctions/aiPlanner/reviewed-history.test.js'
const reviewedFixture = Buffer.from(`${headerName}=TEST_REVIEWED_HISTORY_VALUE\n`)
const reviewedFixtureDigest = crypto.createHash('sha256').update(reviewedFixture).digest('hex')
const reviewedFixtureAllowlist = Object.freeze({
  [reviewedFixturePath]: new Set([reviewedFixtureDigest]),
})
assert(reviewedHistoricalAssignment(reviewedFixturePath, reviewedFixture, reviewedFixtureAllowlist),
  '历史占位赋值必须同时匹配路径和内容哈希')
assert(!reviewedHistoricalAssignment(
  reviewedFixturePath,
  Buffer.concat([reviewedFixture, Buffer.from(' ')]),
  reviewedFixtureAllowlist,
), '历史占位内容变化后必须失去豁免')
assert(!reviewedHistoricalAssignment(
  'cloudfunctions/aiPlanner/other.test.js', reviewedFixture, reviewedFixtureAllowlist,
), '历史占位内容移动到其他路径后必须失去豁免')
assert.deepStrictEqual(
  Object.keys(REVIEWED_HISTORICAL_ASSIGNMENT_ALLOWLIST).sort(),
  ['cloudfunctions/aiPlanner/.env.example', 'cloudfunctions/aiPlanner/provider-config.test.js'],
  '历史豁免只能包含已经人工审计的两个旧文件',
)

const repositories = []
const originalCwd = process.cwd()
try {
  const forced = initRepo()
  repositories.push(forced)
  write(forced, 'private-data/profile.json', '{}\n')
  git(forced, ['add', '-f', 'private-data/profile.json'])
  process.chdir(forced)
  assert(hasError(checkIndex(), 'private-data/profile.json'), 'git add -f 不能绕过路径门禁')

  write(forced, 'cloudfunctions/aiPlanner/.env', `${aiKeyName}=YOUR_AI_API_KEY\n`)
  git(forced, ['add', '-f', 'cloudfunctions/aiPlanner/.env'])
  assert(hasError(checkIndex(), 'cloudfunctions/aiPlanner/.env'), 'git add -f 不能绕过云函数 .env 路径门禁')

  write(forced, 'cloudfunctions/private-data/.env.example', `${aiKeyName}=YOUR_AI_API_KEY\n`)
  git(forced, ['add', '-f', 'cloudfunctions/private-data/.env.example'])
  assert(hasError(checkIndex(), 'cloudfunctions/private-data/.env.example'),
    'example 后缀不能绕过个人数据目录门禁')

  const history = initRepo()
  repositories.push(history)
  process.chdir(history)
  const base = git(history, ['rev-parse', 'HEAD'])
  write(history, 'private-data/history.json', '{}\n')
  git(history, ['add', '-f', 'private-data/history.json'])
  git(history, ['commit', '-m', 'test: intermediate private file'])
  const privateCommit = git(history, ['rev-parse', 'HEAD'])
  git(history, ['rm', '-q', 'private-data/history.json'])
  commit(history, 'test: remove private file')
  const head = git(history, ['rev-parse', 'HEAD'])
  assert(hasError(checkRange(base, head, { ref: 'refs/heads/test' }), 'private-data/history.json'),
    '中间提交加入后删除的私有文件仍必须失败')

  write(history, 'scripts/message.js', 'module.exports = true\n')
  const messageCommit = commit(history, `test: ${keyName}=${fixtureValue}`)
  assert(hasError(checkRange(head, messageCommit, { ref: 'refs/heads/test' }), 'commit-message'),
    '提交说明中的敏感值必须失败')

  git(history, ['tag', '-a', 'private-tree-tag', privateCommit, '-m', 'test: clean annotation'])
  const privateTagOid = git(history, ['rev-parse', 'refs/tags/private-tree-tag'])
  assert(hasError(checkRange(privateCommit, privateTagOid, { ref: 'refs/tags/private-tree-tag' }), 'private-data/history.json'),
    '新 Tag 指向已有提交时仍必须检查目标树')

  git(history, ['tag', '-a', 'metadata-tag', base, '-m', `${passwordName}=${fixtureValue}`])
  const metadataTagOid = git(history, ['rev-parse', 'refs/tags/metadata-tag'])
  assert(hasError(checkRange(base, metadataTagOid, { ref: 'refs/tags/metadata-tag' }), 'tag-annotation'),
    'annotated Tag 注释中的敏感值必须失败')

  const clean = initRepo()
  repositories.push(clean)
  process.chdir(clean)
  const cleanHead = git(clean, ['rev-parse', 'HEAD'])
  git(clean, ['tag', '-a', 'v1.0.0', '-m', 'release: v1.0.0'])
  const cleanTagOid = git(clean, ['rev-parse', 'refs/tags/v1.0.0'])
  const pushResult = checkPushInput(`refs/tags/v1.0.0 ${cleanTagOid} refs/tags/v1.0.0 ${zeroOid}\n`)
  assert.deepStrictEqual(pushResult.errors, [], 'pre-push 必须正确处理 annotated Tag 对象')
  const deleteVersionTag = checkPushInput(
    `(delete) ${zeroOid} refs/tags/v1.0.0 ${cleanTagOid}\n`,
  )
  assert(hasError(deleteVersionTag, '禁止删除'), 'pre-push 必须拒绝删除已存在的版本 Tag')
  git(clean, ['tag', '-a', 'v1.0.1', '-m', 'release: v1.0.1'])
  const replacementTagOid = git(clean, ['rev-parse', 'refs/tags/v1.0.1'])
  const moveVersionTag = checkPushInput(
    `refs/tags/v1.0.0 ${replacementTagOid} refs/tags/v1.0.0 ${cleanTagOid}\n`,
  )
  assert(hasError(moveVersionTag, '禁止移动或覆盖'), 'pre-push 必须拒绝移动或覆盖已存在的版本 Tag')
  const badRemoteRef = checkPushInput(
    `refs/heads/local ${cleanHead} refs/heads/${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')} ${zeroOid}\n`,
  )
  assert(hasError(badRemoteRef, 'refs/heads/'), 'pre-push 必须校验远端 ref 名而非本地 ref 名')

  write(clean, '.local/private.txt', `${keyName}=${fixtureValue}\n`)
  write(clean, 'scripts/untracked.js', 'module.exports = true\n')
  const worktree = checkWorktree()
  assert.deepStrictEqual(worktree.errors, [], '只读工作树扫描应忽略 ignored 私有目录并接受公开候选')
  assert(worktree.files.includes('scripts/untracked.js'))
  assert(!worktree.files.includes('.local/private.txt'))

  const policyRepo = initRepo()
  repositories.push(policyRepo)
  process.chdir(policyRepo)
  const policyBase = git(policyRepo, ['rev-parse', 'HEAD'])
  write(policyRepo, 'scripts/check-staged-safety.js', '// TEST_POLICY_REVISION\n')
  write(policyRepo, 'miniprogram/app.js', '// TEST_BUSINESS_CHANGE\n')
  git(policyRepo, ['add', '-A'])
  assert(hasError(checkIndex(), '独立策略变更'),
    '暂存 scanner 与业务变更时必须拒绝由候选 scanner 自批')
  const combinedPolicyCommit = commit(policyRepo, 'test: combined policy and business change')
  assert(hasError(checkRange(policyBase, combinedPolicyCommit, { ref: 'refs/heads/v1.1.0' }), '独立策略变更'),
    'PR/push 范围同时包含 scanner 与业务变更时必须失败关闭')
} finally {
  process.chdir(originalCwd)
  repositories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
}

console.log('公开仓库安全门禁测试通过：路径、内容、历史、Branch/Tag 与工作树场景正常。')
