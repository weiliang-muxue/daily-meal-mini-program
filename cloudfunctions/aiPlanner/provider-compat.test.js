'use strict'

const assert = require('assert')
const {
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
} = require('./provider-compat')

const baseBody = {
  model: 'model-placeholder',
  instructions: 'fixed-system-instructions',
  store: false,
  stream: false,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'synthetic-user-input' }] }],
  max_output_tokens: 16000,
  reasoning: { effort: 'xhigh' },
  text: { format: { type: 'json_object' } },
  temperature: 0.2,
}

assert.deepStrictEqual(PROFILES, [
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
assert.strictEqual(normalizeProfile('unknown'), PROFILE_FULL)
assert(profilePath(PROFILE_NO_MAX_TOKENS).includes(PROFILE_NO_MAX_TOKENS_OR_REASONING))
assert(profilePath(PROFILE_NO_MAX_TOKENS).includes(PROFILE_NO_MAX_TOKENS_OR_TEXT))
assert.strictEqual(profilePath(PROFILE_NO_MAX_TOKENS).includes(PROFILE_NO_REASONING), false)
assert.strictEqual(allowedProfileTransition(PROFILE_NO_MAX_TOKENS_OR_REASONING, PROFILE_NO_MAX_TOKENS), false)
assert.strictEqual(allowedProfileTransition(PROFILE_NO_MAX_TOKENS, PROFILE_MINIMAL), true)
assert.strictEqual(allowedProfileTransition(PROFILE_MINIMAL, PROFILE_MINIMAL_NO_STREAM), true)
assert.strictEqual(allowedProfileTransition(PROFILE_FULL, PROFILE_MINIMAL_NO_STREAM), true)

for (const profile of PROFILES) {
  const value = bodyForProfile(baseBody, profile)
  assert.strictEqual(value.model, baseBody.model)
  assert.strictEqual(value.instructions, baseBody.instructions)
  assert.strictEqual(value.input, baseBody.input)
  assert.strictEqual(value.store, false)
  if (profile === PROFILE_MINIMAL_NO_STREAM) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(value, 'stream'), false)
  } else {
    assert.strictEqual(value.stream, false)
  }
  const serialized = JSON.stringify(value).toLowerCase()
  assert(!serialized.includes('authorization'))
  assert(!serialized.includes('api_key'))
}
assert.strictEqual(Object.prototype.hasOwnProperty.call(bodyForProfile(baseBody, PROFILE_NO_MAX_TOKENS), 'max_output_tokens'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(bodyForProfile(baseBody, PROFILE_NO_REASONING), 'reasoning'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(bodyForProfile(baseBody, PROFILE_NO_TEXT), 'text'), false)
assert.deepStrictEqual(Object.keys(bodyForProfile(baseBody, PROFILE_MINIMAL)).sort(), [
  'input', 'instructions', 'model', 'store', 'stream',
])
assert.deepStrictEqual(Object.keys(bodyForProfile(baseBody, PROFILE_MINIMAL_NO_STREAM)).sort(), [
  'input', 'instructions', 'model', 'store',
])
assert.throws(() => bodyForProfile({ ...baseBody, store: true }, PROFILE_FULL), (error) => (
  error.code === 'AI_REQUEST_INVALID' && error.retryable === false
))
for (const invalidBody of [
  { ...baseBody, instructions: '' },
  { ...baseBody, instructions: undefined },
  { ...baseBody, stream: true },
  { ...baseBody, stream: undefined },
]) {
  assert.throws(() => bodyForProfile(invalidBody, PROFILE_FULL), (error) => (
    error.code === 'AI_REQUEST_INVALID' && error.retryable === false
  ))
}

assert.strictEqual(compatibilityField({ compatibilityParam: 'max_output_tokens' }), 'max_output_tokens')
assert.strictEqual(compatibilityField({ compatibilityParam: 'reasoning.effort' }), 'reasoning')
assert.strictEqual(compatibilityField({ compatibilityParam: 'text.format.type' }), 'text')
assert.strictEqual(compatibilityField({ compatibilityParam: 'stream' }), 'stream')
for (const protectedParam of ['store', 'instructions', 'input', 'model']) {
  assert.strictEqual(compatibilityField({ compatibilityParam: protectedParam }), '')
  assert.strictEqual(nextCompatibilityProfile(PROFILE_FULL, { compatibilityParam: protectedParam }), '')
  assert.strictEqual(nextCompatibilityProfile(PROFILE_MINIMAL, { compatibilityParam: protectedParam }), '')
}
assert.strictEqual(nextCompatibilityProfile(PROFILE_FULL, { compatibilityParam: 'reasoning.effort' }), PROFILE_NO_REASONING)
assert.strictEqual(nextCompatibilityProfile(PROFILE_FULL, { compatibilityParam: 'text.format.type' }), PROFILE_NO_TEXT)
assert.strictEqual(nextCompatibilityProfile(PROFILE_NO_MAX_TOKENS, { compatibilityParam: 'reasoning' }), PROFILE_NO_MAX_TOKENS_OR_REASONING)
assert.strictEqual(nextCompatibilityProfile(PROFILE_NO_REASONING, { compatibilityParam: 'text' }), PROFILE_NO_REASONING_OR_TEXT)
assert.strictEqual(nextCompatibilityProfile(PROFILE_NO_MAX_TOKENS_OR_TEXT, { compatibilityParam: 'reasoning' }), PROFILE_MINIMAL)
assert.strictEqual(nextCompatibilityProfile(PROFILE_FULL, {}), PROFILE_MINIMAL)
assert.strictEqual(nextCompatibilityProfile(PROFILE_FULL, { compatibilityParam: 'stream' }), '')
assert.strictEqual(nextCompatibilityProfile(PROFILE_MINIMAL, { compatibilityParam: 'stream' }), '')
assert.strictEqual(nextCompatibilityProfile(PROFILE_MINIMAL, {}), PROFILE_MINIMAL_NO_STREAM)
assert.strictEqual(nextCompatibilityProfile(PROFILE_MINIMAL_NO_STREAM, {}), '')
assert.strictEqual(nextCompatibilityProfile(PROFILE_FULL, { compatibilityParam: 'unknown_private_param' }), '')

assert.strictEqual(eligibleCompatibilityFailure({ statusCode: 400, code: 'AI_UPSTREAM_REQUEST_REJECTED' }), true)
assert.strictEqual(eligibleCompatibilityFailure({ statusCode: 422, code: 'AI_UPSTREAM_PARAMETER_REJECTED' }), true)
for (const error of [
  { statusCode: 401, code: 'AI_UPSTREAM_AUTH_REJECTED' },
  { statusCode: 403, code: 'AI_UPSTREAM_POLICY_REJECTED' },
  { statusCode: 404, code: 'AI_UPSTREAM_ENDPOINT_NOT_FOUND' },
  { statusCode: 429, code: 'AI_UPSTREAM_RATE_LIMITED' },
  { statusCode: 500, code: 'AI_UPSTREAM_UNAVAILABLE' },
  { statusCode: 400, code: 'AI_UPSTREAM_MODEL_UNAVAILABLE' },
  { statusCode: 400, code: 'AI_RESPONSE_INVALID' },
]) assert.strictEqual(eligibleCompatibilityFailure(error), false)

function rejected(param, statusCode = 400) {
  const error = Object.assign(new Error('fixed safe failure'), {
    code: param ? 'AI_UPSTREAM_PARAMETER_REJECTED' : 'AI_UPSTREAM_REQUEST_REJECTED',
    statusCode,
    retryable: false,
  })
  if (param) Object.defineProperty(error, 'compatibilityParam', { value: param, enumerable: false })
  return error
}

async function targetedCase(param, expectedProfile, removedField) {
  const calls = []
  const result = await requestResponsesCompatible({}, baseBody, {}, {
    deadlineAt: 50000,
    now: () => 0,
    async request(_config, body) {
      calls.push(body)
      if (calls.length === 1) throw rejected(param)
      return { status: 'completed' }
    },
  })
  assert.strictEqual(result.profile, expectedProfile)
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0], removedField), true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[1], removedField), false)
  assert(calls.every((body) => body.instructions === baseBody.instructions && body.store === false && body.stream === false))
}

