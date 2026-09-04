'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_ERROR_RESPONSE_BYTES, MIN_RETRY_DELAY_MS, MAX_RETRY_AFTER_MS,
  publicAddress, privateAddress, validEndpoint, resolvePublicEndpoint, boundedRetryAfter, httpFailure,
  parseErrorDescriptor, safeMessageHint, descriptorCategory,
  serializeBody, requestJson,
} = require('./transport')

const url = new URL('https://provider.invalid/v1/responses')
const endpoint = { address: '8.8.8.8', family: 4 }
const config = {
  url,
  apiKey: 'TEST_PLACEHOLDER_ONLY',
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

assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  error: { type: 'invalid_request_error', code: 'model_not_found', param: 'model', message: 'private-upstream-body' },
})), { type: 'invalid_request_error', code: 'model_not_found', param: 'model', hint: '' })
assert.strictEqual(parseErrorDescriptor('{invalid private-upstream-body'), null)
assert.strictEqual(parseErrorDescriptor(JSON.stringify({ error: { message: 'private-upstream-body' } })), null)
assert.strictEqual(safeMessageHint('Model is not supported by any configured account in this group'), 'model')
assert.strictEqual(safeMessageHint('This service is not available in your region'), 'policy')
assert.strictEqual(safeMessageHint('Region parameter is unsupported'), 'parameter')
assert.strictEqual(safeMessageHint('Region parameter is unsupported. This model is unavailable.'), 'model')
assert.strictEqual(safeMessageHint('Unknown parameter: max_output_tokens'), 'parameter')
assert.strictEqual(safeMessageHint('Unsupported responses subpath'), 'endpoint')
assert.strictEqual(safeMessageHint('private-upstream-body with user data'), '')
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  message: 'Model is not supported by any configured account in this group',
})), { type: '', code: '', param: '', hint: 'model' })
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  code: 'model_not_found', error: { message: 'private-upstream-body' },
})), { type: '', code: 'model_not_found', param: '', hint: '' })
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  detail: {
    type: 'Invalid-Request-Error', code: 'Unsupported-Parameter',
    param: 'body.reasoning.effort',
    msg: 'Unsupported parameter reasoning.effort; private-upstream-body',
  },
})), {
  type: 'invalid_request_error', code: 'unsupported_parameter',
  param: 'reasoning.effort', hint: 'parameter',
})
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  detail: [{
    type: 'INVALID.REQUEST.ERROR', code: 'INVALID-PARAMETER',
    loc: ['body', 'text', 'format', 'type'],
    msg: 'Field is invalid; private-upstream-body',
  }],
})), {
  type: 'invalid_request_error', code: 'invalid_parameter',
  param: 'text.format.type', hint: 'parameter',
})
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  code: 'INVALID-PARAMETER',
  msg: 'Unknown parameter: max_output_tokens; private-upstream-body',
})), {
  type: '', code: 'invalid_parameter', param: 'max_output_tokens', hint: 'parameter',
})
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  error: 'INVALID-API-KEY',
  error_description: 'Private credential explanation must never be returned',
})), {
  type: '', code: 'invalid_api_key', param: '', hint: '',
})
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  response: {
    error: {
      type: 'MODEL-NOT-FOUND', code: 'MODEL.NOT.FOUND',
      message: 'Model is not available; private-upstream-body',
    },
  },
})), {
  type: 'model_not_found', code: 'model_not_found', param: '', hint: 'model',
})
assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify({
  detail: [{
    type: 'private_machine_code', code: 'private_code',
    loc: ['body', 'private_secret_parameter'],
    msg: 'Unknown parameter private_secret_parameter; private-upstream-body',
  }],
  nested: {
    response: { error: { code: 'model_not_found', param: 'model' } },
  },
})), { type: '', code: '', param: '', hint: 'parameter' })
assert.strictEqual(descriptorCategory({ code: 'unsupported_parameter', param: 'region', hint: 'policy' }), 'parameter')
assert.strictEqual(descriptorCategory({ code: 'unsupported_country_region_territory' }), 'policy')
assert.strictEqual(descriptorCategory({ type: 'policy' }), 'policy')
assert.strictEqual(descriptorCategory({ code: 'region' }), 'policy')
assert.strictEqual(descriptorCategory({ code: 'model_not_found', param: 'model' }), 'model')
assert.strictEqual(descriptorCategory({ type: 'model_not_found' }), 'model')
for (const code of ['endpoint_not_found', 'route_not_found', 'unsupported_endpoint']) {
  assert.strictEqual(descriptorCategory({ code }), 'endpoint')
  assert.strictEqual(httpFailure(400, {}, 0, { code }).code, 'AI_UPSTREAM_ENDPOINT_NOT_FOUND')
}
assert.strictEqual(descriptorCategory({ type: 'invalid_request_error', param: 'text.format.type' }), 'parameter')
for (const [code, expected] of [
  ['unsupported_country_region_territory', 'policy'],
  ['subscription_not_found', 'account_policy'],
  ['model_not_found', 'model'],
  ['endpoint_not_found', 'endpoint'],
  ['unsupported_parameter', 'parameter'],
]) {
  assert.strictEqual(descriptorCategory({ type: 'request_forbidden', code }), expected)
}
for (const param of ['model', 'reasoning.effort']) {
  assert.strictEqual(descriptorCategory({ code: 'invalid_api_key', param }), 'auth')
  const error = httpFailure(422, {}, 0, { code: 'invalid_api_key', param })
  assert.strictEqual(error.code, 'AI_UPSTREAM_AUTH_REJECTED')
  assert.strictEqual(error.retryable, false)
  assert.strictEqual(error.compatibilityParam, undefined)
}
assert.strictEqual(descriptorCategory({ param: 'model' }), 'model')
assert.strictEqual(httpFailure(400, {}, 0, { param: 'model' }).code, 'AI_UPSTREAM_MODEL_UNAVAILABLE')

