'use strict'

const assert = require('assert')
const { validateReleaseGate } = require('./release-gate')

const description = '公开微信上传说明'
const docs = { changelog: '## [0.2.0] - 2026-08-27', readme: '版本 `0.2.0`' }
const base = {
  lastReleasedVersion: '0.1.0',
  workingVersion: '0.2.0-dev.1',
  releaseStatus: 'unreleased',
}

validateReleaseGate({ manifest: base, changelog: '', readme: '' })
validateReleaseGate({
  manifest: { ...base, workingVersion: '0.2.0', releaseStatus: 'release-candidate', wechatUploadDescription: description },
  ...docs,
  tagTypeForVersion: () => { throw new Error('候选状态不应检查 Tag') },
})
assert.throws(() => validateReleaseGate({
  manifest: { ...base, releaseStatus: 'release-candidate', wechatUploadDescription: description },
  ...docs,
}), /不能包含 SemVer 预发布标识/)
assert.throws(() => validateReleaseGate({
  manifest: { ...base, workingVersion: '0.2.0', releaseStatus: 'release-candidate', wechatUploadDescription: '' },
  ...docs,
}), /微信上传说明/)
assert.throws(() => validateReleaseGate({
  manifest: {
    ...base, lastReleasedVersion: '0.2.0', workingVersion: '0.2.0', releaseStatus: 'released', wechatUploadDescription: description,
  },
  ...docs,
  tagTypeForVersion: () => '',
}), /annotated Tag/)
validateReleaseGate({
  manifest: {
    ...base, lastReleasedVersion: '0.2.0', workingVersion: '0.2.0', releaseStatus: 'released', wechatUploadDescription: description,
  },
  ...docs,
  tagTypeForVersion: () => 'tag',
})

console.log('发布状态门禁测试通过。')