;(async () => {
  await targetedCase('max_output_tokens', PROFILE_NO_MAX_TOKENS, 'max_output_tokens')
  await targetedCase('reasoning.effort', PROFILE_NO_REASONING, 'reasoning')
  await targetedCase('text.format.type', PROFILE_NO_TEXT, 'text')

  const genericBodies = []
  await assert.rejects(requestResponsesCompatible({}, baseBody, {}, {
    deadlineAt: 50000,
    now: () => 0,
    async request(_config, body) { genericBodies.push(body); throw rejected('') },
  }), (error) => error.code === 'AI_UPSTREAM_REQUEST_REJECTED')
  assert.strictEqual(genericBodies.length, 3)
  assert.deepStrictEqual(Object.keys(genericBodies[1]).sort(), ['input', 'instructions', 'model', 'store', 'stream'])
  assert.deepStrictEqual(Object.keys(genericBodies[2]).sort(), ['input', 'instructions', 'model', 'store'])
  assert(genericBodies.every((body) => (
    body.instructions === baseBody.instructions && body.input === baseBody.input && body.store === false
  )))

  for (const protectedParam of ['store', 'instructions', 'input']) {
    let calls = 0
    await assert.rejects(requestResponsesCompatible({}, baseBody, {}, {
      deadlineAt: 50000,
      now: () => 0,
      async request() { calls += 1; throw rejected(protectedParam) },
    }), (error) => error.compatibilityParam === protectedParam)
    assert.strictEqual(calls, 1)
  }

  const noStreamBodies = []
  const noStream = await requestResponsesCompatible({}, baseBody, {}, {
    deadlineAt: 50000,
    initialProfile: PROFILE_MINIMAL,
    now: () => 0,
    async request(_config, body) {
      noStreamBodies.push(body)
      if (noStreamBodies.length === 1) throw rejected('', 422)
      return { status: 'completed' }
    },
  })
  assert.strictEqual(noStream.profile, PROFILE_MINIMAL_NO_STREAM)
  assert.strictEqual(noStreamBodies.length, 2)
  assert.strictEqual(noStreamBodies[0].stream, false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(noStreamBodies[1], 'stream'), false)
  assert(noStreamBodies.every((body) => (
    body.model === baseBody.model && body.instructions === baseBody.instructions &&
    body.input === baseBody.input && body.store === false
  )))

  for (const explicitParam of ['store', 'instructions', 'input', 'model', 'stream']) {
    let explicitCalls = 0
    await assert.rejects(requestResponsesCompatible({}, baseBody, {}, {
      deadlineAt: 50000,
      initialProfile: PROFILE_MINIMAL,
      now: () => 0,
      async request() { explicitCalls += 1; throw rejected(explicitParam, 422) },
    }), (error) => error.compatibilityParam === explicitParam)
    assert.strictEqual(explicitCalls, 1)
  }

  const reusedBodies = []
  const reused = await requestResponsesCompatible({}, baseBody, {}, {
    deadlineAt: 50000,
    initialProfile: PROFILE_NO_REASONING,
    now: () => 0,
    async request(_config, body) { reusedBodies.push(body); return { status: 'completed' } },
  })
  assert.strictEqual(reused.profile, PROFILE_NO_REASONING)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(reusedBodies[0], 'reasoning'), false)

  let deadlineCalls = 0
  await assert.rejects(requestResponsesCompatible({}, baseBody, {}, {
    deadlineAt: MIN_FALLBACK_REMAINING_MS,
    now: () => deadlineCalls,
    async request() { deadlineCalls += 1; throw rejected('text') },
  }), (error) => error.compatibilityParam === 'text')
  assert.strictEqual(deadlineCalls, 1)

  let finalDeadlineCalls = 0
  await assert.rejects(requestResponsesCompatible({}, baseBody, {}, {
    deadlineAt: MIN_FALLBACK_REMAINING_MS,
    initialProfile: PROFILE_MINIMAL,
    now: () => finalDeadlineCalls,
    async request() { finalDeadlineCalls += 1; throw rejected('') },
  }), (error) => error.code === 'AI_UPSTREAM_REQUEST_REJECTED')
  assert.strictEqual(finalDeadlineCalls, 1)

  console.log('AI provider compatibility tests passed')
})().catch((error) => {
  console.error(error && { code: error.code, name: error.name, message: error.message })
  process.exit(1)
})