const sub2ApiCodeCategories = {
  auth: [
    'access_denied', 'api_key_expired', 'invalid_api_key', 'authentication_error',
    'unauthorized', 'permission_denied', 'forbidden',
    'api_key_required', 'api_key_disabled', 'user_not_found', 'user_inactive',
  ],
  account_policy: [
    'subscription_not_found', 'subscription_invalid',
    'group_deleted', 'group_disabled', 'group_not_allowed',
    'insufficient_balance', 'usage_limit_exceeded', 'insufficient_quota',
    'api_key_quota_exhausted',
  ],
}
for (const [category, codes] of Object.entries(sub2ApiCodeCategories)) {
  for (const code of codes) {
    assert.strictEqual(descriptorCategory({ code }), category)
    for (const payload of [
      { code, message: 'private-upstream-body' },
      { error: { code, message: 'private-upstream-body' } },
    ]) {
      assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify(payload)), {
        type: '', code, param: '', hint: '',
      })
    }
    const status = category === 'account_policy' ? 429 : 403
    const expectedCode = category === 'account_policy'
      ? 'AI_UPSTREAM_POLICY_REJECTED'
      : 'AI_UPSTREAM_FORBIDDEN'
    const error = httpFailure(status, { 'retry-after': '10' }, 0, { code })
    assert.strictEqual(error.code, expectedCode)
    assert.strictEqual(error.retryable, false)
    assert.strictEqual(error.statusCode, status)
    assert.strictEqual(error.retryAfterMs, undefined)
  }
}
assert.strictEqual(
  httpFailure(429, {}, 0, { code: 'api_key_expired' }).code,
  'AI_UPSTREAM_AUTH_REJECTED',
)

