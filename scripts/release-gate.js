'use strict'

const assert = require('assert')

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const OID_PATTERN = /^[a-f0-9]{40,64}$/
const RELEASE_STATUSES = ['unreleased', 'release-candidate', 'released']

function normalizedContext(refContext) {
  const value = refContext && typeof refContext === 'object' ? refContext : {}
  return {
    refName: typeof value.refName === 'string' ? value.refName : '',
    commitOid: typeof value.commitOid === 'string' ? value.commitOid.toLowerCase() : '',
    parentOids: Array.isArray(value.parentOids)
      ? value.parentOids.map((oid) => String(oid).toLowerCase()) : [],
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
}

module.exports = { validateReleaseGate }
