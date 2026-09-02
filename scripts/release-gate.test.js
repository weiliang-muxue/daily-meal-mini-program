'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { validatePullRequestBinding, validateReleaseGate } = require('./release-gate')

const candidateOid = 'a'.repeat(40)
const metadataOid = 'b'.repeat(40)
const otherOid = 'c'.repeat(40)
const tagObjectOid = 'd'.repeat(40)
const candidateTreeOid = 'e'.repeat(40)
const otherTreeOid = 'f'.repeat(40)
const description = '公开微信上传说明'
const docs = { changelog: '## [0.2.0] - 2026-08-27', readme: '版本 `0.2.0`' }
const repository = 'example/daily-meal-mini-program'
const base = {
  lastReleasedVersion: '0.1.0',
  workingVersion: '0.2.0-dev.1',
  releaseStatus: 'unreleased',
}
const candidate = {
  ...base, workingVersion: '0.2.0', releaseStatus: 'release-candidate', wechatUploadDescription: description,
}
const released = {
  ...candidate, lastReleasedVersion: '0.2.0', releaseStatus: 'released',
}
const metadataEntries = [
  { status: 'M', path: 'CHANGELOG.md' },
  { status: 'M', path: 'README.md' },
  { status: 'M', path: 'docs/ITERATION_LOG.md' },
  { status: 'M', path: 'release-manifest.json' },
]
const branchContext = { refName: 'refs/heads/v0.2.0', commitOid: candidateOid, parentOids: [otherOid] }
const mainContext = {
  refName: 'refs/heads/main', commitOid: metadataOid, parentOids: [otherOid],
  treeOid: candidateTreeOid, candidateBranchRef: 'refs/heads/v0.2.0',
  candidateCommitOid: candidateOid, candidateTreeOid,
}
const releasedContext = {
  refName: 'refs/heads/v0.2.0', commitOid: metadataOid, parentOids: [candidateOid],
  parentManifest: candidate, changedEntries: metadataEntries,
}
const tagContext = { refName: 'refs/tags/v0.2.0', commitOid: candidateOid, parentOids: [otherOid] }
const annotatedTag = {
  refName: 'refs/tags/v0.2.0', objectType: 'tag', objectOid: tagObjectOid, peeledCommitOid: candidateOid,
}

// 1. Development builds require an explicit Branch context.
validateReleaseGate({
  manifest: base, changelog: '', readme: '',
  refContext: { refName: 'refs/heads/v0.2.0', commitOid: candidateOid, parentOids: [otherOid] },
})
assert.throws(() => validateReleaseGate({
  manifest: base, changelog: '', readme: '', refContext: tagContext,
}), /只能从 Branch/)
assert.throws(() => validateReleaseGate({ manifest: base, changelog: '', readme: '' }), /完整且无歧义/)

// 2. A candidate Branch is valid only while the same-version Tag is absent.
validateReleaseGate({ manifest: candidate, ...docs, refContext: branchContext })
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs, refContext: branchContext, versionTag: annotatedTag,
}), /Branch 不能提前存在同版本 Tag/)

// 3. Main may mirror the exact candidate tree, but another or divergent Branch fails closed.
validateReleaseGate({ manifest: candidate, ...docs, refContext: mainContext })
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs, refContext: { ...mainContext, candidateTreeOid: otherTreeOid },
}), /代码树必须与当前版本 Branch 完全一致/)
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs, refContext: { ...mainContext, candidateBranchRef: 'refs/heads/v0.2.1' },
}), /绑定当前版本 Branch/)
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs,
  refContext: { ...branchContext, refName: 'refs/heads/other' },
}), /上传候选只能从 refs\/heads\/v0\.2\.0/)
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs,
  refContext: { ...branchContext, refName: 'v0.2.0' },
}), /完整且无歧义/)

// 4. A legitimate annotated Tag build validates the tagged candidate tree.
validateReleaseGate({ manifest: candidate, ...docs, refContext: tagContext, versionTag: annotatedTag })