const sub2ApiFixedCodeCases = [
  {
    codes: ['invalid_auth_rate_limited', 'rate_limit_exceeded'],
    category: 'rate_limit', status: 429,
    expectedCode: 'AI_UPSTREAM_RATE_LIMITED', retryable: true,
  },
  {
    codes: ['api_key_auth_overloaded', 'internal_error', 'subscription_maintenance_failed'],
    category: 'upstream', status: 500,
    expectedCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true,
  },
  {
    codes: ['api_key_in_query_deprecated'],
    category: 'request_configuration', status: 400,
    expectedCode: 'AI_CONFIGURATION_INVALID', retryable: false,
  },
]
for (const fixedCase of sub2ApiFixedCodeCases) {
  for (const code of fixedCase.codes) {
    assert.strictEqual(descriptorCategory({ type: 'request_forbidden', code }), fixedCase.category)
    for (const payload of [
      { code: code.toUpperCase().replace(/_/g, '-'), message: 'private-root-envelope' },
      { error: { type: 'request_forbidden', code, message: 'private-nested-envelope' } },
    ]) {
      const descriptor = parseErrorDescriptor(JSON.stringify(payload))
      assert.strictEqual(descriptor.code, code)
      assert.strictEqual(descriptorCategory(descriptor), fixedCase.category)
      assert(!JSON.stringify(descriptor).includes('private-'))
    }
    const error = httpFailure(
      fixedCase.status,
      { 'retry-after': '1', 'x-private-header': 'private-header-value' },
      0,
      { type: 'request_forbidden', code },
    )
    assert.strictEqual(error.code, fixedCase.expectedCode)
    assert.strictEqual(error.retryable, fixedCase.retryable)
    assert.strictEqual(error.statusCode, fixedCase.status)
    assert.strictEqual(error.compatibilityParam, undefined)
  }
}

const sub2ApiFixedTypeCases = [
  {
    type: 'rate_limit_exceeded', category: 'rate_limit', status: 429,
    expectedCode: 'AI_UPSTREAM_RATE_LIMITED', retryable: true,
  },
  {
    type: 'billing_service_error', category: 'upstream', status: 503,
    expectedCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true,
  },
  {
    type: 'billing_error', category: 'account_policy', status: 403,
    expectedCode: 'AI_UPSTREAM_POLICY_REJECTED', retryable: false,
  },
]
for (const fixedCase of sub2ApiFixedTypeCases) {
  assert.strictEqual(descriptorCategory({ type: fixedCase.type }), fixedCase.category)
  for (const payload of [
    { type: fixedCase.type.toUpperCase().replace(/_/g, '-'), message: 'private-root-envelope' },
    { error: { type: fixedCase.type, message: 'private-nested-envelope' } },
  ]) {
    const descriptor = parseErrorDescriptor(JSON.stringify(payload))
    assert.strictEqual(descriptor.type, fixedCase.type)
    assert.strictEqual(descriptorCategory(descriptor), fixedCase.category)
    assert(!JSON.stringify(descriptor).includes('private-'))
  }
  const error = httpFailure(fixedCase.status, { 'retry-after': '1' }, 0, { type: fixedCase.type })
  assert.strictEqual(error.code, fixedCase.expectedCode)
  assert.strictEqual(error.retryable, fixedCase.retryable)
}

for (const [type, category, status, expectedCode, retryable] of [
  ['authentication_error', 'auth', 429, 'AI_UPSTREAM_AUTH_REJECTED', false],
  ['authorization_error', 'auth', 429, 'AI_UPSTREAM_AUTH_REJECTED', false],
  ['permission_error', 'auth', 429, 'AI_UPSTREAM_AUTH_REJECTED', false],
  ['request_forbidden', 'auth', 429, 'AI_UPSTREAM_AUTH_REJECTED', false],
  ['upstream_error', 'upstream', 429, 'AI_UPSTREAM_UNAVAILABLE', true],
]) {
  assert.strictEqual(descriptorCategory({ type }), category)
  for (const payload of [
    { type, message: 'private-upstream-body' },
    { error: { type, message: 'private-upstream-body' } },
  ]) {
    assert.deepStrictEqual(parseErrorDescriptor(JSON.stringify(payload)), {
      type, code: '', param: '', hint: '',
    })
  }
  const error = httpFailure(status, { 'retry-after': '10' }, 0, { type })
  assert.strictEqual(error.code, expectedCode)
  assert.strictEqual(error.retryable, retryable)
  assert.strictEqual(error.statusCode, status)
  assert.strictEqual(error.retryAfterMs, undefined)
}
for (const payload of [
  { code: 'GROUP_PRIVATE' },
  { error: { code: 'GROUP_PRIVATE' } },
]) {
  assert.strictEqual(parseErrorDescriptor(JSON.stringify(payload)), null)
}
assert.strictEqual(descriptorCategory({ code: 'group_private' }), '')
assert.strictEqual(httpFailure(401, {}, 0, { type: 'upstream_error' }).code, 'AI_UPSTREAM_AUTH_REJECTED')
assert.strictEqual(httpFailure(408, {}, 0, { code: 'insufficient_quota' }).code, 'AI_TIMEOUT')
assert.strictEqual(httpFailure(500, {}, 0, { code: 'access_denied' }).code, 'AI_UPSTREAM_UNAVAILABLE')

