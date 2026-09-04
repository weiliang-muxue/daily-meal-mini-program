'use strict'

const MAX_AVATAR_BYTES = 1024 * 1024
const MAX_HEALTH_PHOTO_BYTES = 2 * 1024 * 1024

function fileInfo(wxApi, filePath) {
  return new Promise((resolve, reject) => {
    if (!wxApi || typeof wxApi.getFileSystemManager !== 'function') {
      reject(new Error('当前微信版本不支持安全图片读取，请升级微信后重试'))
      return
    }
    wxApi.getFileSystemManager().getFileInfo({
      filePath,
      digestAlgorithm: 'sha256',
      success: resolve,
      fail: () => reject(new Error('图片读取失败，请重新选择')),
    })
  })
}

async function privateImagePayload(filePath, options = {}, wxApi = wx) {
  const maxBytes = Number(options.maxBytes)
  const label = options.label || '图片'
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('图片上传配置无效')
  if (!wxApi.cloud || typeof wxApi.cloud.CDN !== 'function') {
    throw new Error('当前微信版本不支持安全图片上传，请升级微信后重试')
  }
  const info = await fileInfo(wxApi, filePath)
  const size = Number(info && info.size)
  const sha256 = typeof (info && info.digest) === 'string' ? info.digest.toLowerCase() : ''
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw new Error(`${label}不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB`)
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label}读取失败，请重新选择`)
  return {
    sourceUrl: wxApi.cloud.CDN({ type: 'filePath', filePath }),
    sourceSize: size,
    sourceSha256: sha256,
  }
}

module.exports = { MAX_AVATAR_BYTES, MAX_HEALTH_PHOTO_BYTES, privateImagePayload }
