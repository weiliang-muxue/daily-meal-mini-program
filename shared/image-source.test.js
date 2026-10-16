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
assert.strictEqual(validSourceUrl('http://example.com/a.jpg?signature=synthetic#ignored').href,
  'https://example.com/a.jpg?signature=synthetic')
assert.strictEqual(validSourceUrl('http://example.com:80/a.jpg').href, 'https://example.com/a.jpg')
assert.strictEqual(validSourceUrl('https://example.com:443/a.jpg').href, 'https://example.com/a.jpg')
;['http://example.com:8080/a.jpg', 'http://example.com:443/a.jpg', 'ftp://example.com/a.jpg',
  'http://user:pass@example.com/a.jpg', 'wxfile://tmp/avatar.jpg', '', { target: 'unresolved-cdn' }]
  .forEach(value => assert.throws(() => validSourceUrl(value), /临时地址无效/))
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

  const upgradeDependencies = fakeDependencies({
    '/image': { statusCode: 200, headers: {}, body: content },
    '/redirect': { statusCode: 302, headers: { location: 'http://cdn.example/image' } },
    '/private-redirect': { statusCode: 302, headers: { location: 'http://private.example/image' } },
  })
  const requested = []
  const request = upgradeDependencies.request
  upgradeDependencies.request = (options, callback) => {
    requested.push(options)
    assert.strictEqual(options.port, 443)
    assert.strictEqual(options.rejectUnauthorized, true)
    assert.strictEqual(options.servername, 'cdn.example')
    assert.strictEqual(options.hostname, '8.8.8.8', '请求必须使用校验后的固定公网地址')
    return request(options, callback)
  }
  for (const sourceUrl of ['http://cdn.example/image', 'https://cdn.example/redirect']) {
    assert.deepStrictEqual(await downloadImageSource({ ...metadata, sourceUrl }, {
      maxBytes: 32, label: '头像', dependencies: upgradeDependencies,
    }), content)
  }
  assert.strictEqual(requested.length, 3)
  await assert.rejects(() => downloadImageSource({ ...metadata, sourceUrl: 'http://cdn.example/private-redirect' }, {
    maxBytes: 32, label: '头像', dependencies: upgradeDependencies,
  }), error => error.code === 'IMAGE_SOURCE_INVALID')

  let tlsRequests = 0
  await assert.rejects(() => downloadImageSource({ ...metadata, sourceUrl: 'http://cdn.example/image' }, {
    maxBytes: 32, label: '头像', dependencies: {
      ...upgradeDependencies,
      request() { tlsRequests += 1; throw Object.assign(new Error('synthetic TLS failure'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) },
    },
  }), error => error.code === 'IMAGE_SOURCE_UNAVAILABLE' && error.imageFetchStage === 'tls' && error.imageSourceProtocol === 'http')
  assert.strictEqual(tlsRequests, 1, 'TLS 失败不得重试明文 HTTP')

  for (const lookup of [async () => { throw new Error('synthetic DNS failure') }, async () => []]) {
    await assert.rejects(() => downloadImageSource(metadata, {
      maxBytes: 32, label: '头像', dependencies: { ...upgradeDependencies, lookup },
    }), error => error.code === 'IMAGE_SOURCE_UNAVAILABLE' && error.retryable === true && error.imageFetchStage === 'dns')
  }

  for (const route of [
    { statusCode: 403, headers: {}, stage: 'http' },
    { statusCode: 200, headers: { 'content-encoding': 'gzip' }, body: content, stage: 'encoding' },
  ]) {
    await assert.rejects(() => downloadImageSource(metadata, {
      maxBytes: 32, label: '头像', dependencies: fakeDependencies({ '/image': route }),
    }), error => error.code === 'IMAGE_SOURCE_UNAVAILABLE' && error.imageFetchStage === route.stage
      && error.imageHttpStatus === route.statusCode && error.imageSourceProtocol === 'https')
  }
  const stalled = fakeDependencies({})
  stalled.request = () => {
    const request = new EventEmitter()
    request.setTimeout = () => {}
    request.end = () => {}
    request.destroy = error => request.emit('error', error)
    return request
  }
  await assert.rejects(() => downloadImageSource(metadata, {
    maxBytes: 32, label: '头像', timeoutMs: 10, dependencies: stalled,
  }), error => error.imageFetchStage === 'timeout', '超时不能被 destroy 的同步 error 误归为网络错误')

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
