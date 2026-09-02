'use strict'

const assert = require('assert')

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const OID_PATTERN = /^[a-f0-9]{40,64}$/
const RELEASE_STATUSES = ['unreleased', 'release-candidate', 'released']
const RELEASE_METADATA_FILES = Object.freeze([
  'CHANGELOG.md',
  'README.md',
  'docs/ITERATION_LOG.md',
  'release-manifest.json',
])

function normalizedChangedEntries(value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => ({
    status: entry && typeof entry.status === 'string' ? entry.status : '',
    path: entry && typeof entry.path === 'string' ? entry.path.replace(/\\/g, '/') : '',
  })).sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status))
}

function normalizedContext(refContext) {
  const value = refContext && typeof refContext === 'object' ? refContext : {}
  return {
    refName: typeof value.refName === 'string' ? value.refName : '',
    commitOid: typeof value.commitOid === 'string' ? value.commitOid.toLowerCase() : '',
    parentOids: Array.isArray(value.parentOids)
      ? value.parentOids.map((oid) => String(oid).toLowerCase()) : [],
    treeOid: typeof value.treeOid === 'string' ? value.treeOid.toLowerCase() : '',
    candidateBranchRef: typeof value.candidateBranchRef === 'string' ? value.candidateBranchRef : '',
    candidateCommitOid: typeof value.candidateCommitOid === 'string'
      ? value.candidateCommitOid.toLowerCase() : '',
    candidateTreeOid: typeof value.candidateTreeOid === 'string'
      ? value.candidateTreeOid.toLowerCase() : '',
    changedEntries: normalizedChangedEntries(value.changedEntries),
    parentManifest: value.parentManifest && typeof value.parentManifest === 'object'
      && !Array.isArray(value.parentManifest) ? value.parentManifest : null,
  }
}

function normalizedTag(value, version) {
  if (!value) return null
  return {
    refName: typeof value.refName === 'string' ? value.refName : `refs/tags/v${version}`,
    objectType: typeof value.objectType === 'string' ? value.objectType : '',
    objectOid: typeof value.objectOid === 'string' ? value.objectOid.toLowerCase() : '',
    peeledCommitOid: typeof value.peeledCommitOid === 'string' ? value.peeledCommitOid.toLowerCase() : '',
  }
}

function assertExplicitContext(context) {
  assert(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(context.refName),
    '发布门禁必须提供完整且无歧义的 refs/heads/... 或 refs/tags/... 上下文')
  assert(OID_PATTERN.test(context.commitOid), '发布门禁必须提供当前 commit OID')
  context.parentOids.forEach((oid) => assert(OID_PATTERN.test(oid), '发布门禁父 commit OID 无效'))
}

function assertAnnotatedVersionTag(tag, version) {
  assert(tag, '正式发布版本必须存在同版本 annotated Tag')
  assert.strictEqual(tag.refName, `refs/tags/v${version}`, '版本 Tag ref 与工作版本不一致')
  assert.strictEqual(tag.objectType, 'tag', '正式发布版本必须使用 annotated Tag，不能使用 lightweight Tag')
  assert(OID_PATTERN.test(tag.objectOid), '版本 annotated Tag 对象 OID 无效')
  assert(OID_PATTERN.test(tag.peeledCommitOid), '版本 annotated Tag 无法 peel 到 commit')
}

