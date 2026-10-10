'use strict'

const dns = require('dns').promises
const https = require('https')
const net = require('net')

const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024
const DEFAULT_RETRY_DELAY_MS = 1000
const MIN_RETRY_DELAY_MS = 600
const MAX_RETRY_AFTER_MS = 30 * 1000

const SAFE_PROVIDER_TYPES = new Set([
  'api_error',
  'authentication_error',
  'authorization_error',
  'billing_error',
  'billing_service_error',
  'invalid_request_error',
  'model_not_found',
  'permission_error',
  'policy_error',
  'rate_limit_exceeded',
  'rate_limit_error',
  'request_forbidden',
  'server_error',
  'service_unavailable_error',
  'upstream_error',
])
const SAFE_PROVIDER_CODES = new Set([
  'access_denied',
  'access_terminated',
  'api_key_auth_overloaded',
  'api_key_disabled',
  'api_key_expired',
  'api_key_in_query_deprecated',
  'api_key_quota_exhausted',
  'api_key_required',
  'authentication_error',
  'endpoint_not_found',
  'forbidden',
  'group_deleted',
  'group_disabled',
  'group_not_allowed',
  'internal_error',
  'invalid_auth_rate_limited',
  'invalid_api_key',
  'invalid_model',
  'invalid_parameter',
  'invalid_request_argument',
  'insufficient_balance',
  'insufficient_quota',
  'missing_required_parameter',
  'model_access_denied',
  'model_not_found',
  'model_unavailable',
  'permission_denied',
  'rate_limit_error',
  'rate_limit_exceeded',
  'route_not_found',
  'server_error',
  'service_unavailable',
  'subscription_maintenance_failed',
  'subscription_invalid',
  'subscription_not_found',
  'unauthorized',
  'unknown_parameter',
  'unrecognized_request_argument',
  'unsupported_country_region_territory',
  'unsupported_endpoint',
  'unsupported_model',
  'unsupported_parameter',
  'usage_limit_exceeded',
  'user_inactive',
  'user_not_found',
])
const SAFE_PROVIDER_PARAMS = new Set([
  'input',
  'instructions',
  'max_output_tokens',
  'model',
  'reasoning',
  'reasoning.effort',
  'store',
  'stream',
  'temperature',
  'text',
  'text.format',
  'text.format.type',
])

