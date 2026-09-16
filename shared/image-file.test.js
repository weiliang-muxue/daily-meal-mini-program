'use strict'

const assert = require('assert')
const { imageType, validateImageFile } = require('./image-file')

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const webp = Buffer.from('RIFF0000WEBP', 'ascii')

assert.strictEqual(imageType(jpeg).extension, 'jpg')
assert.strictEqual(imageType(png).extension, 'png')
assert.strictEqual(imageType(webp).extension, 'webp')
assert.strictEqual(imageType(Buffer.from('<script>')), null)
assert.strictEqual(validateImageFile(jpeg, { maxBytes: 4, label: '头像' }).size, 4)
assert.throws(() => validateImageFile(Buffer.alloc(5, 1), { maxBytes: 4, label: '照片' }), /不能超过 1 MB/)
assert.throws(() => validateImageFile(Buffer.from('not an image'), { maxBytes: 100, label: '照片' }), /必须是 JPG、PNG 或 WebP/)
assert.throws(() => validateImageFile(Buffer.alloc(0), { maxBytes: 100, label: '照片' }), /为空/)

console.log('image file tests passed')
