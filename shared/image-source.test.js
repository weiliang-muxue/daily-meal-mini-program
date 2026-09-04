'use strict'

const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { downloadImageSource, publicAddress, validMetadata, validSourceUrl } = require('./image-source')

assert.strictEqual(publicAddress('8.8.8.8'), true)
;['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.168.1.1', '100.64.0.1', '203.0.113.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1'].forEach((value) => {
  assert.strictEqual(publicAddress(value), false, `${value} 必须被 SSRF 防护拒绝`)
})
assert.strictEqual(publicAddress('2606:4700:4700::1111'), true)
assert.throws(() => validSourceUrl('http://example.com/a.jpg'), /临时地址无效/)
assert.throws(() => validSourceUrl('https://user:pass@example.com/a.jpg'), /临时地址无效/)
assert.throws(() => validMetadata({ sourceSize: 3, sourceSha256: 'x' }, 10, '头像'), /文件信息无效/)

function fakeDependencies(routes) {
  return {
    now: () => Date.now(),
    lookup: async (hostname) => hostname === 'private.example'
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '8.8.8.8', family: 4 }],
    request(options, callback) {
      const request = new EventEmitter()
      request.setTimeout = () => {}
      request.destroy = (error) => { if (error) request.emit('error', error) }
      request.end = () => {
        const route = routes[options.path] || { statusCode: 404, headers: {}, body: Buffer.alloc(0) }
        const response = new EventEmitter()
        response.statusCode = route.statusCode
        response.headers = route.headers || {}
        response.resume = () => {}
        response.destroy = () => response.emit('error', new Error('destroyed'))
        callback(response)
        if (route.statusCode === 200) {
          ;(route.chunks || [route.body]).forEach((chunk) => response.emit('data', chunk))
          response.emit('end')
        }
      }
      return request
    },
  }
}

function synchronousDependencies(content, counters) {
  return {
    now: () => Date.now(),
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request(options, callback) {
      const request = new EventEmitter()
      request.setTimeout = (value) => { counters.timeoutValues.push(value) }
      request.destroy = () => { counters.destroyed += 1 }
      request.end = () => { counters.ended += 1 }
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = { 'content-length': String(content.length) }
      response.resume = () => {}
      response.destroy = () => {}
      callback(response)
      response.emit('data', content)
      response.emit('end')
      return request
    },
  }
}

;(async () => {
  const content = Buffer.from('image-bytes')
  const metadata = {
    sourceUrl: 'https://cdn.example/image',
    sourceSize: content.length,
    sourceSha256: crypto.createHash('sha256').update(content).digest('hex'),
  }
  const downloaded = await downloadImageSource(metadata, {
    maxBytes: 32, label: '头像', dependencies: fakeDependencies({
      '/image': { statusCode: 200, headers: { 'content-length': String(content.length) }, body: content },
    }),
  })
  assert.deepStrictEqual(downloaded, content)

  const synchronousCounters = { destroyed: 0, ended: 0, timeoutValues: [] }
  const synchronous = await downloadImageSource(metadata, {
    maxBytes: 32,
    label: '头像',
    timeoutMs: 5,
    dependencies: synchronousDependencies(content, synchronousCounters),
  })
  assert.deepStrictEqual(synchronous, content)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepStrictEqual(synchronousCounters, { destroyed: 0, ended: 0, timeoutValues: [] },
    '同步响应完成后不得再创建或触发请求超时器')

  await assert.rejects(() => downloadImageSource({ ...metadata, sourceUrl: 'https://private.example/image' }, {
    maxBytes: 32, label: '头像', dependencies: fakeDependencies({}),
  }), (error) => error.code === 'IMAGE_SOURCE_INVALID')
  await assert.rejects(() => downloadImageSource(metadata, {
    maxBytes: 8, label: '头像', dependencies: fakeDependencies({}),
  }), (error) => error.code === 'IMAGE_METADATA_INVALID')
  await assert.rejects(() => downloadImageSource(metadata, {
    maxBytes: 32, label: '头像', dependencies: fakeDependencies({
      '/image': { statusCode: 200, headers: {}, body: Buffer.from('tampered') },
    }),
  }), (error) => error.code === 'IMAGE_CONTENT_MISMATCH')
  await assert.rejects(() => downloadImageSource({ ...metadata, sourceSize: 20 }, {
    maxBytes: 20, label: '头像', dependencies: fakeDependencies({
      '/image': { statusCode: 200, headers: {}, chunks: [Buffer.alloc(12), Buffer.alloc(12)] },
    }),
  }), (error) => error.code === 'IMAGE_TOO_LARGE')

  console.log('image source security tests passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
