'use strict'

const assert = require('assert')
const {
  DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_API_STYLE, DEFAULT_REASONING_EFFORT,
  PROVIDER_CONTRACT_REVISION, DEFAULT_PROVIDER_REVISION, DEFAULT_PROVIDER_DISPLAY_NAME,
  DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS,
  MAX_PROVIDER_DISPLAY_NAME_LENGTH, configurationForApiKey, configuration,
} = require('./provider-config')

const KEY_A = 'TEST_PLACEHOLDER_KEY_A'
const KEY_B = 'TEST_PLACEHOLDER_KEY_B'
const VERSION_PATTERN = /^[a-f0-9]{64}$/

assert.strictEqual(PROVIDER_CONTRACT_REVISION, 9)
assert.strictEqual(DEFAULT_PROVIDER_REVISION, 8)

function assertLocked(config) {
  assert.strictEqual(config.model, DEFAULT_MODEL)
  assert.strictEqual(config.apiStyle, DEFAULT_API_STYLE)
  assert.strictEqual(config.reasoningEffort, DEFAULT_REASONING_EFFORT)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'extraHeaders'), false)
  assert.strictEqual(config.temperature, undefined)
  assert.strictEqual(config.providerContractRevision, PROVIDER_CONTRACT_REVISION)
}

function assertConfigured(config, expected = {}) {
  assertLocked(config)
  assert.strictEqual(config.configured, true)
  assert(config.url instanceof URL)
  assert(VERSION_PATTERN.test(config.providerConfigVersion))
  if (expected.url) assert.strictEqual(config.url.href, expected.url)
  if (expected.displayName) assert.strictEqual(config.providerDisplayName, expected.displayName)
  if (expected.revision) assert.strictEqual(config.providerRevision, expected.revision)
}

function assertInvalid(config) {
  assertLocked(config)
  assert.strictEqual(config.configured, false)
  assert.strictEqual(config.url, null)
  assert.strictEqual(config.providerDisplayName, '')
  assert.strictEqual(config.providerRevision, 0)
  assert.strictEqual(config.providerConfigVersion, '')
}

const defaults = configuration({ AI_API_KEY: KEY_A })
assertConfigured(defaults, {
  url: DEFAULT_ENDPOINT,
  displayName: DEFAULT_PROVIDER_DISPLAY_NAME,
  revision: DEFAULT_PROVIDER_REVISION,
})
assert.strictEqual(defaults.timeoutMs, DEFAULT_TIMEOUT_MS)
assert.strictEqual(defaults.maxTokens, DEFAULT_MAX_TOKENS)

const withoutKey = configuration({})
assert.strictEqual(withoutKey.configured, false)
assert.strictEqual(withoutKey.url, null)
assert.strictEqual(withoutKey.providerDisplayName, DEFAULT_PROVIDER_DISPLAY_NAME)
assert.strictEqual(withoutKey.providerRevision, DEFAULT_PROVIDER_REVISION)
assert(VERSION_PATTERN.test(withoutKey.providerConfigVersion))

const runtime = configuration({
  AI_API_KEY: KEY_A,
  AI_API_BASE_URL: 'https://runtime-provider.example/openai/v2/',
  AI_PROVIDER_DISPLAY_NAME: '  Runtime AI 服务  ',
  AI_PROVIDER_REVISION: '12',
})
assertConfigured(runtime, {
  url: 'https://runtime-provider.example/openai/v2/responses',
  displayName: 'Runtime AI 服务',
  revision: 12,
})

const equivalentRootVersions = [
  'https://runtime-provider.example',
  'https://runtime-provider.example/',
  'https://runtime-provider.example/responses',
].map((baseUrl) => configuration({
  AI_API_KEY: KEY_A,
  AI_API_BASE_URL: baseUrl,
  AI_PROVIDER_DISPLAY_NAME: 'Runtime AI',
  AI_PROVIDER_REVISION: 9,
}))
equivalentRootVersions.forEach((config) => {
  assertConfigured(config, { url: 'https://runtime-provider.example/responses', revision: 9 })
})
assert.strictEqual(new Set(equivalentRootVersions.map((config) => config.providerConfigVersion)).size, 1)

const equivalentV1Versions = [
  'https://runtime-provider.example/v1',
  'https://runtime-provider.example/v1/',
  'https://runtime-provider.example/v1/responses',
].map((baseUrl) => configuration({
  AI_API_KEY: KEY_A,
  AI_API_BASE_URL: baseUrl,
  AI_PROVIDER_DISPLAY_NAME: 'Runtime AI',
  AI_PROVIDER_REVISION: 9,
}))
equivalentV1Versions.forEach((config) => {
  assertConfigured(config, { url: 'https://runtime-provider.example/v1/responses', revision: 9 })
})
assert.strictEqual(new Set(equivalentV1Versions.map((config) => config.providerConfigVersion)).size, 1)
assert.notStrictEqual(equivalentRootVersions[0].providerConfigVersion, equivalentV1Versions[0].providerConfigVersion)

const stableA = configuration({
  AI_API_KEY: KEY_A,
  AI_API_BASE_URL: 'https://stable-provider.example/v1',
  AI_PROVIDER_DISPLAY_NAME: 'Stable AI',
  AI_PROVIDER_REVISION: '23',
  AI_TIMEOUT_MS: '5000',
  AI_MAX_TOKENS: '2000',
})
const stableB = configuration({
  AI_API_KEY: KEY_B,
  AI_API_BASE_URL: 'https://stable-provider.example/v1/',
  AI_PROVIDER_DISPLAY_NAME: ' Stable AI ',
  AI_PROVIDER_REVISION: 23,
  AI_TIMEOUT_MS: '45000',
  AI_MAX_TOKENS: '32000',
})
assert.strictEqual(stableA.providerConfigVersion, stableB.providerConfigVersion)
assert(!stableA.providerConfigVersion.includes(KEY_A))
assert(!stableB.providerConfigVersion.includes(KEY_B))