// 5. Lightweight or mismatched Tag builds fail closed.
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs, refContext: tagContext,
  versionTag: { ...annotatedTag, objectType: 'commit', objectOid: candidateOid },
}), /annotated Tag/)
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs, refContext: tagContext,
  versionTag: { ...annotatedTag, peeledCommitOid: otherOid },
}), /Tag 指向的候选 commit/)

// 6. Released metadata is a single-parent Branch commit directly after the tagged candidate.
validateReleaseGate({
  manifest: released, ...docs,
  refContext: releasedContext,
  versionTag: annotatedTag,
})

// 7. Released metadata cannot carry runtime changes or mutate frozen contract fields.
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: {
    ...releasedContext,
    changedEntries: [...metadataEntries, { status: 'M', path: 'miniprogram/app.js' }],
  },
  versionTag: annotatedTag,
}), /只能修改四个公开版本元数据文件/)
assert.throws(() => validateReleaseGate({
  manifest: { ...released, aiPlannerVersion: '8' }, ...docs,
  refContext: releasedContext,
  versionTag: annotatedTag,
}), /只能更新发布状态和最后发布版本/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: {
    ...releasedContext,
    parentManifest: { ...candidate, releaseStatus: 'unreleased' },
  },
  versionTag: annotatedTag,
}), /父提交必须仍是 release-candidate/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: {
    ...releasedContext,
    changedEntries: metadataEntries.map((entry, index) => index === 0
      ? { status: 'A', path: entry.path } : entry),
  },
  versionTag: annotatedTag,
}), /只能修改四个公开版本元数据文件/)

// 8. Missing/lightweight Tags cannot authorize released metadata.
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: releasedContext,
}), /annotated Tag/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: releasedContext,
  versionTag: { ...annotatedTag, objectType: 'commit', objectOid: candidateOid },
}), /annotated Tag/)

// 9. The Tag must peel to the sole parent candidate; merge and detached released builds fail.
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: { ...releasedContext, parentOids: [otherOid] },
  versionTag: annotatedTag,
}), /唯一父候选 commit/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: { ...releasedContext, parentOids: [candidateOid, otherOid] },
  versionTag: annotatedTag,
}), /只有一个父 commit/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs, refContext: { ...tagContext, commitOid: metadataOid }, versionTag: annotatedTag,
}), /只能提交到对应版本 Branch/)

// Existing manifest/document validation remains active.
assert.throws(() => validateReleaseGate({
  manifest: { ...candidate, workingVersion: '0.2.0-dev.1' }, ...docs, refContext: branchContext,
}), /不能包含 SemVer 预发布标识/)
assert.throws(() => validateReleaseGate({
  manifest: { ...candidate, wechatUploadDescription: '' }, ...docs, refContext: branchContext,
}), /微信上传说明/)

const pullRequestBinding = {
  repository,
  defaultBranch: 'main',
  baseRepository: repository,
  baseRef: 'main',
  headRepository: repository,
  headRef: 'v0.2.0',
  workingVersion: '0.2.0',
  baseOid: otherOid,
  defaultOid: otherOid,
  headOid: candidateOid,
  candidateOid,
  pullRequestOid: candidateOid,
  candidateTreeOid,
  pullRequestTreeOid: candidateTreeOid,
}
validatePullRequestBinding(pullRequestBinding)
for (const [change, expected] of [
  [{ headRepository: 'fork/daily-meal-mini-program' }, /禁止来自 fork/],
  [{ headRef: 'v0.2.1' }, /来源 Branch/],
  [{ baseRef: 'release' }, /默认 Branch/],
  [{ defaultOid: metadataOid }, /最新 commit/],
  [{ candidateOid: metadataOid, candidateTreeOid }, /head commit/],
  [{ pullRequestOid: metadataOid }, /事件 head commit/],
  [{ pullRequestTreeOid: otherTreeOid }, /head tree/],
  [{ candidateOid: '' }, /OID 无效/],
]) assert.throws(() => validatePullRequestBinding({ ...pullRequestBinding, ...change }), expected)

