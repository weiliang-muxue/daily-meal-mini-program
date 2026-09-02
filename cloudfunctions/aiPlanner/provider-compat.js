'use strict'

const { requestJson } = require('./transport')

const MIN_FALLBACK_REMAINING_MS = 5000
const PROFILE_FULL = 'full'
const PROFILE_NO_MAX_TOKENS = 'no_max_output_tokens'
const PROFILE_NO_REASONING = 'no_reasoning'
const PROFILE_NO_TEXT = 'no_text_format'
const PROFILE_NO_MAX_TOKENS_OR_REASONING = 'no_max_output_tokens_or_reasoning'
const PROFILE_NO_MAX_TOKENS_OR_TEXT = 'no_max_output_tokens_or_text'
const PROFILE_NO_REASONING_OR_TEXT = 'no_reasoning_or_text'
const PROFILE_MINIMAL = 'minimal'
const PROFILE_MINIMAL_NO_STREAM = 'minimal_no_stream'
const PROFILES = Object.freeze([
  PROFILE_FULL,
  PROFILE_NO_MAX_TOKENS,
  PROFILE_NO_REASONING,
  PROFILE_NO_TEXT,
  PROFILE_NO_MAX_TOKENS_OR_REASONING,
  PROFILE_NO_MAX_TOKENS_OR_TEXT,
  PROFILE_NO_REASONING_OR_TEXT,
  PROFILE_MINIMAL,
  PROFILE_MINIMAL_NO_STREAM,
])
const PROFILE_OMISSIONS = Object.freeze({
  [PROFILE_FULL]: Object.freeze([]),
  [PROFILE_NO_MAX_TOKENS]: Object.freeze(['max_output_tokens']),
  [PROFILE_NO_REASONING]: Object.freeze(['reasoning']),
  [PROFILE_NO_TEXT]: Object.freeze(['text']),
  [PROFILE_NO_MAX_TOKENS_OR_REASONING]: Object.freeze(['max_output_tokens', 'reasoning']),
  [PROFILE_NO_MAX_TOKENS_OR_TEXT]: Object.freeze(['max_output_tokens', 'text']),
  [PROFILE_NO_REASONING_OR_TEXT]: Object.freeze(['reasoning', 'text']),
  [PROFILE_MINIMAL]: Object.freeze(['max_output_tokens', 'reasoning', 'temperature', 'text']),
  [PROFILE_MINIMAL_NO_STREAM]: Object.freeze(['max_output_tokens', 'reasoning', 'temperature', 'text', 'stream']),
})

function normalizeProfile(value, fallback = PROFILE_FULL) {
  return PROFILES.includes(value) ? value : fallback
}

function profilePath(value) {
  const current = normalizeProfile(value)
  return PROFILES.filter((candidate) => allowedProfileTransition(current, candidate))
}

function assertRequiredFields(body, allowMissingStream = false) {
  const hasStream = body && Object.prototype.hasOwnProperty.call(body, 'stream')
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.model !== 'string' || !body.model.trim() ||
      typeof body.instructions !== 'string' || !body.instructions.trim() ||
      !Object.prototype.hasOwnProperty.call(body, 'input') ||
      body.store !== false || (hasStream ? body.stream !== false : !allowMissingStream)) {
    const error = new Error('AI 请求缺少安全必需字段')
    error.code = 'AI_REQUEST_INVALID'
    error.retryable = false
    throw error
  }
}

function bodyForProfile(body, rawProfile) {
  assertRequiredFields(body)
  const profile = normalizeProfile(rawProfile, '')
  if (!profile) {
    const error = new Error('AI 请求兼容配置无效')
    error.code = 'AI_REQUEST_INVALID'
    error.retryable = false
    throw error
  }
  if (profile === PROFILE_MINIMAL) {
    return {
      model: body.model,
      instructions: body.instructions,
      input: body.input,
      store: false,
      stream: false,
    }
  }
  if (profile === PROFILE_MINIMAL_NO_STREAM) {
    const value = {
      model: body.model,
      instructions: body.instructions,
      input: body.input,
      store: false,
    }
    assertRequiredFields(value, true)
    return value
  }
  const value = { ...body }
  PROFILE_OMISSIONS[profile].forEach((field) => { delete value[field] })
  assertRequiredFields(value)
  return value
}

