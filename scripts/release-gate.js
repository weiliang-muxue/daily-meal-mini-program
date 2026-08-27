'use strict'

const assert = require('assert')

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const RELEASE_STATUSES = ['unreleased', 'release-candidate', 'released']

function validateReleaseGate({ manifest, changelog, readme, tagTypeForVersion = () => '' }) {
  assert(SEMVER_PATTERN.test(manifest.lastReleasedVersion), '最后发布版本必须是 SemVer')
  assert(SEMVER_PATTERN.test(manifest.workingVersion), '工作版本必须是 SemVer')
  assert(RELEASE_STATUSES.includes(manifest.releaseStatus), '发布状态无效')

  if (manifest.releaseStatus === 'unreleased') {
    assert(!STABLE_SEMVER_PATTERN.test(manifest.workingVersion), '开发版本必须包含 SemVer 预发布标识')
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

  if (manifest.releaseStatus === 'release-candidate') {
    assert.notStrictEqual(manifest.workingVersion, manifest.lastReleasedVersion,
      '上传候选不能提前覆盖最后正式发布版本')
    return
  }

  assert.strictEqual(manifest.workingVersion, manifest.lastReleasedVersion,
    '正式发布后工作版本与最后发布版本必须一致')
  assert.strictEqual(tagTypeForVersion(manifest.workingVersion), 'tag',
    '正式发布版本必须存在同版本 annotated Tag')
}

module.exports = { validateReleaseGate }