function validateReleaseGate({ manifest, changelog, readme, refContext, versionTag = null }) {
  assert(SEMVER_PATTERN.test(manifest.lastReleasedVersion), '最后发布版本必须是 SemVer')
  assert(SEMVER_PATTERN.test(manifest.workingVersion), '工作版本必须是 SemVer')
  assert(RELEASE_STATUSES.includes(manifest.releaseStatus), '发布状态无效')

  const context = normalizedContext(refContext)
  const tag = normalizedTag(versionTag, manifest.workingVersion)
  assertExplicitContext(context)

  if (manifest.releaseStatus === 'unreleased') {
    assert(!STABLE_SEMVER_PATTERN.test(manifest.workingVersion), '开发版本必须包含 SemVer 预发布标识')
    assert(context.refName.startsWith('refs/heads/'), '开发版本只能从 Branch 构建')
    return
  }

  assert(STABLE_SEMVER_PATTERN.test(manifest.workingVersion), '上传候选和正式版本不能包含 SemVer 预发布标识')
  assert(
    typeof manifest.wechatUploadDescription === 'string'
    && manifest.wechatUploadDescription.trim() === manifest.wechatUploadDescription
    && manifest.wechatUploadDescription.length > 0
    && manifest.wechatUploadDescription.length <= 200
    && !/[\r\n]/.test(manifest.wechatUploadDescription),
    '微信上传说明必须是 1 至 200 字的单行公开文本',
  )
  assert(changelog.includes(`## [${manifest.workingVersion}] - `), '候选版本未归档到 CHANGELOG.md')
  assert(readme.includes(`\`${manifest.workingVersion}\``), 'README.md 未同步候选版本')

  const branchRef = `refs/heads/v${manifest.workingVersion}`
  const tagRef = `refs/tags/v${manifest.workingVersion}`

  if (manifest.releaseStatus === 'release-candidate') {
    assert.notStrictEqual(manifest.workingVersion, manifest.lastReleasedVersion,
      '上传候选不能提前覆盖最后正式发布版本')
    if (context.refName === tagRef) {
      assertAnnotatedVersionTag(tag, manifest.workingVersion)
      assert.strictEqual(tag.peeledCommitOid, context.commitOid,
        'annotated Tag 构建必须检验 Tag 指向的候选 commit')
      return
    }
    if (context.refName === 'refs/heads/main') {
      assert.strictEqual(context.candidateBranchRef, branchRef,
        'main 候选必须绑定当前版本 Branch 的完整 ref')
      assert(OID_PATTERN.test(context.treeOid), 'main 候选必须提供当前提交 tree OID')
      assert(OID_PATTERN.test(context.candidateCommitOid), 'main 候选必须解析当前版本 Branch commit')
      assert(OID_PATTERN.test(context.candidateTreeOid), 'main 候选必须解析当前版本 Branch tree')
      assert.strictEqual(context.treeOid, context.candidateTreeOid,
        'main 候选代码树必须与当前版本 Branch 完全一致')
      assert.strictEqual(tag, null, 'main 候选不能提前存在同版本 Tag')
      return
    }
    assert.strictEqual(context.refName, branchRef,
      `上传候选只能从 ${branchRef} 或对应 annotated Tag 构建`)
    assert.strictEqual(tag, null, '上传候选 Branch 不能提前存在同版本 Tag')
    return
  }

  assert.strictEqual(manifest.workingVersion, manifest.lastReleasedVersion,
    '正式发布后工作版本与最后发布版本必须一致')
  assert.strictEqual(context.refName, branchRef, 'released 元数据只能提交到对应版本 Branch')
  assertAnnotatedVersionTag(tag, manifest.workingVersion)
  assert.strictEqual(context.parentOids.length, 1, 'released 元数据提交必须只有一个父 commit')
  assert.strictEqual(tag.peeledCommitOid, context.parentOids[0],
    '版本 Tag 必须 peel 到 released 元数据提交的唯一父候选 commit')
  assert.notStrictEqual(context.commitOid, tag.peeledCommitOid,
    'released 元数据必须是 Tag 所指候选之后的独立提交')
  assert(context.parentManifest, 'released 元数据必须读取唯一父提交的版本清单')
  assert.strictEqual(context.parentManifest.releaseStatus, 'release-candidate',
    'released 元数据的父提交必须仍是 release-candidate')
  assert.strictEqual(context.parentManifest.workingVersion, manifest.workingVersion,
    'released 元数据的父提交必须属于同一工作版本')
  assert.deepStrictEqual(manifest, {
    ...context.parentManifest,
    lastReleasedVersion: context.parentManifest.workingVersion,
    releaseStatus: 'released',
  }, 'released 元数据只能更新发布状态和最后发布版本')
  assert.deepStrictEqual(context.changedEntries, RELEASE_METADATA_FILES.map((file) => ({
    status: 'M', path: file,
  })).sort((left, right) => left.path.localeCompare(right.path)),
  'released 元数据提交必须且只能修改四个公开版本元数据文件')
}

