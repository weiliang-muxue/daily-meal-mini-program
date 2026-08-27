'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const {
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
  'config.credentials.json', 'cert.pem', 'cache.db', 'trace.log', 'request.har',
].forEach((file) => assert(pathReason(file), `${file} 必须被路径门禁拒绝`))
;[
  '.gitignore', 'README.md', 'scripts/app.js', 'docs/DEPLOY.md',
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
const credential = ['live', 'credential', 'value', '123456789'].join('_')
assert(secretReason(`${keyName}=${credential}`))
assert(secretReason(`${passwordName}:${credential}`))
assert(secretReason(`${identityName}=${'user'.repeat(7)}`))
assert(secretReason(['sk', 'abcdefghijklmnopqrstuvwx'].join('-')))
assert(secretReason(['wx', '1234567890abcdef'].join('')))
assert.strictEqual(secretReason(`${keyName}=YOUR_KEY_VALUE`), '')
assert.strictEqual(secretReason(`${keyName}=TEST_PLACEHOLDER_ONLY`), '')
assert.strictEqual(secretReason(`${headerName}: 10`), '')
assert(secretReason(`${headerName}: ${credential}`))
assert(metadataReason(`${keyName}=${credential}`))
assert(refReason(`refs/heads/${credential}/${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')}`))
assert.strictEqual(refReason('refs/heads/v0.2.0'), '')
assert.strictEqual(refReason('refs/tags/v0.2.0'), '')
assert(refReason('refs/pull/1/merge'))

const repositories = []
const originalCwd = process.cwd()
try {
  const forced = initRepo()
  repositories.push(forced)
  write(forced, 'private-data/profile.json', '{}\n')
  git(forced, ['add', '-f', 'private-data/profile.json'])
  process.chdir(forced)
  assert(hasError(checkIndex(), 'private-data/profile.json'), 'git add -f 不能绕过路径门禁')

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
  const messageCommit = commit(history, `test: ${keyName}=${credential}`)
  assert(hasError(checkRange(head, messageCommit, { ref: 'refs/heads/test' }), 'commit-message'),
    '提交说明中的敏感值必须失败')

  git(history, ['tag', '-a', 'private-tree-tag', privateCommit, '-m', 'test: clean annotation'])
  const privateTagOid = git(history, ['rev-parse', 'refs/tags/private-tree-tag'])
  assert(hasError(checkRange(privateCommit, privateTagOid, { ref: 'refs/tags/private-tree-tag' }), 'private-data/history.json'),
    '新 Tag 指向已有提交时仍必须检查目标树')

  git(history, ['tag', '-a', 'metadata-tag', base, '-m', `${passwordName}=${credential}`])
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
  const badRemoteRef = checkPushInput(
    `refs/heads/local ${cleanHead} refs/heads/${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')} ${zeroOid}\n`,
  )
  assert(hasError(badRemoteRef, 'refs/heads/'), 'pre-push 必须校验远端 ref 名而非本地 ref 名')

  write(clean, '.local/private.txt', `${keyName}=${credential}\n`)
  write(clean, 'scripts/untracked.js', 'module.exports = true\n')
  const worktree = checkWorktree()
  assert.deepStrictEqual(worktree.errors, [], '只读工作树扫描应忽略 ignored 私有目录并接受公开候选')
  assert(worktree.files.includes('scripts/untracked.js'))
  assert(!worktree.files.includes('.local/private.txt'))
} finally {
  process.chdir(originalCwd)
  repositories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
}

console.log('公开仓库安全门禁测试通过：路径、内容、历史、Branch/Tag 与工作树场景正常。')
