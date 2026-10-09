'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { KIND, contents } = require('../build-catalog-ui-fixture')
const { assertFixture, waitForNativePage, assertPaginationState, runScenario } = require('./catalog-ui-smoke')

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

function paginationPage(records, visibleCount, rendered = records.slice(0, visibleCount)) {
  return { data: async () => ({ total: records.length, hasMore: visibleCount < records.length,
    rows: records.slice(0, visibleCount) }),
  $$: async selector => { assert.equal(selector, '.catalog-row'); return rendered.map(item => ({
    attribute: async name => { assert.equal(name, 'data-id'); return item.id },
  })) } }
}
test('native pagination assertions accept first, middle and final batches', async () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ id: 'public_' + i }))
  for (const count of [12, 24, 31]) await assertPaginationState(paginationPage(rows, count), rows, count)
})
test('native pagination assertions reject missing, repeated, reordered or stale visible data', async () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({ id: 'public_' + i }))
  for (const rendered of [rows.slice(0, 12), [...rows.slice(0, 12), rows[0]], [...rows].reverse()]) {
    await assert.rejects(assertPaginationState(paginationPage(rows, 13, rendered), rows, 13))
  }
  const stale = paginationPage(rows, 12)
  await assert.rejects(assertPaginationState(stale, rows, 13))
  const wrongMore = paginationPage(rows, 13)
  wrongMore.data = async () => ({ total: 13, rows, hasMore: true })
  await assert.rejects(assertPaginationState(wrongMore, rows, 13))
})