;[
  [400, 'AI_UPSTREAM_REQUEST_REJECTED', false],
  [401, 'AI_UPSTREAM_AUTH_REJECTED', false],
  [403, 'AI_UPSTREAM_FORBIDDEN', false],
  [404, 'AI_UPSTREAM_ENDPOINT_NOT_FOUND', false],
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
assert.strictEqual(httpFailure(429, {}, 0, { param: 'model' }).code, 'AI_UPSTREAM_RATE_LIMITED')
assert.strictEqual(httpFailure(500, {}, 0, { code: 'unsupported_parameter' }).code, 'AI_UPSTREAM_UNAVAILABLE')
assert.strictEqual(httpFailure(403, {}, 0, { code: 'model_not_found' }).code, 'AI_UPSTREAM_MODEL_UNAVAILABLE')

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
  assert.deepStrictEqual(Object.keys(observed.options.headers).sort(), [
    'Authorization', 'Content-Length', 'Content-Type',
  ])
  assert.strictEqual(observed.options.headers['Content-Type'], 'application/json')
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
    [403, 'AI_UPSTREAM_FORBIDDEN', false],
    [404, 'AI_UPSTREAM_ENDPOINT_NOT_FOUND', false],
    [422, 'AI_UPSTREAM_REQUEST_REJECTED', false],
    [408, 'AI_TIMEOUT', true],
    [500, 'AI_UPSTREAM_UNAVAILABLE', true],
  ]) {
    await expectFailure(requestJson(config, {}, endpoint, {
      deadlineAt: Date.now() + 100,
      request: fakeRequest({ statusCode: status, body: 'private-upstream-body' }),
    }), code, retryable)
  }

  for (const diagnostic of [
    {
      status: 404,
      body: { error: { type: 'model_not_found', message: 'private-upstream-body' } },
      code: 'AI_UPSTREAM_MODEL_UNAVAILABLE',
    },
    {
      status: 422,
      body: { error: { type: 'invalid_request_error', code: 'unsupported_parameter', param: 'reasoning.effort', message: 'private-upstream-body' } },
      code: 'AI_UPSTREAM_PARAMETER_REJECTED',
      compatibilityParam: 'reasoning.effort',
    },
    {
      status: 403,
      body: { error: { type: 'request_forbidden', code: 'unsupported_country_region_territory', message: 'private-upstream-body' } },
      code: 'AI_UPSTREAM_POLICY_REJECTED',
    },
  ]) {
    await assert.rejects(requestJson(config, {}, endpoint, {
      deadlineAt: Date.now() + 100,
      request: fakeRequest({ statusCode: diagnostic.status, body: JSON.stringify(diagnostic.body) }),
    }), (error) => {
      const visible = `${error.code} ${error.message} ${JSON.stringify(error)}`
      return error.code === diagnostic.code && error.retryable === false &&
        !visible.includes('private-upstream-body') && !visible.includes('reasoning.effort') &&
        !Object.prototype.hasOwnProperty.call(error, 'descriptor') &&
        error.compatibilityParam === diagnostic.compatibilityParam &&
        !Object.keys(error).includes('compatibilityParam') &&
        !JSON.stringify(error).includes('compatibilityParam') &&
        !String(error).includes('compatibilityParam')
    })
  }

  const sub2ApiFailures = [
    ...sub2ApiCodeCategories.auth.map((upstreamCode, index) => ({
      upstreamCode,
      status: index ? 429 : 403,
      expectedCode: index ? 'AI_UPSTREAM_AUTH_REJECTED' : 'AI_UPSTREAM_FORBIDDEN',
      retryable: false,
    })),
    ...sub2ApiCodeCategories.account_policy.map((upstreamCode) => ({
      upstreamCode,
      status: 429,
      expectedCode: 'AI_UPSTREAM_POLICY_REJECTED',
      retryable: false,
    })),
    {
      upstreamType: 'permission_error',
      status: 429,
      expectedCode: 'AI_UPSTREAM_AUTH_REJECTED',
      retryable: false,
    },
    {
      upstreamType: 'upstream_error',
      status: 429,
      expectedCode: 'AI_UPSTREAM_UNAVAILABLE',
      retryable: true,
    },
  ]
  for (const [index, diagnostic] of sub2ApiFailures.entries()) {
    const machineToken = diagnostic.upstreamCode || diagnostic.upstreamType
    const privateMarker = `private-sub2api-body-${index}`
    const detail = {
      ...(diagnostic.upstreamCode ? { code: diagnostic.upstreamCode } : {}),
      ...(diagnostic.upstreamType ? { type: diagnostic.upstreamType } : {}),
      message: privateMarker,
    }
    const body = index % 2 ? { error: detail } : detail
    await assert.rejects(requestJson(config, {}, endpoint, {
      deadlineAt: Date.now() + 100,
      request: fakeRequest({ statusCode: diagnostic.status, body: JSON.stringify(body) }),
    }), (error) => {
      const visible = `${String(error)} ${JSON.stringify(error)}`.toLowerCase()
      return error.code === diagnostic.expectedCode && error.retryable === diagnostic.retryable &&
        !visible.includes(privateMarker) && !visible.includes(machineToken) &&
        !Object.prototype.hasOwnProperty.call(error, 'descriptor')
    })
  }

  const fixedEnvelopeFailures = [
    { code: 'api_key_required', status: 401, expectedCode: 'AI_UPSTREAM_AUTH_REJECTED', retryable: false },
    { code: 'api_key_disabled', status: 401, expectedCode: 'AI_UPSTREAM_AUTH_REJECTED', retryable: false },
    { code: 'user_not_found', status: 401, expectedCode: 'AI_UPSTREAM_AUTH_REJECTED', retryable: false },
    { code: 'user_inactive', status: 401, expectedCode: 'AI_UPSTREAM_AUTH_REJECTED', retryable: false },
    { code: 'invalid_auth_rate_limited', status: 429, expectedCode: 'AI_UPSTREAM_RATE_LIMITED', retryable: true },
    { code: 'rate_limit_exceeded', status: 429, expectedCode: 'AI_UPSTREAM_RATE_LIMITED', retryable: true },
    { code: 'api_key_auth_overloaded', status: 503, expectedCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true },
    { code: 'internal_error', status: 500, expectedCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true },
    { code: 'subscription_maintenance_failed', status: 500, expectedCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true },
    { code: 'api_key_quota_exhausted', status: 429, expectedCode: 'AI_UPSTREAM_POLICY_REJECTED', retryable: false },
    { code: 'api_key_in_query_deprecated', status: 400, expectedCode: 'AI_CONFIGURATION_INVALID', retryable: false },
    { type: 'billing_service_error', status: 503, expectedCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true },
    { type: 'billing_error', status: 403, expectedCode: 'AI_UPSTREAM_POLICY_REJECTED', retryable: false },
    { type: 'rate_limit_exceeded', status: 429, expectedCode: 'AI_UPSTREAM_RATE_LIMITED', retryable: true },
  ]
  const privateHeaderMarker = 'PRIVATE_FIXED_HEADER_MUST_NOT_LEAK'
  const privateIdentityMarker = 'PRIVATE_FIXED_IDENTITY_MUST_NOT_LEAK'
  for (const [index, diagnostic] of fixedEnvelopeFailures.entries()) {
    const machineToken = diagnostic.code || diagnostic.type
    const privateMessageMarker = `PRIVATE_FIXED_MESSAGE_${index}_MUST_NOT_LEAK`
    const descriptor = diagnostic.code ? { code: diagnostic.code } : { type: diagnostic.type }
    for (const body of [
      { ...descriptor, message: `${privateMessageMarker} ${privateIdentityMarker}` },
      { error: { ...descriptor, message: `${privateMessageMarker} ${privateIdentityMarker}` } },
    ]) {
      await assert.rejects(requestJson(config, {}, endpoint, {
        deadlineAt: Date.now() + 100,
        request: fakeRequest({
          statusCode: diagnostic.status,
          headers: { 'retry-after': '1', 'x-private-test': privateHeaderMarker },
          body: JSON.stringify(body),
        }),
      }), (error) => {
        const visible = Object.getOwnPropertyNames(error).map((name) => {
          const value = error[name]
          return typeof value === 'string' ? value : JSON.stringify(value)
        }).join(' ')
        return error.code === diagnostic.expectedCode && error.retryable === diagnostic.retryable &&
          error.compatibilityParam === undefined &&
          !visible.includes(machineToken) && !visible.includes(privateMessageMarker) &&
          !visible.includes(privateHeaderMarker) && !visible.includes(privateIdentityMarker) &&
          !visible.includes(String(config.url)) && !visible.includes(config.apiKey) &&
          !Object.prototype.hasOwnProperty.call(error, 'descriptor')
      })
    }
  }

  await assert.rejects(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({
      statusCode: 429,
      headers: { 'retry-after': '1' },
      body: JSON.stringify({ error: { code: 'GROUP_PRIVATE', message: 'private-upstream-body' } }),
    }),
  }), (error) => error.code === 'AI_UPSTREAM_RATE_LIMITED' && error.retryable === true &&
    !JSON.stringify(error).includes('GROUP_PRIVATE') && !JSON.stringify(error).includes('private-upstream-body'))

  const privateCredential = 'test_private_credential_987654321'
  await assert.rejects(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({
      statusCode: 400,
      body: JSON.stringify({
        error: {
          type: privateCredential,
          code: privateCredential,
          param: privateCredential,
          message: `Unknown parameter ${privateCredential}; credential=${privateCredential}`,
        },
      }),
    }),
  }), (error) => error.code === 'AI_UPSTREAM_PARAMETER_REJECTED' &&
    error.compatibilityParam === undefined &&
    !JSON.stringify(error).includes(privateCredential))

  const fixedPathPrivateMarker = 'FIXED_PATH_PRIVATE_MESSAGE_MUST_NOT_LEAK'
  await assert.rejects(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({
      statusCode: 400,
      body: JSON.stringify({
        response: {
          error: {
            type: 'INVALID-REQUEST-ERROR',
            code: 'UNSUPPORTED-PARAMETER',
            param: 'request.text.format.type',
            error_description: `Unknown parameter text.format.type; ${fixedPathPrivateMarker}; ${config.apiKey}`,
          },
        },
      }),
    }),
  }), (error) => error.code === 'AI_UPSTREAM_PARAMETER_REJECTED' &&
    error.compatibilityParam === 'text.format.type' &&
    !Object.keys(error).includes('compatibilityParam') &&
    !JSON.stringify(error).includes(fixedPathPrivateMarker) && !JSON.stringify(error).includes(config.apiKey))

  const oversizedPrivateBody = JSON.stringify({
    error: { code: 'model_not_found', param: 'model', message: `private-upstream-body${'x'.repeat(MAX_ERROR_RESPONSE_BYTES)}` },
  })
  const oversizedPrivateObserved = {}
  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({ statusCode: 400, body: oversizedPrivateBody }, oversizedPrivateObserved),
  }), 'AI_UPSTREAM_REQUEST_REJECTED', false)
  assert.strictEqual(oversizedPrivateObserved.destroyedWith.code, 'AI_UPSTREAM_REQUEST_REJECTED')

  const declaredOversizeObserved = {}
  await expectFailure(requestJson(config, {}, endpoint, {
    deadlineAt: Date.now() + 100,
    request: fakeRequest({
      statusCode: 400,
      headers: { 'content-length': String(MAX_ERROR_RESPONSE_BYTES + 1) },
      body: 'private-upstream-body',
    }, declaredOversizeObserved),
  }), 'AI_UPSTREAM_REQUEST_REJECTED', false)
  assert.strictEqual(declaredOversizeObserved.destroyedWith.code, 'AI_UPSTREAM_REQUEST_REJECTED')

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
  assert.strictEqual(MAX_ERROR_RESPONSE_BYTES, 16 * 1024)
  console.log('AI transport tests passed')
})().catch((error) => {
  console.error(error && { code: error.code, name: error.name, message: error.message })
  process.exit(1)
})
