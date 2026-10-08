'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { buildPackage, runtimeFile, assertNoCredentials } = require('./build-wechat-package')

for (const file of ['miniprogram/pages/profile/profile.js', 'cloudfunctions/membership/index.js', 'cloudfunctions/membership/package-lock.json']) assert(runtimeFile(file))
for (const file of ['.git/config', '.local/data.json', 'cloudfunctions/ownerBootstrapOnce/index.js',
  'cloudfunctions/membership/.env', 'cloudfunctions/membership/core.test.js',
  'cloudfunctions/membership/node_modules/private.json', 'miniprogram/config.js',
  'miniprogram/config.local.js', 'miniprogram/config.example.js', '../secret.js']) assert(!runtimeFile(file))
assert.throws(() => assertNoCredentials(Buffer.from('api' + '_key="' + 'synthetic-credential' + '"')), /CREDENTIALS/)
for (const field of ['client' + 'Secret', 'refresh' + 'Token', 'pass' + 'word', 'private' + 'Key', 'Authorization']) {
  assert.throws(() => assertNoCredentials(Buffer.from(JSON.stringify({ [field]: 'SYNTHETIC_VALUE_ONLY' }))), /CREDENTIALS/)
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-package-test-'))
const source = path.join(folder, '源码仓库')
fs.mkdirSync(source)
const put = (file, text) => { const dest = path.join(source, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text) }
put('miniprogram/app.js', 'App({})\n')
put('miniprogram/config.js', 'module.exports = { cloudEnvId: "YOUR_CLOUD_ENV_ID" }\n')
put('project.config.json', JSON.stringify({ miniprogramRoot: 'miniprogram/', cloudfunctionRoot: 'cloudfunctions/' }))
put('project.private.config.json', '{}')
put('cloudfunctions/membership/index.js', 'exports.main = async () => ({})\n')
put('cloudfunctions/membership/package-lock.json', JSON.stringify({ name: 'membership-fixture', lockfileVersion: 3 }))
put('cloudfunctions/ownerBootstrapOnce/index.js', 'throw new Error("do not deploy")\n')
put('release-manifest.json', JSON.stringify({ workingVersion: '0.2.1' }))
put('.gitignore', '.local/\n')
const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'ignore' })
git('init'); git('add', '.'); git('-c', 'user.name=Package Test', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
const result = buildPackage(source, { skipSafetyForTest: true })
assert.strictEqual(result.fileCount, 3)
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(result.destination, 'cloudfunctions/membership/package-lock.json'), 'utf8')).lockfileVersion, 3)
assert.strictEqual(fs.existsSync(path.join(result.destination, 'cloudfunctions/ownerBootstrapOnce')), false)
assert.strictEqual(fs.existsSync(path.join(result.destination, '.git')), false)
assert.strictEqual(fs.readFileSync(path.join(result.destination, 'miniprogram/app.js'), 'utf8'), 'App({})\n')
fs.writeFileSync(path.join(result.destination, 'manual-note.txt'), 'preserve me')
put('miniprogram/app.js', 'App({ updated: true })\n')
const next = buildPackage(source, { skipSafetyForTest: true })
assert.strictEqual(next.previousPackageRetained, true)
const backups = fs.readdirSync(path.join(source, '.local/import-backups'))
assert(backups.some((name) => fs.existsSync(path.join(source, '.local/import-backups', name, 'manual-note.txt'))))
assert.strictEqual(fs.readFileSync(path.join(result.destination, 'miniprogram/app.js'), 'utf8'), 'App({ updated: true })\n')
// A linked staging/backup ancestor must fail before copying local configuration
// or moving the existing import package. These are isolated temporary fixtures.
const external = path.join(folder, 'outside')
fs.mkdirSync(external)
for (const relative of ['.local/package-builds', '.local/import-backups', '.local']) {
  const linked = path.join(source, relative)
  const retained = linked + '-fixture-retained'
  fs.renameSync(linked, retained)
  try {
    fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => buildPackage(source, { skipSafetyForTest: true }), /PACKAGE_LINK_NOT_ALLOWED/)
    assert.deepStrictEqual(fs.readdirSync(external), [])
    assert.strictEqual(fs.readFileSync(path.join(result.destination, 'miniprogram/app.js'), 'utf8'), 'App({ updated: true })\n')
  } finally {
    if (fs.lstatSync(linked).isSymbolicLink()) fs.unlinkSync(linked)
    fs.renameSync(retained, linked)
  }
}
// Invoke from outside the source repository: the scanner must run in source.
put('scripts/check-staged-safety.js', 'if (process.cwd() !== process.argv[1].replace(/[\\\\/]scripts[\\\\/]check-staged-safety\\.js$/, "")) process.exit(9)\n')
const originalCwd = process.cwd()
try {
  process.chdir(folder)
  assert.strictEqual(buildPackage(source).fileCount, 3)
} finally { process.chdir(originalCwd) }
console.log('WeChat package tests passed: runtime allowlist, private config guard, contained paths, source-bound scan, recoverable replacement, no bootstrap')
