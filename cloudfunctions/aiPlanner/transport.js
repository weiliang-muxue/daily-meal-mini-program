'use strict'

const dns = require('dns').promises
const https = require('https')
const net = require('net')

const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 512 * 1024
const DEFAULT_RETRY_DELAY_MS = 1000
const MIN_RETRY_DELAY_MS = 600
const MAX_RETRY_AFTER_MS = 30 * 1000

function transportError(code, message, options = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = options.retryable === true
  if (Number.isInteger(options.statusCode)) error.statusCode = options.statusCode
  if (Number.isInteger(options.retryAfterMs)) error.retryAfterMs = options.retryAfterMs
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

function httpFailure(statusCode, headers = {}, now = Date.now()) {
  const status = Number(statusCode)
  const common = { statusCode: Number.isInteger(status) ? status : 0, retryable: false }
  if (status === 401 || status === 403) {
    return transportError('AI_UPSTREAM_AUTH_REJECTED', 'AI 服务拒绝了鉴权', common)
  }
  if ([400, 404, 422].includes(status)) {
    return transportError('AI_UPSTREAM_REQUEST_REJECTED', 'AI 服务拒绝了请求', common)
  }
  if (status === 429) {
    return transportError('AI_UPSTREAM_RATE_LIMITED', 'AI 服务暂时繁忙', {
      statusCode: status,
      retryable: true,
      retryAfterMs: boundedRetryAfter(headers['retry-after'], now),
    })
  }
  if (status === 408) return transportError('AI_TIMEOUT', 'AI 服务请求超时', { statusCode: status, retryable: true })
  if (status >= 500 && status <= 599) {
    return transportError('AI_UPSTREAM_UNAVAILABLE', 'AI 服务暂时不可用', { statusCode: status, retryable: true })
  }
  return transportError('AI_UPSTREAM_REQUEST_REJECTED', 'AI 服务请求失败', common)
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
          ...(config.extraHeaders || {}),
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        lookup: (_hostname, _lookupOptions, callback) => callback(null, endpoint.address, endpoint.family),
      }, (response) => {
        const statusCode = Number(response && response.statusCode || 0)
        if (statusCode < 200 || statusCode >= 300) {
          const failure = httpFailure(statusCode, response && response.headers || {}, now())
          if (response && typeof response.resume === 'function') response.resume()
          finish(reject, failure)
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
  httpFailure,
  normalizeNetworkError,
  serializeBody,
  requestJson,
}