function transportError(code, message, options = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = options.retryable === true
  if (Number.isInteger(options.statusCode)) error.statusCode = options.statusCode
  if (Number.isInteger(options.retryAfterMs)) error.retryAfterMs = options.retryAfterMs
  const compatibilityParam = allowedParameter(options.compatibilityParam)
  if (compatibilityParam) {
    Object.defineProperty(error, 'compatibilityParam', {
      value: compatibilityParam,
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }
  return error
}

function ipv4Value(address) {
  if (!net.isIPv4(String(address))) return null
  return String(address).split('.').reduce((value, part) => (
    (value * 256) + Number(part)
  ), 0)
}

function inIpv4Range(value, prefix, bits) {
  const blockSize = 2 ** (32 - bits)
  return Math.floor(value / blockSize) === Math.floor(prefix / blockSize)
}

function publicIpv4(address) {
  const value = ipv4Value(address)
  if (value === null) return false
  const rejected = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ]
  return !rejected.some(([prefix, bits]) => inIpv4Range(value, ipv4Value(prefix), bits))
}

function ipv6Value(address) {
  let source = String(address).toLowerCase()
  if (source.includes('%')) return null
  if (source.includes('.')) {
    const separator = source.lastIndexOf(':')
    const ipv4 = source.slice(separator + 1)
    const parts = ipv4.split('.').map(Number)
    if (!net.isIPv4(ipv4)) return null
    source = `${source.slice(0, separator)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = source.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const words = [...left, ...Array(missing).fill('0'), ...right]
  if (words.length !== 8) return null
  return BigInt(`0x${words.map((part) => part.padStart(4, '0')).join('')}`)
}

function inIpv6Range(value, prefix, bits) {
  const shift = 128n - BigInt(bits)
  return (value >> shift) === (prefix >> shift)
}

function publicIpv6(address) {
  if (!net.isIPv6(String(address))) return false
  const value = ipv6Value(address)
  if (value === null) return false
  const globalStart = 0x20000000000000000000000000000000n
  if (!inIpv6Range(value, globalStart, 3)) return false
  const rejected = [
    [0x20010000000000000000000000000000n, 23],
    [0x20010db8000000000000000000000000n, 32],
    [0x20020000000000000000000000000000n, 16],
    [0x2620004f800000000000000000000000n, 48],
    [0x3ffe0000000000000000000000000000n, 16],
    [0x3fff0000000000000000000000000000n, 20],
  ]
  return !rejected.some(([prefix, bits]) => inIpv6Range(value, prefix, bits))
}

function publicAddress(address) {
  const family = net.isIP(String(address))
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false
}

function privateAddress(address) {
  return !publicAddress(address)
}

function validEndpoint(endpoint) {
  if (!endpoint) return false
  const family = net.isIP(String(endpoint.address))
  return publicAddress(endpoint.address) && family === Number(endpoint.family)
}

function validDeadline(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw transportError('AI_CONFIGURATION_INVALID', 'AI 请求截止时间无效', { retryable: false })
  }
  return value
}

function timeoutError() {
  return transportError('AI_TIMEOUT', 'AI 生成超时', { retryable: true })
}

function withDeadline(promise, deadlineAt, options = {}) {
  const now = options.now || Date.now
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const remaining = Math.ceil(validDeadline(deadlineAt) - now())
  if (remaining <= 0) return Promise.reject(timeoutError())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimer(timer)
      callback(value)
    }
    const timer = setTimer(() => finish(reject, timeoutError()), remaining)
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

async function resolvePublicEndpoint(url, options = {}) {
  if (!url || typeof url.hostname !== 'string') {
    throw transportError('AI_CONFIGURATION_INVALID', 'AI 服务地址不可用', { retryable: false })
  }
  const lookup = options.lookup || dns.lookup.bind(dns)
  let records
  try {
    records = await withDeadline(
      Promise.resolve().then(() => lookup(url.hostname, { all: true })),
      options.deadlineAt,
      options,
    )
  } catch (error) {
    if (error && error.code === 'AI_TIMEOUT') throw error
    throw transportError('AI_NETWORK_ERROR', 'AI 服务地址解析失败', { retryable: true })
  }
  if (!Array.isArray(records) || !records.length || records.some((record) => !validEndpoint(record))) {
    throw transportError('AI_CONFIGURATION_INVALID', 'AI 服务地址不可用', { retryable: false })
  }
  return { address: records[0].address, family: Number(records[0].family) }
}

function boundedRetryAfter(value, now = Date.now()) {
  const source = Array.isArray(value) ? value[0] : value
  let delay = Number.NaN
  if (typeof source === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(source)) {
    delay = Number(source) * 1000
  } else if (typeof source === 'number' && Number.isFinite(source)) {
    delay = source * 1000
  } else if (typeof source === 'string' && source.trim()) {
    const instant = Date.parse(source)
    if (Number.isFinite(instant)) delay = instant - now
  }
  if (!Number.isFinite(delay)) delay = DEFAULT_RETRY_DELAY_MS
  return Math.max(MIN_RETRY_DELAY_MS, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(delay)))
}

function safeErrorToken(value) {
  if (typeof value !== 'string') return ''
  const token = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_.\-[\]]{0,127}$/.test(token) ? token : ''
}

function normalizedMachineToken(value, allowed) {
  const token = safeErrorToken(value)
  if (!token) return ''
  if (allowed.has(token)) return token
  const normalized = token.replace(/[.-]+/g, '_')
  return allowed.has(normalized) ? normalized : ''
}

function safeMessageHint(value) {
  if (typeof value !== 'string') return ''
  const message = value.slice(0, 2048).toLowerCase()
  if (/(?:service|api|access|request)(?:\s+is)?\s+(?:not available|unsupported|restricted|denied|forbidden)\s+(?:in|from|for)\s+(?:your|this|the)?\s*(?:country|region|territory|jurisdiction)/.test(message) ||
      /(?:country|region|territory|jurisdiction)(?:\s+is)?\s+(?:not supported|restricted|denied|forbidden)/.test(message)) return 'policy'
  if (/(?:policy|safety policy|access terminated)/.test(message) &&
      /(?:restricted|violation|denied|forbidden|terminated|not allowed)/.test(message)) return 'policy'
  if (/\bmodel\b/.test(message) &&
      /(?:not found|not supported|not available|unsupported|unavailable|does not exist|no configured account|access denied|permission)/.test(message)) {
    return 'model'
  }
  if (/(?:unknown|unsupported|unrecognized|invalid|missing|required|extra)\s+(?:request\s+)?(?:parameter|argument|field)/.test(message) ||
      /(?:parameter|argument|field)\s+[^\r\n]{0,80}(?:not supported|unsupported|not allowed|required|invalid|unknown)/.test(message)) {
    return 'parameter'
  }
  if (/(?:unsupported|unknown)\s+(?:responses?\s+)?(?:subpath|endpoint|route)|endpoint\s+not\s+found/.test(message)) {
    return 'endpoint'
  }
  return ''
}

function errorObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function descriptorSource(parsed) {
  const directError = errorObject(parsed.error)
  if (directError) return directError
  const detail = errorObject(parsed.detail)
  if (detail) return detail
  if (Array.isArray(parsed.detail)) {
    const item = parsed.detail.slice(0, 8).find((value) => errorObject(value))
    if (item) return item
  }
  const response = errorObject(parsed.response)
  const responseError = response && errorObject(response.error)
  return responseError || parsed
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value) || ''
}

function allowedParameter(value) {
  if (Array.isArray(value)) value = value.filter((part) => typeof part === 'string').join('.')
  const token = safeErrorToken(value)
  if (!token) return ''
  if (SAFE_PROVIDER_PARAMS.has(token)) return token
  for (const prefix of ['body.', 'request.', 'payload.']) {
    if (token.startsWith(prefix)) {
      const unwrapped = token.slice(prefix.length)
      if (SAFE_PROVIDER_PARAMS.has(unwrapped)) return unwrapped
    }
  }
  return ''
}

function parameterFromMessage(value) {
  if (typeof value !== 'string' || !/(?:parameter|argument|field)/i.test(value)) return ''
  const message = value.slice(0, 2048).toLowerCase()
  return [...SAFE_PROVIDER_PARAMS]
    .sort((left, right) => right.length - left.length)
    .find((param) => {
      const offset = message.indexOf(param)
      if (offset < 0) return false
      const before = offset ? message[offset - 1] : ''
      const after = message[offset + param.length] || ''
      return !/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)
    }) || ''
}

function parseErrorDescriptor(payload) {
  let parsed
  try { parsed = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || '')) } catch (_) {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const source = descriptorSource(parsed)
  const message = firstText(
    source.message, source.msg, source.error_description,
    parsed.message, parsed.msg, parsed.error_description,
    typeof parsed.detail === 'string' ? parsed.detail : '',
  )
  const rawCode = firstText(
    source.code,
    typeof parsed.code === 'string' ? parsed.code : '',
    typeof parsed.error === 'string' ? parsed.error : '',
  )
  const param = allowedParameter(source.param || source.parameter || source.loc)
    || allowedParameter(parsed.param || parsed.parameter)
    || parameterFromMessage(message)
  const descriptor = {
    type: normalizedMachineToken(source.type || parsed.type, SAFE_PROVIDER_TYPES),
    code: normalizedMachineToken(rawCode, SAFE_PROVIDER_CODES),
    param,
    hint: safeMessageHint(message),
  }
  return descriptor.type || descriptor.code || descriptor.param || descriptor.hint ? descriptor : null
}

function descriptorCategory(descriptor) {
  if (!descriptor) return ''
  const { type = '', code = '', param = '', hint = '' } = descriptor
  // A provider may pair a broad type such as request_forbidden with a more
  // precise machine code. Classify the fixed code before falling back to type.
  if ([
    'subscription_not_found', 'subscription_invalid',
    'group_deleted', 'group_disabled', 'group_not_allowed',
    'insufficient_balance', 'usage_limit_exceeded', 'insufficient_quota',
    'api_key_quota_exhausted',
  ].includes(code)) {
    return 'account_policy'
  }
  if (['invalid_auth_rate_limited', 'rate_limit_exceeded'].includes(code)) {
    return 'rate_limit'
  }
  if ([
    'api_key_auth_overloaded', 'internal_error', 'subscription_maintenance_failed',
  ].includes(code)) {
    return 'upstream'
  }
  if (code === 'api_key_in_query_deprecated') return 'request_configuration'
  if (/(?:^|[_.-])(country|region|territory|policy|safety|restricted|restriction)(?:$|[_.-])/.test(code) ||
      ['unsupported_country_region_territory', 'access_terminated'].includes(code)) {
    return 'policy'
  }
  if (code.includes('model') &&
      /(not_found|unavailable|unsupported|invalid|access|permission|denied)/.test(code)) {
    return 'model'
  }
  if (['endpoint_not_found', 'route_not_found', 'unsupported_endpoint'].includes(code)) {
    return 'endpoint'
  }
  if ([
    'invalid_parameter', 'unsupported_parameter', 'unknown_parameter',
    'unrecognized_request_argument', 'invalid_request_argument',
  ].includes(code)) return 'parameter'
  if ([
    'access_denied', 'api_key_expired', 'invalid_api_key', 'authentication_error',
    'unauthorized', 'permission_denied', 'forbidden',
    'api_key_required', 'api_key_disabled', 'user_not_found', 'user_inactive',
  ].includes(code)) {
    return 'auth'
  }
  if (param === 'model') return 'model'
  if (param) return 'parameter'
  if (['billing_error'].includes(type)) return 'account_policy'
  if (['billing_service_error', 'upstream_error'].includes(type)) return 'upstream'
  if (type === 'rate_limit_exceeded') return 'rate_limit'
  if (/(?:^|[_.-])(country|region|territory|policy|safety|restricted|restriction)(?:$|[_.-])/.test(type)) {
    return 'policy'
  }
  if (type.includes('model') &&
      /(not_found|unavailable|unsupported|invalid|access|permission|denied)/.test(type)) {
    return 'model'
  }
  if ([
    'authentication_error', 'authorization_error', 'permission_error', 'request_forbidden',
  ].includes(type)) {
    return 'auth'
  }
  if (['policy', 'model', 'parameter', 'endpoint'].includes(hint)) return hint
  return ''
}

function httpFailure(statusCode, headers = {}, now = Date.now(), descriptor = null) {
  const status = Number(statusCode)
  const common = { statusCode: Number.isInteger(status) ? status : 0, retryable: false }
  const failure = (code, message, options = common) => (
    transportError(code, message, options)
  )
  if (status === 401) {
    return failure('AI_UPSTREAM_AUTH_REJECTED', 'AI 服务拒绝了鉴权')
  }
  if (status === 408) return failure('AI_TIMEOUT', 'AI 服务请求超时', { ...common, retryable: true })
  if (status >= 500 && status <= 599) {
    return failure('AI_UPSTREAM_UNAVAILABLE', 'AI 服务暂时不可用', { ...common, retryable: true })
  }
  const category = [400, 403, 404, 422, 429].includes(status) ? descriptorCategory(descriptor) : ''
  if (category === 'account_policy') {
    return failure('AI_UPSTREAM_POLICY_REJECTED', 'AI 服务策略不允许当前请求')
  }
  if (category === 'auth') {
    return status === 403
      ? failure('AI_UPSTREAM_FORBIDDEN', 'AI 服务拒绝了当前访问')
      : failure('AI_UPSTREAM_AUTH_REJECTED', 'AI 服务拒绝了鉴权')
  }
  if (category === 'upstream') {
    return failure('AI_UPSTREAM_UNAVAILABLE', 'AI 服务暂时不可用', { ...common, retryable: true })
  }
  if (category === 'rate_limit') {
    return failure('AI_UPSTREAM_RATE_LIMITED', 'AI 服务暂时繁忙', {
      ...common,
      retryable: true,
      retryAfterMs: boundedRetryAfter(headers['retry-after'], now),
    })
  }
  if (category === 'request_configuration') {
    return failure('AI_CONFIGURATION_INVALID', 'AI 请求配置无效')
  }
  if (status === 429) {
    return failure('AI_UPSTREAM_RATE_LIMITED', 'AI 服务暂时繁忙', {
      ...common,
      retryable: true,
      retryAfterMs: boundedRetryAfter(headers['retry-after'], now),
    })
  }
  if (category === 'policy') {
    return failure('AI_UPSTREAM_POLICY_REJECTED', 'AI 服务策略不允许当前请求')
  }
  if (category === 'model') {
    return failure('AI_UPSTREAM_MODEL_UNAVAILABLE', 'AI 服务不支持当前模型')
  }
  if (category === 'parameter') {
    return failure('AI_UPSTREAM_PARAMETER_REJECTED', 'AI 服务不支持当前请求参数', {
      ...common,
      compatibilityParam: descriptor && descriptor.param,
    })
  }
  if (category === 'endpoint') {
    return failure('AI_UPSTREAM_ENDPOINT_NOT_FOUND', 'AI 服务接口不存在')
  }
  if (status === 403) {
    return failure('AI_UPSTREAM_FORBIDDEN', 'AI 服务拒绝了当前访问')
  }
  if (status === 404) {
    return failure('AI_UPSTREAM_ENDPOINT_NOT_FOUND', 'AI 服务接口不存在')
  }
  if ([400, 422].includes(status)) {
    return failure('AI_UPSTREAM_REQUEST_REJECTED', 'AI 服务拒绝了请求')
  }
  return failure('AI_UPSTREAM_REQUEST_REJECTED', 'AI 服务请求失败')
}

function normalizeNetworkError(error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('AI_')) return error
  return transportError('AI_NETWORK_ERROR', 'AI 服务网络连接失败', { retryable: true })
}

function serializeBody(body, maxBytes = MAX_REQUEST_BYTES) {
  let serialized
  try { serialized = JSON.stringify(body) } catch (_) {
    throw transportError('AI_REQUEST_INVALID', 'AI 请求无法序列化', { retryable: false })
  }
  if (typeof serialized !== 'string') {
    throw transportError('AI_REQUEST_INVALID', 'AI 请求内容无效', { retryable: false })
  }
  const payload = Buffer.from(serialized, 'utf8')
  if (payload.length > maxBytes) {
    throw transportError('AI_REQUEST_TOO_LARGE', 'AI 请求内容过大', { retryable: false })
  }
  return payload
}

function requestJson(config, body, endpoint, options = {}) {
  let payload
  try { payload = serializeBody(body, options.maxRequestBytes || MAX_REQUEST_BYTES) } catch (error) {
    return Promise.reject(error)
  }
  const now = options.now || Date.now
  const deadlineAt = validDeadline(options.deadlineAt || (now() + Number(config && config.timeoutMs || 0)))
  const remaining = Math.ceil(deadlineAt - now())
  if (remaining <= 0) return Promise.reject(timeoutError())
  if (!config || !config.url || typeof config.apiKey !== 'string' || !validEndpoint(endpoint)) {
    return Promise.reject(transportError('AI_CONFIGURATION_INVALID', 'AI 连接配置无效', { retryable: false }))
  }

  const requestImpl = options.request || https.request
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const maxResponseBytes = options.maxResponseBytes || MAX_RESPONSE_BYTES

  return new Promise((resolve, reject) => {
    let settled = false
    let request
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimer(timer)
      callback(value)
    }
    const timer = setTimer(() => {
      const error = timeoutError()
      finish(reject, error)
      if (request && typeof request.destroy === 'function') request.destroy(error)
    }, remaining)

    try {
      request = requestImpl(config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        lookup: (_hostname, _lookupOptions, callback) => callback(null, endpoint.address, endpoint.family),
      }, (response) => {
        const statusCode = Number(response && response.statusCode || 0)
        if (typeof options.onResponseStatus === 'function') {
          try { options.onResponseStatus(statusCode) } catch (_) {}
        }
        if (statusCode < 200 || statusCode >= 300) {
          const headers = response && response.headers || {}
          const declaredLength = Number(headers['content-length'])
          if (!response || typeof response.on !== 'function' ||
              (Number.isFinite(declaredLength) && declaredLength > MAX_ERROR_RESPONSE_BYTES)) {
            const failure = httpFailure(statusCode, headers, now())
            finish(reject, failure)
            if (request && typeof request.destroy === 'function') request.destroy(failure)
            return
          }
          const errorChunks = []
          let errorBytes = 0
          response.on('aborted', () => finish(reject, httpFailure(statusCode, headers, now())))
          response.on('error', () => finish(reject, httpFailure(statusCode, headers, now())))
          response.on('data', (chunk) => {
            if (settled) return
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            errorBytes += value.length
            if (errorBytes > MAX_ERROR_RESPONSE_BYTES) {
              const failure = httpFailure(statusCode, headers, now())
              finish(reject, failure)
              if (request && typeof request.destroy === 'function') request.destroy(failure)
              return
            }
            errorChunks.push(value)
          })
          response.on('end', () => {
            if (settled) return
            const descriptor = parseErrorDescriptor(Buffer.concat(errorChunks))
            finish(reject, httpFailure(statusCode, headers, now(), descriptor))
          })
          if (typeof response.resume === 'function') response.resume()
          return
        }

        const declaredLength = Number(response && response.headers && response.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          const failure = transportError('AI_RESPONSE_TOO_LARGE', 'AI 响应过大', { retryable: false })
          finish(reject, failure)
          if (request && typeof request.destroy === 'function') request.destroy(failure)
          return
        }

        const chunks = []
        let bytes = 0
        response.on('aborted', () => finish(reject, transportError(
          'AI_NETWORK_ERROR', 'AI 服务中断了响应', { retryable: true },
        )))
        response.on('error', (error) => finish(reject, normalizeNetworkError(error)))
        response.on('data', (chunk) => {
          if (settled) return
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += value.length
          if (bytes > maxResponseBytes) {
            const failure = transportError('AI_RESPONSE_TOO_LARGE', 'AI 响应过大', { retryable: false })
            finish(reject, failure)
            if (request && typeof request.destroy === 'function') request.destroy(failure)
            return
          }
          chunks.push(value)
        })
        response.on('end', () => {
          if (settled) return
          try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          catch (_) {
            finish(reject, transportError('AI_RESPONSE_INVALID', 'AI 服务返回了无法识别的响应', { retryable: false }))
          }
        })
      })
    } catch (error) {
      finish(reject, normalizeNetworkError(error))
      return
    }
    request.on('error', (error) => finish(reject, normalizeNetworkError(error)))
    request.write(payload)
    request.end()
  })
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_ERROR_RESPONSE_BYTES,
  DEFAULT_RETRY_DELAY_MS,
  MIN_RETRY_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  transportError,
  publicAddress,
  privateAddress,
  validEndpoint,
  withDeadline,
  resolvePublicEndpoint,
  boundedRetryAfter,
  parseErrorDescriptor,
  safeMessageHint,
  descriptorCategory,
  httpFailure,
  normalizeNetworkError,
  serializeBody,
  requestJson,
}
