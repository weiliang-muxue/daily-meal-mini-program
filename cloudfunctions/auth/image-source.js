'use strict'

const crypto = require('crypto')
const dns = require('dns').promises
const https = require('https')
const net = require('net')

const DEFAULT_TIMEOUT_MS = 7000
const DNS_TIMEOUT_MS = 2000
const MAX_REDIRECTS = 2

function imageSourceError(code, message, retryable = false, fetchStage) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  if (fetchStage) error.imageFetchStage = fetchStage
  return error
}

function validMetadata(input = {}, maxBytes, label = '图片') {
  const size = Number(input.sourceSize)
  const sha256 = typeof input.sourceSha256 === 'string' ? input.sourceSha256.toLowerCase() : ''
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('图片来源校验配置无效')
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw imageSourceError('IMAGE_METADATA_INVALID', `${label}文件信息无效，请重新选择`)
  }
  return { size, sha256 }
}

function validSourceUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw imageSourceError('IMAGE_SOURCE_INVALID', '图片临时地址无效，请重新选择')
  }
  let url
  try { url = new URL(value) } catch (_) {
    throw imageSourceError('IMAGE_SOURCE_INVALID', '图片临时地址无效，请重新选择')
  }
  // Cloud.CDN promises an HTTP URL, not necessarily an HTTPS-formatted URL.
  // Upgrade the default HTTP endpoint locally before resolving or requesting it;
  // never fetch private images over plaintext or fall back after a TLS failure.
  if (url.protocol === 'http:' && !url.port && !url.username && !url.password) {
    url.protocol = 'https:'
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw imageSourceError('IMAGE_SOURCE_INVALID', '图片临时地址无效，请重新选择')
  }
  url.hash = ''
  return url
}

function publicIpv4(address) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = parts
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  )
}