function validatePullRequestBinding(value) {
  const context = value && typeof value === 'object' ? value : {}
  const repository = String(context.repository || '')
  const defaultBranch = String(context.defaultBranch || '')
  const baseRepository = String(context.baseRepository || '')
  const baseRef = String(context.baseRef || '')
  const headRepository = String(context.headRepository || '')
  const headRef = String(context.headRef || '')
  const version = String(context.workingVersion || '')
  const baseOid = String(context.baseOid || '').toLowerCase()
  const defaultOid = String(context.defaultOid || '').toLowerCase()
  const headOid = String(context.headOid || '').toLowerCase()
  const candidateOid = String(context.candidateOid || '').toLowerCase()
  const pullRequestOid = String(context.pullRequestOid || '').toLowerCase()
  const candidateTreeOid = String(context.candidateTreeOid || '').toLowerCase()
  const pullRequestTreeOid = String(context.pullRequestTreeOid || '').toLowerCase()

  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    'Pull Request 必须提供当前仓库全名')
  assert(/^[A-Za-z0-9._/-]+$/.test(defaultBranch) && !defaultBranch.includes('..'),
    'Pull Request 必须提供有效默认 Branch')
  assert.strictEqual(baseRepository, repository, 'Pull Request base 必须属于当前仓库')
  assert.strictEqual(headRepository, repository, '候选 Pull Request 禁止来自 fork 或其他仓库')
  assert.strictEqual(baseRef, defaultBranch, '候选 Pull Request 必须以当前默认 Branch 为目标')
  assert(STABLE_SEMVER_PATTERN.test(version), '候选 Pull Request 必须使用稳定 SemVer 工作版本')
  assert.strictEqual(headRef, `v${version}`, 'Pull Request 来源 Branch 必须与工作版本完全一致')
  for (const [label, oid] of [
    ['base commit', baseOid],
    ['默认 Branch commit', defaultOid],
    ['事件 head commit', headOid],
    ['origin 候选 commit', candidateOid],
    ['Pull Request ref commit', pullRequestOid],
    ['origin 候选 tree', candidateTreeOid],
    ['Pull Request ref tree', pullRequestTreeOid],
  ]) assert(OID_PATTERN.test(oid), `Pull Request ${label} OID 无效`)
  assert.strictEqual(baseOid, defaultOid, 'Pull Request base 必须是当前默认 Branch 最新 commit')
  assert.strictEqual(headOid, candidateOid,
    'Pull Request head commit 必须精确等于当前仓库 origin 版本 Branch')
  assert.strictEqual(headOid, pullRequestOid,
    'Pull Request 事件 head commit 与现场拉取的 PR ref 不一致')
  assert.strictEqual(candidateTreeOid, pullRequestTreeOid,
    'Pull Request head tree 必须精确等于当前仓库 origin 版本 Branch tree')
}

if (require.main === module) {
  if (process.argv[2] !== '--trusted-pr-binding') {
    console.error('用法：node scripts/release-gate.js --trusted-pr-binding')
    process.exitCode = 2
  } else {
    validatePullRequestBinding({
      repository: process.env.PR_REPOSITORY,
      defaultBranch: process.env.PR_DEFAULT_BRANCH,
      baseRepository: process.env.PR_BASE_REPOSITORY,
      baseRef: process.env.PR_BASE_REF,
      headRepository: process.env.PR_HEAD_REPOSITORY,
      headRef: process.env.PR_HEAD_REF,
      workingVersion: process.env.PR_WORKING_VERSION,
      baseOid: process.env.PR_BASE_OID,
      defaultOid: process.env.PR_DEFAULT_OID,
      headOid: process.env.PR_HEAD_OID,
      candidateOid: process.env.PR_CANDIDATE_OID,
      pullRequestOid: process.env.PR_FETCHED_OID,
      candidateTreeOid: process.env.PR_CANDIDATE_TREE_OID,
      pullRequestTreeOid: process.env.PR_FETCHED_TREE_OID,
    })
    console.log('Pull Request 来源、commit 与 tree 已绑定到当前仓库版本 Branch。')
  }
}

module.exports = { RELEASE_METADATA_FILES, validatePullRequestBinding, validateReleaseGate }
