'use strict'

const assert = require('assert')
const {
  DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_API_STYLE, DEFAULT_REASONING_EFFORT,
  DEFAULT_PROVIDER_HEADERS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, providerHeaders, configuration,
} = require('./provider-config')

const base = {
  AI_BASE_URL: 'https://provider.invalid',
  AI_API_KEY: 'TEST_PLACEHOLDER_ONLY',
  AI_MODEL: 'test-model',
  AI_API_STYLE: 'responses',
  AI_REASONING_EFFORT: 'low',
}

assert.deepStrictEqual(providerHeaders({}), {})
assert.deepStrictEqual(providerHeaders({ AI_PROVIDER_HEADER_NAME: 'X-Tenant-Mode', AI_PROVIDER_HEADER_VALUE: 'TEST_ISOLATED' }), {
  'x-tenant-mode': 'TEST_ISOLATED',
})
assert.throws(() => providerHeaders({ AI_PROVIDER_HEADER_NAME: 'Authorization', AI_PROVIDER_HEADER_VALUE: 'TEST_X' }), /不安全/)
assert.throws(() => providerHeaders({ AI_PROVIDER_HEADER_NAME: 'Host', AI_PROVIDER_HEADER_VALUE: 'TEST_X' }), /不安全/)
assert.throws(() => providerHeaders({ AI_PROVIDER_HEADER_NAME: 'Content-Length', AI_PROVIDER_HEADER_VALUE: '10' }), /不安全/)
assert.throws(() => providerHeaders({
  AI_PROVIDER_HEADER_NAME: 'X-OpenAI-Actor-Authorization', AI_PROVIDER_HEADER_VALUE: 'TEST_OVERRIDE',
}), /不安全/)
assert.throws(() => providerHeaders({ AI_PROVIDER_HEADER_NAME: 'X-Test', AI_PROVIDER_HEADER_VALUE: 'TEST_OK\r\ninjected: true' }), /非法字符/)
assert.throws(() => providerHeaders({ AI_PROVIDER_HEADER_NAME: 'X-Test' }), /同时配置/)

const productionDefaults = configuration({ AI_API_KEY: 'TEST_PLACEHOLDER_ONLY' })
assert.strictEqual(productionDefaults.configured, true)
assert.strictEqual(productionDefaults.url.href, DEFAULT_ENDPOINT)
assert.strictEqual(productionDefaults.model, DEFAULT_MODEL)
assert.strictEqual(productionDefaults.apiStyle, DEFAULT_API_STYLE)
assert.strictEqual(productionDefaults.reasoningEffort, DEFAULT_REASONING_EFFORT)
assert.deepStrictEqual(productionDefaults.extraHeaders, DEFAULT_PROVIDER_HEADERS)
assert.strictEqual(productionDefaults.timeoutMs, DEFAULT_TIMEOUT_MS)
assert.strictEqual(configuration({}).configured, false)

const standard = configuration(base)
assert.strictEqual(standard.configured, true)
assert.strictEqual(standard.url.href, 'https://provider.invalid/v1/responses')
assert.deepStrictEqual(standard.extraHeaders, {})
assert.strictEqual(standard.reasoningEffort, 'low')
assert.strictEqual(Object.prototype.hasOwnProperty.call(standard, 'providerHeaderValue'), false)

const custom = configuration({
  ...base,
  AI_PROVIDER_HEADER_NAME: 'x-provider-scope',
  AI_PROVIDER_HEADER_VALUE: 'TEST_PROVIDER_VALUE',
})
assert.strictEqual(custom.configured, true)
assert.deepStrictEqual(custom.extraHeaders, { 'x-provider-scope': 'TEST_PROVIDER_VALUE' })
const defaultWithCustomHeader = configuration({
  AI_API_KEY: 'TEST_PLACEHOLDER_ONLY',
  AI_PROVIDER_HEADER_NAME: 'x-provider-scope',
  AI_PROVIDER_HEADER_VALUE: 'TEST_PROVIDER_VALUE',
})
assert.deepStrictEqual(defaultWithCustomHeader.extraHeaders, {
  ...DEFAULT_PROVIDER_HEADERS,
  'x-provider-scope': 'TEST_PROVIDER_VALUE',
})
assert.strictEqual(configuration({ ...base, AI_TIMEOUT_MS: '999999' }).timeoutMs, MAX_TIMEOUT_MS)
assert.strictEqual(configuration({ ...base, AI_TIMEOUT_MS: '1' }).timeoutMs, 5000)
assert.strictEqual(configuration({ ...base, AI_PROVIDER_HEADER_NAME: 'authorization', AI_PROVIDER_HEADER_VALUE: 'TEST_BAD' }).configured, false)
assert.strictEqual(configuration({ ...base, AI_REASONING_EFFORT: 'turbo' }).configured, false)
assert.strictEqual(configuration({ ...base, AI_API_STYLE: 'chat-completions', AI_REASONING_EFFORT: 'low' }).configured, false)
assert.strictEqual(configuration({ AI_API_KEY: 'TEST_PLACEHOLDER_ONLY', AI_API_STYLE: 'chat-completions' }).configured, false)
assert.strictEqual(configuration({
  AI_API_KEY: 'TEST_PLACEHOLDER_ONLY',
  AI_API_ENDPOINT: 'https://provider.invalid/chat/completions',
  AI_API_STYLE: 'chat-completions',
}).configured, true)

console.log('AI provider configuration tests passed')
