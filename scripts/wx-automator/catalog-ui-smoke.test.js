'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { KIND, contents } = require('../build-catalog-ui-fixture')
const { assertFixture, waitForNativePage, runScenario } = require('./catalog-ui-smoke')

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

test('guard waits only for uninitialized runtime and never treats a foreign app as loading', async () => {
  let reads = 0
  await assertFixture({ evaluate: async () => ++reads < 3 ? { initializing: true }
    : { kind: KIND, sourceHash: contents().manifest.sourceHash } }, { timeoutMs: 1000, pollMs: 1 })
  assert.equal(reads, 3)
  await assert.rejects(assertFixture({ evaluate: async () => ({ initializing: true }) }, { timeoutMs: 0 }), { code: 'FIXTURE_NOT_READY' })
  reads = 0
  await assert.rejects(assertFixture({ evaluate: async () => { reads++; return { kind: 'production' } } }), { code: 'FIXTURE_REQUIRED' })
  assert.equal(reads, 1)
})

test('capture waits for native transition then rechecks the visible route', async () => {
  const calls = [], page = { path: 'pages/legal/sources', waitFor: async ms => calls.push(['wait', ms]) }
  await waitForNativePage({ currentPage: async () => { calls.push(['current']); return page } }, page)
  assert.deepEqual(calls, [['wait', 3000], ['current']])
  await assert.rejects(waitForNativePage({ currentPage: async () => ({ path: 'pages/plan/plan' }) }, page), { code: 'FIXTURE_CAPTURE_ROUTE_CHANGED' })
  await assert.rejects(waitForNativePage({ currentPage: async () => null }, page), { code: 'FIXTURE_CAPTURE_ROUTE_CHANGED' })
})