function eligibleCompatibilityFailure(error) {
  const status = Number(error && error.statusCode)
  return [400, 422].includes(status) && [
    'AI_UPSTREAM_REQUEST_REJECTED', 'AI_UPSTREAM_PARAMETER_REJECTED',
  ].includes(error && error.code)
}

function allowedProfileTransition(current, next) {
  const from = normalizeProfile(current, '')
  const to = normalizeProfile(next, '')
  if (!from || !to) return false
  const nextOmissions = new Set(PROFILE_OMISSIONS[to])
  return PROFILE_OMISSIONS[from].every((field) => nextOmissions.has(field))
}

function profileWithOmission(current, field) {
  const profile = normalizeProfile(current, '')
  if (!profile || [PROFILE_MINIMAL, PROFILE_MINIMAL_NO_STREAM].includes(profile) || !field) return ''
  const omissions = new Set(PROFILE_OMISSIONS[profile])
  if (omissions.has(field)) return ''
  omissions.add(field)
  const requested = [...omissions].sort().join(',')
  const matched = PROFILES.find((candidate) => (
    candidate !== PROFILE_MINIMAL && [...PROFILE_OMISSIONS[candidate]].sort().join(',') === requested
  ))
  return matched || (['max_output_tokens', 'reasoning', 'text'].every((value) => omissions.has(value))
    ? PROFILE_MINIMAL : '')
}

function compatibilityField(error) {
  const param = error && error.compatibilityParam
  if (param === 'max_output_tokens') return 'max_output_tokens'
  if (['reasoning', 'reasoning.effort'].includes(param)) return 'reasoning'
  if (['text', 'text.format', 'text.format.type'].includes(param)) return 'text'
  if (param === 'stream') return 'stream'
  return ''
}

function nextCompatibilityProfile(current, error) {
  const profile = normalizeProfile(current, '')
  if (!profile || profile === PROFILE_MINIMAL_NO_STREAM) return ''
  const param = error && error.compatibilityParam
  if (profile === PROFILE_MINIMAL) return param ? '' : PROFILE_MINIMAL_NO_STREAM
  if (param) {
    const field = compatibilityField(error)
    if (field === 'stream') return ''
    return profileWithOmission(profile, field)
  }
  return PROFILE_MINIMAL
}

async function requestResponsesCompatible(config, body, endpoint, options = {}) {
  const deadlineAt = Number(options.deadlineAt)
  const now = options.now || Date.now
  const request = options.request || requestJson
  const minRemainingMs = Number.isFinite(options.minFallbackRemainingMs)
    ? Math.max(0, Math.ceil(options.minFallbackRemainingMs))
    : MIN_FALLBACK_REMAINING_MS
  let profile = normalizeProfile(options.initialProfile)
  while (profile) {
    try {
      const response = await request(config, bodyForProfile(body, profile), endpoint, { deadlineAt })
      return { response, profile }
    } catch (error) {
      if (!eligibleCompatibilityFailure(error)) throw error
      const nextProfile = nextCompatibilityProfile(profile, error)
      if (!nextProfile || deadlineAt - now() < minRemainingMs) throw error
      profile = nextProfile
    }
  }
  throw new Error('AI 请求兼容配置无效')
}

module.exports = {
  MIN_FALLBACK_REMAINING_MS,
  PROFILE_FULL,
  PROFILE_NO_MAX_TOKENS,
  PROFILE_NO_REASONING,
  PROFILE_NO_TEXT,
  PROFILE_NO_MAX_TOKENS_OR_REASONING,
  PROFILE_NO_MAX_TOKENS_OR_TEXT,
  PROFILE_NO_REASONING_OR_TEXT,
  PROFILE_MINIMAL,
  PROFILE_MINIMAL_NO_STREAM,
  PROFILES,
  normalizeProfile,
  profilePath,
  bodyForProfile,
  eligibleCompatibilityFailure,
  allowedProfileTransition,
  compatibilityField,
  nextCompatibilityProfile,
  requestResponsesCompatible,
}