for (const changed of [
  { AI_API_BASE_URL: 'https://other-provider.example/v1' },
  { AI_PROVIDER_DISPLAY_NAME: 'Other AI' },
  { AI_PROVIDER_REVISION: '24' },
]) {
  const config = configuration({
    AI_API_KEY: KEY_A,
    AI_API_BASE_URL: 'https://stable-provider.example/v1',
    AI_PROVIDER_DISPLAY_NAME: 'Stable AI',
    AI_PROVIDER_REVISION: '23',
    ...changed,
  })
  assert.notStrictEqual(config.providerConfigVersion, stableA.providerConfigVersion)
}

for (const invalidBaseUrl of [
  '',
  'http://runtime-provider.example',
  'https://user:password@runtime-provider.example',
  'https://runtime-provider.example?tenant=test',
  'https://runtime-provider.example#fragment',
  'https://runtime-provider.example:99999',
  'https://runtime-provider.example/path with spaces',
  123,
  null,
]) {
  assertInvalid(configuration({ AI_API_KEY: KEY_A, AI_API_BASE_URL: invalidBaseUrl }))
}

for (const invalidDisplayName of [
  '', '   ', 'Runtime\nAI', 'Runtime\u007fAI',
  'x'.repeat(MAX_PROVIDER_DISPLAY_NAME_LENGTH + 1), 123, null,
]) {
  assertInvalid(configuration({ AI_API_KEY: KEY_A, AI_PROVIDER_DISPLAY_NAME: invalidDisplayName }))
}

for (const invalidRevision of [
  '', '0', '-1', '+1', '01', '1.0', '1e2', ' 7 ', '9007199254740992',
  0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null,
]) {
  assertInvalid(configuration({ AI_API_KEY: KEY_A, AI_PROVIDER_REVISION: invalidRevision }))
}

const maliciousOverrides = {
  AI_API_KEY: KEY_A,
  AI_API_BASE_URL: 'https://runtime-provider.example',
  AI_PROVIDER_DISPLAY_NAME: 'Runtime AI',
  AI_PROVIDER_REVISION: '31',
  AI_API_ENDPOINT: 'https://attacker.invalid/chat/completions',
  AI_BASE_URL: 'https://attacker.invalid',
  AI_API_URL: 'https://attacker.invalid/v1/responses',
  AI_MODEL: 'attacker-model',
  AI_API_STYLE: 'chat-completions',
  AI_REASONING_EFFORT: 'none',
  AI_PROVIDER_HEADER_NAME: 'x-attacker-header',
  AI_PROVIDER_HEADER_VALUE: 'TEST_ATTACKER_VALUE',
  AI_TEMPERATURE: '2',
  AI_TIMEOUT_MS: '999999',
  AI_MAX_TOKENS: '1',
}
const locked = configuration(maliciousOverrides)
assertConfigured(locked, {
  url: 'https://runtime-provider.example/responses',
  displayName: 'Runtime AI',
  revision: 31,
})
assert.strictEqual(locked.timeoutMs, MAX_TIMEOUT_MS)
assert.strictEqual(locked.maxTokens, MIN_MAX_TOKENS)

const direct = configurationForApiKey(`  ${KEY_A}  `, maliciousOverrides)
assertConfigured(direct, {
  url: DEFAULT_ENDPOINT,
  displayName: DEFAULT_PROVIDER_DISPLAY_NAME,
  revision: DEFAULT_PROVIDER_REVISION,
})
assert.strictEqual(direct.apiKey, KEY_A)
assert.strictEqual(direct.timeoutMs, MAX_TIMEOUT_MS)
assert.strictEqual(direct.maxTokens, MIN_MAX_TOKENS)

assert.strictEqual(configurationForApiKey(KEY_A, { AI_TIMEOUT_MS: '1' }).timeoutMs, MIN_TIMEOUT_MS)
assert.strictEqual(configurationForApiKey(KEY_A, { AI_MAX_TOKENS: '999999' }).maxTokens, MAX_MAX_TOKENS)
assert.strictEqual(configurationForApiKey(KEY_A, { AI_MAX_TOKENS: '12345.9' }).maxTokens, 12345)
for (const invalid of [undefined, null, '', 'not-a-number', 'Infinity', Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.strictEqual(configurationForApiKey(KEY_A, { AI_MAX_TOKENS: invalid }).maxTokens, DEFAULT_MAX_TOKENS)
}

const allowedReads = new Set([
  'AI_API_KEY', 'AI_TIMEOUT_MS', 'AI_MAX_TOKENS',
  'AI_API_BASE_URL', 'AI_PROVIDER_DISPLAY_NAME', 'AI_PROVIDER_REVISION',
])
const accessed = []
const guardedEnvironment = new Proxy(maliciousOverrides, {
  get(target, property) {
    accessed.push(property)
    if (typeof property === 'string' && !allowedReads.has(property)) {
      throw new Error(`unexpected environment read: ${property}`)
    }
    return target[property]
  },
})
assertConfigured(configuration(guardedEnvironment))
assert.deepStrictEqual(new Set(accessed), allowedReads)

console.log('AI provider configuration tests passed')
