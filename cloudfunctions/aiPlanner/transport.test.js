'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MIN_RETRY_DELAY_MS, MAX_RETRY_AFTER_MS,
  publicAddress, privateAddress, validEndpoint, resolvePublicEndpoint, boundedRetryAfter, httpFailure,
  serializeBody, requestJson,
} = require('./transport')

const url = new URL('https://provider.invalid/v1/responses')
const endpoint = { address: '8.8.8.8', family: 4 }
const config = {
  url,
  apiKey: 'TEST_PLACEHOLDER_ONLY',
  extraHeaders: { 'x-test-scope': 'unit-test' },
  timeoutMs: 100,
}

function fakeRequest(scenario, observed = {}) {
  return (requestedUrl, options, callback) => {
    observed.calls = (observed.calls || 0) + 1
    observed.requestedUrl = requestedUrl
    observed.options = options
    const request = new EventEmitter()
    request.write = (payload) => { observed.payload = payload }
    request.destroy = (error) => { observed.destroyedWith = error }
    request.end = () => {
      if (scenario.neverResponds) return
      const response = new EventEmitter()
      response.statusCode = scenario.statusCode === undefined ? 200 : scenario.statusCode
      response.headers = scenario.headers || {}
      response.resume = () => { observed.resumed = true }
      callback(response)
      if (scenario.afterResponse) scenario.afterResponse(response)
      else {
        if (scenario.body !== undefined) response.emit('data', Buffer.from(scenario.body))
        response.emit('end')
      }
    }
    return request
  }
}

function expectFailure(promise, code, retryable) {
  return assert.rejects(promise, (error) => (
    error.code === code && error.retryable === retryable &&
    !String(error.message).includes('private-upstream-body')
  ))
}

;[
  '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1',
  '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
  '198.51.100.1', '203.0.113.8', '224.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:8.8.8.8',
  '64:ff9b::808:808', 'fc00::1', 'fe80::1', 'fe90::1', 'ff00::1',
  '2001::1', '2001:db8::1', '2002::1', '2620:4f:8000::1', '3ffe::1', '3fff::1',
].forEach((address) => {
  assert.strictEqual(publicAddress(address), false, `${address} must not be treated as public`)
  assert.strictEqual(privateAddress(address), true, `${address} must be blocked`)
})
;['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111'].forEach((address) => {
  assert.strictEqual(publicAddress(address), true, `${address} must be treated as public`)
  assert.strictEqual(privateAddress(address), false, `${address} must be accepted`)
})
assert.strictEqual(validEndpoint({ address: '8.8.8.8', family: 6 }), false)
assert.strictEqual(validEndpoint({ address: '2001:4860:4860::8888', family: 4 }), false)
assert.strictEqual(validEndpoint({ address: '::ffff:8.8.8.8', family: 6 }), false)

assert.throws(() => serializeBody({ text: 'x'.repeat(MAX_REQUEST_BYTES) }), (error) => (
  error.code === 'AI_REQUEST_TOO_LARGE' && error.retryable === false
))
assert.throws(() => {
  const circular = {}; circular.self = circular; serializeBody(circular)
}, (error) => error.code === 'AI_REQUEST_INVALID' && error.retryable === false)

const rateDefault = httpFailure(429, {}, 0)
assert.strictEqual(rateDefault.code, 'AI_UPSTREAM_RATE_LIMITED')
assert.strictEqual(rateDefault.retryable, true)
assert(rateDefault.retryAfterMs >= MIN_RETRY_DELAY_MS && rateDefault.retryAfterMs <= MAX_RETRY_AFTER_MS)
assert.strictEqual(boundedRetryAfter('0', 0), MIN_RETRY_DELAY_MS)
assert.strictEqual(boundedRetryAfter('999999', 0), MAX_RETRY_AFTER_MS)
assert.strictEqual(boundedRetryAfter(new Date(5000).toUTCString(), 1000), 4000)

;[
  [400, 'AI_UPSTREAM_REQUEST_REJECTED', false],
  [401, 'AI_UPSTREAM_AUTH_REJECTED', false],
  [403, 'AI_UPSTREAM_AUTH_REJECTED', false],
  [404, 'AI_UPSTREAM_REQUEST_REJECTED', false],
  [422, 'AI_UPSTREAM_REQUEST_REJECTED', false],
  [408, 'AI_TIMEOUT', true],
  [500, 'AI_UPSTREAM_UNAVAILABLE', true],
  [503, 'AI_UPSTREAM_UNAVAILABLE', true],
].forEach(([status, code, retryable]) => {
  const error = httpFailure(status, {}, 0)
  assert.strictEqual(error.code, code)
  assert.strictEqual(error.retryable, retryable)
  assert.strictEqual(error.statusCode, status)
})

