'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const scannerPath = 'scripts/check-staged-safety.js'

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim()
}

function write(cwd, file, content) {
  const target = path.join(cwd, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function gitResult(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

function combinedOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-git-hooks-'))
const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-git-hooks-remote-'))

try {
  git(directory, ['init', '-q'])
  git(directory, ['config', 'user.name', 'Git Hook Test'])
  git(directory, ['config', 'user.email', 'git-hook-test@example.invalid'])

  for (const hook of ['pre-commit', 'pre-push']) {
    const source = fs.readFileSync(path.join(root, '.githooks', hook))
    write(directory, `.githooks/${hook}`, source)
    fs.chmodSync(path.join(directory, '.githooks', hook), 0o755)
  }
  write(directory, scannerPath, fs.readFileSync(path.join(root, scannerPath)))
  write(directory, 'scripts/public.js', "module.exports = 'TEST_PLACEHOLDER_ONLY'\n")
  git(directory, ['add', '-A'])
  git(directory, ['commit', '--no-verify', '-m', 'test: baseline'])
  git(remote, ['init', '--bare', '-q'])
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(directory, ['remote', 'add', 'origin', remote])
  git(directory, ['push', '--no-verify', 'origin', 'HEAD:refs/heads/main'])
  git(directory, ['config', 'core.hooksPath', '.githooks'])

  const baseline = git(directory, ['rev-parse', 'HEAD'])
  write(directory, scannerPath, "'use strict'\nprocess.exit(0)\n")
  write(directory, 'private-data/profile.json', '{"fixture":"TEST_PLACEHOLDER_ONLY"}\n')
  git(directory, ['add', '-f', 'private-data/profile.json'])

  const refusedCommit = gitResult(directory, ['commit', '-m', 'test: must be refused'])
  assert.notStrictEqual(refusedCommit.status, 0,
    'pre-commit must reject a staged forbidden file when the scanner is weakened only in the worktree')
  assert(combinedOutput(refusedCommit).includes('differs from the staged index'),
    'pre-commit refusal must identify the scanner/index mismatch')
  assert.strictEqual(git(directory, ['rev-parse', 'HEAD']), baseline,
    'a refused commit must not advance HEAD')

  git(directory, ['restore', '--staged', 'private-data/profile.json'])
  fs.rmSync(path.join(directory, 'private-data'), { recursive: true, force: true })
  const baselineScanner = execFileSync('git', ['show', `HEAD:${scannerPath}`], { cwd: directory })
  write(directory, scannerPath, Buffer.concat([
    baselineScanner,
    Buffer.from('\n// TEST_POLICY_REVISION_ATOMIC\n'),
  ]))
  write(directory, 'scripts/public.js', "module.exports = 'TEST_POLICY_REVISION_ATOMIC'\n")
  git(directory, ['add', scannerPath, 'scripts/public.js'])

  const refusedCombinedCommit = gitResult(directory, ['commit', '-m', 'test: combined policy and business'])
  assert.notStrictEqual(refusedCombinedCommit.status, 0,
    'pre-commit must reject a scanner update combined with a business change')
  assert(combinedOutput(refusedCombinedCommit).includes('独立策略变更'),
    'pre-commit refusal must explain the independent policy-upgrade flow')

  git(directory, ['restore', '--staged', 'scripts/public.js'])
  git(directory, ['restore', 'scripts/public.js'])
  const policyCommit = gitResult(directory, ['commit', '-m', 'test: independent scanner policy update'])
  assert.strictEqual(policyCommit.status, 0,
    `pre-commit must accept an isolated scanner policy update:\n${combinedOutput(policyCommit)}`)
  const policyPush = gitResult(directory, ['push', 'origin', 'HEAD:refs/heads/main'])
  assert.strictEqual(policyPush.status, 0,
    `pre-push must accept the isolated policy update:\n${combinedOutput(policyPush)}`)

  write(directory, 'scripts/public.js', "module.exports = 'TEST_BUSINESS_AFTER_POLICY'\n")
  git(directory, ['add', 'scripts/public.js'])
  const businessCommit = gitResult(directory, ['commit', '-m', 'test: business after trusted policy'])
  assert.strictEqual(businessCommit.status, 0,
    `business commit must pass after the policy is trusted:\n${combinedOutput(businessCommit)}`)

  write(directory, scannerPath, "'use strict'\nprocess.exit(0)\n")
  const refusedWorktreePush = gitResult(directory, ['push', 'origin', 'HEAD:refs/heads/main'])
  assert.notStrictEqual(refusedWorktreePush.status, 0,
    'pre-push must reject a worktree scanner that differs from the index')
  assert(combinedOutput(refusedWorktreePush).includes('differs from the index'),
    'pre-push refusal must identify the scanner worktree/index mismatch')

  git(directory, ['add', scannerPath])
  const refusedIndexPush = gitResult(directory, ['push', 'origin', 'HEAD:refs/heads/main'])
  assert.notStrictEqual(refusedIndexPush.status, 0,
    'pre-push must reject an indexed scanner that differs from HEAD')
  assert(combinedOutput(refusedIndexPush).includes('differs from HEAD'),
    'pre-push refusal must identify the scanner index/HEAD mismatch')

  write(directory, scannerPath, execFileSync('git', ['show', `HEAD:${scannerPath}`], { cwd: directory }))
  git(directory, ['add', scannerPath])
  const acceptedPush = gitResult(directory, ['push', 'origin', 'HEAD:refs/heads/main'])
  assert.strictEqual(acceptedPush.status, 0,
    `pre-push must accept a clean scanner matching index and HEAD:\n${combinedOutput(acceptedPush)}`)
  assert.strictEqual(
    git(remote, ['rev-parse', 'refs/heads/main']),
    git(directory, ['rev-parse', 'HEAD']),
    'accepted push must update the intended remote ref',
  )

  git(directory, ['tag', '-a', 'v1.0.0', '-m', 'release: v1.0.0'])
  const createTag = gitResult(directory, ['push', 'origin', 'refs/tags/v1.0.0'])
  assert.strictEqual(createTag.status, 0,
    `pre-push must allow the first creation of an annotated version Tag:\n${combinedOutput(createTag)}`)
  const remoteTag = git(remote, ['rev-parse', 'refs/tags/v1.0.0'])

  const deleteTag = gitResult(directory, ['push', 'origin', ':refs/tags/v1.0.0'])
  assert.notStrictEqual(deleteTag.status, 0, 'pre-push must reject deleting an existing version Tag')
  assert(combinedOutput(deleteTag).includes('禁止删除'),
    'version Tag deletion refusal must identify the immutable Tag rule')
  assert.strictEqual(git(remote, ['rev-parse', 'refs/tags/v1.0.0']), remoteTag,
    'a refused deletion must leave the remote version Tag unchanged')

  git(directory, ['tag', '-a', 'replacement', '-m', 'release: replacement'])
  const replacementOid = git(directory, ['rev-parse', 'refs/tags/replacement'])
  git(directory, ['update-ref', 'refs/tags/v1.0.0', replacementOid])
  const moveTag = gitResult(directory, ['push', '--force', 'origin', 'refs/tags/v1.0.0'])
  assert.notStrictEqual(moveTag.status, 0, 'pre-push must reject moving an existing version Tag')
  assert(combinedOutput(moveTag).includes('禁止移动或覆盖'),
    'version Tag update refusal must identify the immutable Tag rule')
  assert.strictEqual(git(remote, ['rev-parse', 'refs/tags/v1.0.0']), remoteTag,
    'a refused update must leave the remote version Tag unchanged')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.rmSync(remote, { recursive: true, force: true })
}

console.log('Git hook scanner-integrity tests passed.')
