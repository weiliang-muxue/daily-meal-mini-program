'use strict'

const IMAGE_TYPES = {
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  png: { extension: 'png', mimeType: 'image/png' },
  webp: { extension: 'webp', mimeType: 'image/webp' },
}

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return IMAGE_TYPES.jpeg
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return IMAGE_TYPES.png
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return IMAGE_TYPES.webp
  return null
}

function validateImageFile(value, options = {}) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  const label = options.label || '图片'
  const maxBytes = Number(options.maxBytes)
  if (!buffer.length) throw new Error(`${label}为空，请重新选择`)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('图片校验配置无效')
  if (buffer.length > maxBytes) throw new Error(`${label}不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB`)
  const type = imageType(buffer)
  if (!type) throw new Error(`${label}必须是 JPG、PNG 或 WebP 图片`)
  return { ...type, size: buffer.length, fileContent: buffer }
}

module.exports = { imageType, validateImageFile }
