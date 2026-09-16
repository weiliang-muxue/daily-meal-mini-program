'use strict'

const assert = require('assert')
const { MAX_AVATAR_BYTES, privateImagePayload } = require('../miniprogram/utils/private-image')

function wxMock(info, options = {}) {
  return {
    cloud: options.withoutCdn ? {} : { CDN: (value) => ({ marker: 'cdn', value }) },
    getFileSystemManager: () => ({
      getFileInfo({ success, fail }) { options.fail ? fail({}) : success(info) },
    }),
  }
}

;(async () => {
  const digest = 'a'.repeat(64)
  const payload = await privateImagePayload('tmp/avatar.jpg', {
    maxBytes: MAX_AVATAR_BYTES, label: '头像',
  }, wxMock({ size: 1024, digest }))
  assert.deepStrictEqual(payload, {
    sourceUrl: { marker: 'cdn', value: { type: 'filePath', filePath: 'tmp/avatar.jpg' } },
    sourceSize: 1024,
    sourceSha256: digest,
  })
  await assert.rejects(() => privateImagePayload('tmp/a.jpg', {
    maxBytes: MAX_AVATAR_BYTES, label: '头像',
  }, wxMock({ size: MAX_AVATAR_BYTES + 1, digest })), /不能超过 1 MB/)
  await assert.rejects(() => privateImagePayload('tmp/a.jpg', {
    maxBytes: MAX_AVATAR_BYTES, label: '头像',
  }, wxMock({ size: 1, digest }, { withoutCdn: true })), /不支持安全图片上传/)
  await assert.rejects(() => privateImagePayload('tmp/a.jpg', {
    maxBytes: MAX_AVATAR_BYTES, label: '头像',
  }, wxMock({ size: 1, digest }, { fail: true })), /读取失败/)
  console.log('private image client tests passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