;(async () => {
  const resolved = await resolvePublicEndpoint(url, {
    deadlineAt: Date.now() + 100,
    lookup: async () => [{ address: endpoint.address, family: endpoint.family }],
  })
  assert.deepStrictEqual(resolved, endpoint)

  await expectFailure(resolvePublicEndpoint(url, {
    deadlineAt: Date.now() + 100,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }), 'AI_CONFIGURATION_INVALID', false)

  for (const record of [
    { address: 'fe90::1', family: 6 },
    { address: 'ff00::1', family: 6 },
    { address: '::ffff:127.0.0.1', family: 6 },
    { address: '::ffff:10.0.0.1', family: 6 },
    { address: '8.8.8.8', family: 6 },
  ]) {
    await expectFailure(resolvePublicEndpoint(url, {
      deadlineAt: Date.now() + 100,
      lookup: async () => [record],
    }), 'AI_CONFIGURATION_INVALID', false)
  }

  await expectFailure(resolvePublicEndpoint(url, {
    deadlineAt: Date.now() + 100,
    lookup: async () => [endpoint, { address: '127.0.0.1', family: 4 }],
  }), 'AI_CONFIGURATION_INVALID', false)

  await expectFailure(resolvePublicEndpoint(url, {
    deadlineAt: Date.now() + 15,
    lookup: () => new Promise(() => {}),
  }), 'AI_TIMEOUT', true)

  const observed = {}
  const successful = await requestJson(config, { store: false }, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({ body: '{"status":"completed"}' }, observed),
  })
  assert.deepStrictEqual(successful, { status: 'completed' })
  assert.strictEqual(observed.calls, 1)
  assert.strictEqual(observed.requestedUrl, url)
  assert.strictEqual(observed.options.lookup('ignored', {}, () => {}), undefined)
  assert.strictEqual(observed.options.headers.Authorization, 'Bearer TEST_PLACEHOLDER_ONLY')
  assert.strictEqual(observed.options.headers['x-test-scope'], 'unit-test')
  assert.strictEqual(observed.options.headers['Content-Length'], observed.payload.length)

  for (const statusCode of [301, 302, 303, 307, 308]) {
    const redirectObserved = {}
    await expectFailure(requestJson(config, {}, endpoint, {
      deadlineAt: Date.now() + 100,
      request: fakeRequest({
        statusCode,
        headers: { location: 'https://127.0.0.1/private-target' },
        body: 'private-upstream-body',
      }, redirectObserved),
    }), 'AI_UPSTREAM_REQUEST_REJECTED', false)
    assert.strictEqual(redirectObserved.calls, 1, 'redirects must never trigger another authenticated request')
    assert.strictEqual(redirectObserved.requestedUrl, url)
    assert.strictEqual(redirectObserved.options.headers.Authorization, 'Bearer TEST_PLACEHOLDER_ONLY')
    assert.strictEqual(redirectObserved.resumed, true)
  }

  for (const blockedEndpoint of [
    { address: '::ffff:127.0.0.1', family: 6 },
    { address: '::ffff:10.0.0.1', family: 6 },
    { address: 'fe90::1', family: 6 },
    { address: 'ff00::1', family: 6 },
  ]) {
    let requestCalls = 0
    await expectFailure(requestJson(config, {}, blockedEndpoint, {
      deadlineAt: Date.now() + 100,
      request: () => { requestCalls += 1; throw new Error('must not connect') },
    }), 'AI_CONFIGURATION_INVALID', false)
    assert.strictEqual(requestCalls, 0, 'blocked endpoints must be rejected before authorization can be sent')
  }

  for (const [status, code, retryable] of [
    [400, 'AI_UPSTREAM_REQUEST_REJECTED', false],
    [401, 'AI_UPSTREAM_AUTH_REJECTED', false],
    [403, 'AI_UPSTREAM_AUTH_REJECTED', false],
    [404, 'AI_UPSTREAM_REQUEST_REJECTED', false],
    [422, 'AI_UPSTREAM_REQUEST_REJECTED', false],
    [408, 'AI_TIMEOUT', true],
    [500, 'AI_UPSTREAM_UNAVAILABLE', true],
  ]) {
    await expectFailure(requestJson(config, {}, endpoint, {
      deadlineAt: Date.now() + 100,
      request: fakeRequest({ statusCode: status, body: 'private-upstream-body' }),
    }), code, retryable)
  }

  const rateObserved = {}
  await assert.rejects(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({ statusCode: 429, headers: { 'retry-after': '999999' }, body: 'private-upstream-body' }, rateObserved),
  }), (error) => error.code === 'AI_UPSTREAM_RATE_LIMITED' &&
    error.retryAfterMs === MAX_RETRY_AFTER_MS && rateObserved.resumed === true)

  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    maxResponseBytes: 8,
    request: fakeRequest({ headers: { 'content-length': '9' }, body: '{}' }),
  }), 'AI_RESPONSE_TOO_LARGE', false)

  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    maxResponseBytes: 8,
    request: fakeRequest({ body: '123456789' }),
  }), 'AI_RESPONSE_TOO_LARGE', false)

  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({ body: '{invalid json containing private-upstream-body' }),
  }), 'AI_RESPONSE_INVALID', false)

  const timeoutObserved = {}
  const startedAt = Date.now()
  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: startedAt + 20,
    request: fakeRequest({ neverResponds: true }, timeoutObserved),
  }), 'AI_TIMEOUT', true)
  assert(Date.now() - startedAt < 200)
  assert.strictEqual(timeoutObserved.destroyedWith.code, 'AI_TIMEOUT')

  const partialObserved = {}
  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 20,
    request: fakeRequest({
      afterResponse(response) { response.emit('data', Buffer.from('{"status":')) },
    }, partialObserved),
  }), 'AI_TIMEOUT', true)
  assert.strictEqual(partialObserved.destroyedWith.code, 'AI_TIMEOUT')

  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({ afterResponse(response) { response.emit('aborted') } }),
  }), 'AI_NETWORK_ERROR', true)

  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: () => { throw new Error('private socket diagnostic') },
  }), 'AI_NETWORK_ERROR', true)

  assert.strictEqual(MAX_RESPONSE_BYTES, 512 * 1024)
  console.log('AI transport tests passed')
})().catch((error) => {
  console.error(error && { code: error.code, name: error.name, message: error.message })
  process.exit(1)
})
