'use strict'

// Build locally from the single source tree. Never deploy or reset cloud data.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const FUNCTIONS = ['membership', 'auth', 'userData', 'health', 'privacy', 'aiPlanner', 'mealAiMaintenance', 'waterReminder']
const CONFIG_FILES = ['project.config.json', 'project.private.config.json', 'miniprogram/config.js']
const MARKER = 'wechat-import-manifest.json'
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function assertLocalDirectory(root, directory) {
  const target = path.resolve(directory)
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('PACKAGE_PATH_OUTSIDE_SOURCE')
  let cursor = root
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part)
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (error.code === 'ENOENT') return target
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('PACKAGE_LINK_NOT_ALLOWED')
    if (!stat.isDirectory()) throw new Error('PACKAGE_PATH_NOT_DIRECTORY')
    if (!fs.realpathSync(cursor).startsWith(root + path.sep)) throw new Error('PACKAGE_PATH_OUTSIDE_SOURCE')
  }
  return target
}

function assertPlainFile(root, file) {
  const target = path.resolve(root, file)
  if (!target.startsWith(root + path.sep)) throw new Error('PACKAGE_PATH_OUTSIDE_SOURCE')
  let cursor = root
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part)
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('PACKAGE_LINK_NOT_ALLOWED')
  }
  if (!fs.statSync(target).isFile()) throw new Error('PACKAGE_INPUT_NOT_FILE')
  return target
}

function runtimeFile(file) {
  if (file.split('/').some((part) => !part || part === '..' || part.startsWith('.') || part === 'node_modules')) return false
  if (/\.(?:test|spec)\.js$|\.example\.|(?:^|\/)README\.md$/i.test(file)) return false
  if (CONFIG_FILES.includes(file) || file === 'miniprogram/config.local.js') return false
  if (!/\.(?:js|json|wxml|wxss|wxs|png|jpg|jpeg)$/.test(file)) return false
  return file.startsWith('miniprogram/')
    || FUNCTIONS.some((name) => file.startsWith(`cloudfunctions/${name}/`))
}

function assertNoCredentials(bytes) {
  const text = bytes.toString('utf8')
  if (/\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /["'`]?(?:app[_-]?secret|(?:openai|ai)?[_-]?api[_-]?key|secret(?:[_-]?key)?|(?:access|refresh|bearer)?[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?key|password|passwd|passphrase|authorization|cookie|ai[_-]?provider[_-]?header[_-]?value)["'`]?\s*\]?\s*[:=]\s*["'`][^"'`]+["'`]/i.test(text)) {
    throw new Error('PACKAGE_LOCAL_CONFIG_CONTAINS_CREDENTIALS')
  }
}

function readReleaseManifest(source) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(assertPlainFile(source, 'release-manifest.json'), 'utf8'))
  } catch (_) { throw new Error('PACKAGE_RELEASE_MANIFEST_INVALID') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('PACKAGE_RELEASE_MANIFEST_INVALID')
  }
  // This destination carries the real local environment configuration. Use
  // isolated UI fixtures for development, never this formal import package.
  // This is a minimum guard, not evidence of cloud/device acceptance or release.
  if (!['release-candidate', 'released'].includes(manifest.releaseStatus)
    || typeof manifest.workingVersion !== 'string'
    || manifest.workingVersion.trim() !== manifest.workingVersion
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.workingVersion)) {
    throw new Error('PACKAGE_RELEASE_NOT_READY')
  }
  return manifest
}

function buildPackage(sourceRoot, options = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot))
  if (path.basename(source) !== '源码仓库') throw new Error('PACKAGE_SOURCE_DIRECTORY_REQUIRED')
  const destination = path.join(path.dirname(source), '微信导入包')
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('PACKAGE_TARGET_LINK_NOT_ALLOWED')
  if (fs.existsSync(destination) && fs.readdirSync(destination).length && !fs.existsSync(path.join(destination, MARKER))) {
    throw new Error('PACKAGE_TARGET_NOT_GENERATED')
  }
  // Fail before scanning/copying configuration, creating staging directories,
  // or moving the existing package. Test-only safety skipping cannot skip this.
  const manifest = readReleaseManifest(source)
  // Refuse to read/copy unreviewed public source. Local deployment config is
  // handled separately and remains outside Git and the public manifest digest.
  if (!options.skipSafetyForTest) {
    try {
      execFileSync(process.execPath, [path.join(source, 'scripts', 'check-staged-safety.js'), '--worktree'], {
        cwd: source, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (_) { throw new Error('PACKAGE_SOURCE_SAFETY_CHECK_FAILED') }
  }
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0').filter(runtimeFile).sort()
  const uniqueFiles = [...new Set(files)]
  const runId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const staging = path.join(source, '.local', 'package-builds', runId)
  const backup = path.join(source, '.local', 'import-backups', runId)
  const records = []
  assertLocalDirectory(source, staging)
  assertLocalDirectory(source, backup)
  fs.mkdirSync(staging, { recursive: true })
  assertLocalDirectory(source, staging)
  for (const file of uniqueFiles) {
    const original = assertPlainFile(source, file)
    const target = path.join(staging, file)
    const bytes = fs.readFileSync(original)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
    records.push({ path: file, sha256: digest(bytes) })
  }
  // Only the existing local AppID/environment configuration is copied. Never
  // collect cloud .env files, credentials, caches, pictures or database exports.
  for (const file of CONFIG_FILES) {
    const original = assertPlainFile(source, file)
    const bytes = fs.readFileSync(original)
    assertNoCredentials(bytes)
    const target = path.join(staging, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  const project = JSON.parse(fs.readFileSync(path.join(staging, 'project.config.json'), 'utf8'))
  if (project.miniprogramRoot !== 'miniprogram/' || project.cloudfunctionRoot !== 'cloudfunctions/') {
    throw new Error('PACKAGE_PROJECT_ROOTS_INVALID')
  }
  const record = {
    kind: 'generated-wechat-import-package', version: manifest.workingVersion,
    baseCommit: git('rev-parse', 'HEAD'),
    workingTreeChanged: Boolean(git('status', '--porcelain', '--untracked-files=normal')),
    publicRuntimeFiles: records,
    publicRuntimeDigest: digest(Buffer.from(JSON.stringify(records))),
    localConfigurationCopied: true,
    cloudFunctions: FUNCTIONS, excludesBootstrap: true,
    builtAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(staging, MARKER), JSON.stringify(record, null, 2) + '\n')
  // Retain the entire previous package, including manual edits and DevTools
  // preferences. Same-volume rename never deletes an earlier package.
  let movedPrevious = false
  if (fs.existsSync(destination)) {
    assertLocalDirectory(source, backup)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    assertLocalDirectory(source, backup)
    if (fs.lstatSync(destination).isSymbolicLink()) throw new Error('PACKAGE_TARGET_LINK_NOT_ALLOWED')
    fs.renameSync(destination, backup)
    movedPrevious = true
  }
  try { fs.renameSync(staging, destination) } catch (error) {
    if (movedPrevious && !fs.existsSync(destination)) fs.renameSync(backup, destination)
    throw error
  }
  return { destination, version: record.version, fileCount: records.length, previousPackageRetained: movedPrevious }
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildPackage(path.resolve(__dirname, '..')), null, 2)) } catch (error) {
    const code = /^PACKAGE_[A-Z_]+$/.test(error.message) ? error.message : 'PACKAGE_BUILD_FAILED'
    console.error(code)
    process.exitCode = 1
  }
}

module.exports = { buildPackage, runtimeFile, assertNoCredentials, assertLocalDirectory }
