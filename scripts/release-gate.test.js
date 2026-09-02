'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { validateReleaseGate } = require('./release-gate')

const candidateOid = 'a'.repeat(40)
const metadataOid = 'b'.repeat(40)
const otherOid = 'c'.repeat(40)
const tagObjectOid = 'd'.repeat(40)
const description = '公开微信上传说明'
const docs = { changelog: '## [0.2.0] - 2026-08-27', readme: '版本 `0.2.0`' }
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
const branchContext = { refName: 'refs/heads/v0.2.0', commitOid: candidateOid, parentOids: [otherOid] }
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

// 3. Candidate metadata cannot be built from another or ambiguous Branch.
assert.throws(() => validateReleaseGate({
  manifest: candidate, ...docs,
  refContext: { ...branchContext, refName: 'refs/heads/main' },
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
  refContext: { refName: 'refs/heads/v0.2.0', commitOid: metadataOid, parentOids: [candidateOid] },
  versionTag: annotatedTag,
})

// 7. Missing/lightweight Tags cannot authorize released metadata.
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: { refName: 'refs/heads/v0.2.0', commitOid: metadataOid, parentOids: [candidateOid] },
}), /annotated Tag/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: { refName: 'refs/heads/v0.2.0', commitOid: metadataOid, parentOids: [candidateOid] },
  versionTag: { ...annotatedTag, objectType: 'commit', objectOid: candidateOid },
}), /annotated Tag/)

// 8. The Tag must peel to the sole parent candidate; merge and detached released builds fail.
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: { refName: 'refs/heads/v0.2.0', commitOid: metadataOid, parentOids: [otherOid] },
  versionTag: annotatedTag,
}), /唯一父候选 commit/)
assert.throws(() => validateReleaseGate({
  manifest: released, ...docs,
  refContext: { refName: 'refs/heads/v0.2.0', commitOid: metadataOid, parentOids: [candidateOid, otherOid] },
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

// Pull requests validate the source Branch commit, while pushes retain github.ref.
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'validate.yml'), 'utf8')
assert(workflow.includes(
  "RELEASE_GATE_REF: ${{ github.event_name == 'pull_request' && format('refs/heads/{0}', github.head_ref) || github.ref }}",
), 'Pull Request 发布门禁必须使用 github.head_ref 绑定来源 Branch')
assert(!workflow.includes(
  "RELEASE_GATE_REF: ${{ github.event_name == 'pull_request' && format('refs/heads/{0}', github.base_ref) || github.ref }}",
), 'Pull Request 发布门禁不能把目标 Branch 与来源 commit 混用')

console.log('发布状态、Branch、annotated Tag 与元数据父提交门禁测试通过。')