// Pull requests validate the source Branch commit, while pushes retain github.ref.
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'validate.yml'), 'utf8')
assert(workflow.includes(
  "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.ref }}",
), 'Pull Request 必须检出 head SHA，不能验证 GitHub 临时 merge tree')
assert(!workflow.includes('github.event.pull_request.merge_commit_sha'),
  'Pull Request 发布门禁不能使用临时 merge commit SHA')
assert(workflow.includes(
  "RELEASE_GATE_REF: ${{ github.event_name == 'pull_request' && format('refs/heads/{0}', github.head_ref) || github.ref }}",
), 'Pull Request 发布门禁必须使用 github.head_ref 绑定来源 Branch')
assert(!workflow.includes(
  "RELEASE_GATE_REF: ${{ github.event_name == 'pull_request' && format('refs/heads/{0}', github.base_ref) || github.ref }}",
), 'Pull Request 发布门禁不能把目标 Branch 与来源 commit 混用')
assert(workflow.includes('RELEASE_GATE_CANDIDATE_REF: ${{ steps.release-candidate.outputs.ref }}')
  && workflow.includes('RELEASE_GATE_CANDIDATE_COMMIT: ${{ steps.release-candidate.outputs.commit }}'),
'main 门禁必须显式传入现场解析的远端版本 Branch ref 与 commit')
assert(workflow.includes('git fetch --no-tags origin "+$CANDIDATE_REF:$REMOTE_REF"'),
  'main 门禁必须刷新 origin 版本 Branch，不能优先使用可能过期的本地 Branch')
const trustedWorkflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'trusted-pr-security.yml'), 'utf8',
)
assert(trustedWorkflow.includes('pull_request_target:'),
  'Pull Request 权威安全扫描必须由默认分支定义的 pull_request_target 运行')
assert(!workflow.includes('pull_request_target:'),
  '候选功能验证工作流不能混入具有默认分支权限的 pull_request_target')
assert(trustedWorkflow.includes('persist-credentials: false'),
  '受信 Pull Request 安全任务不得把 GitHub 写凭据留在工作树')
assert(trustedWorkflow.includes('ref: ${{ github.event.repository.default_branch }}'),
  '权威安全任务必须检出受保护默认 Branch 的策略')
assert(trustedWorkflow.includes('node scripts/release-gate.js --trusted-pr-binding'),
  '权威安全任务必须校验同仓候选 Branch 的 commit/tree 绑定')
assert(trustedWorkflow.includes('git merge-base --is-ancestor "$PR_BASE_OID" "$PR_FETCHED_OID"'),
  'Pull Request 必须包含当前 base commit，避免过期候选合并后改变代码树')
assert(trustedWorkflow.includes('refs/pull/$PR_NUMBER/head:refs/remotes/pull-request/$PR_NUMBER/head'),
  '权威安全任务必须现场拉取 Pull Request head 对象')
assert(!/trusted-pr-security:[\s\S]*?working-directory:\s*scripts\/wx-automator/.test(trustedWorkflow),
  '权威安全任务不得安装或执行 Pull Request head 的应用依赖')
assert(!/trusted-pr-security:[\s\S]*?checkout[^\n]*head\.sha/.test(trustedWorkflow),
  '权威安全任务不得把 Pull Request head 检出为可执行工作树')

const validationSource = fs.readFileSync(path.join(__dirname, 'validate.js'), 'utf8')
assert(!validationSource.includes('const candidates = [branchRef,'),
  'main 门禁不能优先解析可能过期的本地版本 Branch')
assert(validationSource.includes('refs/remotes/origin/v${version}'),
  'main 门禁必须从 origin 版本 Branch 解析候选 commit')

console.log('发布状态、Branch、annotated Tag 与元数据父提交门禁测试通过。')
