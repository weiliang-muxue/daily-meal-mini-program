'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { KIND, contents } = require('../build-catalog-ui-fixture')
const { assertFixture, runScenario } = require('./catalog-ui-smoke')

test('native fixture guard rejects real/unknown projects before page reads or navigation', async () => {
  for (const marker of [undefined, null, {}, { kind: 'production' }]) {
    const calls = []
    const miniProgram = new Proxy({ evaluate: async () => { calls.push('guard'); return marker } }, {
      get(target, key) { if (key in target) return target[key]; throw Error('unexpected access: ' + key) },
    })
    await assert.rejects(runScenario(miniProgram, 'not-used', () => { throw Error('not reached') }), { code: 'FIXTURE_REQUIRED' })
    assert.deepEqual(calls, ['guard'])
  }
})

test('native guard requires the exact copied public source revision', async () => {
  await assert.rejects(assertFixture({ evaluate: async () => ({ kind: KIND, sourceHash: 'stale' }) }), { code: 'FIXTURE_SOURCE_STALE' })
  await assertFixture({ evaluate: async () => ({ kind: KIND, sourceHash: contents().manifest.sourceHash }) })
})

test('native guard propagates runtime failure without proceeding', async () => {
  await assert.rejects(assertFixture({ evaluate: async () => { throw Error('fixture unavailable') } }), /fixture unavailable/)
})