function ipv6Value(address) {
  let value = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':')
    const ipv4 = value.slice(separator + 1)
    const parts = ipv4.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    value = `${value.slice(0, separator)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = value.split('::')
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
  const value = ipv6Value(address)
  if (value === null) return false
  const globalStart = 0x20000000000000000000000000000000n
  if (!inIpv6Range(value, globalStart, 3)) return false
  const rejected = [
    [0x20010db8000000000000000000000000n, 32],
    [0x20010000000000000000000000000000n, 32],
    [0x20020000000000000000000000000000n, 16],
    [0x3fff0000000000000000000000000000n, 20],
  ]
  return !rejected.some(([prefix, bits]) => inIpv6Range(value, prefix, bits))
}

function publicAddress(address) {
  const family = net.isIP(String(address))
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

const defaultDependencies = {
  lookup: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  request: (options, callback) => https.request(options, callback),
  now: () => Date.now(),
}

async function downloadStep(sourceUrl, options, redirectCount, deadline) {
  const { maxBytes, label, dependencies } = options
  const url = validSourceUrl(sourceUrl)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const dnsBudget = Math.min(DNS_TIMEOUT_MS, deadline - dependencies.now())
  if (dnsBudget < 1) throw imageSourceError('IMAGE_SOURCE_UNAVAILABLE', `${label}读取超时，请重新选择`, true, 'timeout')
  const addresses = await withTimeout(dependencies.lookup(hostname), dnsBudget).catch(() => null)
  if (!Array.isArray(addresses) || !addresses.length) {
    throw imageSourceError('IMAGE_SOURCE_UNAVAILABLE', `${label}读取失败，请重新选择`, true, 'dns')
  }
  if (addresses.some((item) => !publicAddress(item && item.address))) {
    throw imageSourceError('IMAGE_SOURCE_INVALID', `${label}临时地址无效，请重新选择`)
  }
  const selected = addresses[0]
  const requestBudget = deadline - dependencies.now()
  if (requestBudget < 1) throw imageSourceError('IMAGE_SOURCE_UNAVAILABLE', `${label}读取超时，请重新选择`, true, 'timeout')

  return new Promise((resolve, reject) => {
    let settled = false
    let absoluteTimer
    let request
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(absoluteTimer)
      if (request && typeof request.setTimeout === 'function') request.setTimeout(0)
      if (error) reject(error)
      else resolve(value)
    }
    const unavailable = (stage = 'network') => imageSourceError('IMAGE_SOURCE_UNAVAILABLE', `${label}读取失败，请重新选择`, true, stage)
    const requestFailed = (error) => unavailable(/TLS|CERT|SSL/.test(String(error && error.code || '')) ? 'tls' : 'network')
    const timedOut = () => unavailable('timeout')
    absoluteTimer = setTimeout(() => {
      settle(timedOut())
      if (request && typeof request.destroy === 'function') request.destroy(new Error('timeout'))
    }, requestBudget)
    try {
      request = dependencies.request({
        family: selected.family,
        headers: { Accept: 'image/*', 'Accept-Encoding': 'identity', Host: url.host },
        hostname: selected.address,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        port: 443,
        rejectUnauthorized: true,
        servername: net.isIP(hostname) ? undefined : hostname,
      }, (response) => {
        const status = Number(response.statusCode) || 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume()
          if (!response.headers.location || redirectCount >= MAX_REDIRECTS) {
            settle(imageSourceError('IMAGE_SOURCE_INVALID', `${label}临时地址重定向异常`))
            return
          }
          const next = new URL(response.headers.location, url).toString()
          downloadStep(next, options, redirectCount + 1, deadline).then(
            (buffer) => settle(null, buffer),
            (error) => settle(error),
          )
          return
        }
        if (status !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.resume()
          const error = unavailable(status !== 200 ? 'http' : 'encoding')
          if (Number.isInteger(status) && status >= 100 && status <= 599) error.imageHttpStatus = status
          settle(error)
          return
        }
        const declared = Number(response.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          settle(imageSourceError('IMAGE_TOO_LARGE', `${label}不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB`))
          response.destroy()
          return
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > maxBytes) {
            settle(imageSourceError('IMAGE_TOO_LARGE', `${label}不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB`))
            response.destroy()
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => settle(null, Buffer.concat(chunks)))
        response.on('error', () => settle(unavailable('response')))
      })
    } catch (error) {
      settle(requestFailed(error))
      return
    }
    if (settled) return
    request.setTimeout(requestBudget, () => {
      settle(timedOut())
      request.destroy(new Error('timeout'))
    })
    request.on('error', (error) => settle(requestFailed(error)))
    request.end()
  })
}

async function downloadImageSource(input = {}, options = {}) {
  const label = options.label || '图片'
  const maxBytes = Number(options.maxBytes)
  const metadata = validMetadata(input, maxBytes, label)
  const dependencies = options.dependencies || defaultDependencies
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  let buffer
  try {
    buffer = await downloadStep(input.sourceUrl, { maxBytes, label, dependencies }, 0, dependencies.now() + timeoutMs)
  } catch (error) {
    // Fixed-value diagnostics only: never expose the signed source URL, DNS
    // addresses, headers, credentials or provider error text.
    if (typeof input.sourceUrl === 'string' && /^https?:\/\//.test(input.sourceUrl)) {
      error.imageSourceProtocol = input.sourceUrl.startsWith('https:') ? 'https' : 'http'
    }
    throw error
  }
  const digest = crypto.createHash('sha256').update(buffer).digest('hex')
  if (buffer.length !== metadata.size || digest !== metadata.sha256) {
    throw imageSourceError('IMAGE_CONTENT_MISMATCH', `${label}内容发生变化，请重新选择`)
  }
  return buffer
}

module.exports = {
  DEFAULT_TIMEOUT_MS, MAX_REDIRECTS, downloadImageSource, imageSourceError,
  publicAddress, validMetadata, validSourceUrl,
}
