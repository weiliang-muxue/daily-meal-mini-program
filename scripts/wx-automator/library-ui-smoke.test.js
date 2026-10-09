'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { guard, runScenario, waitRemovalSettled } = require('./library-ui-smoke')
const { KIND, contents } = require('../build-library-ui-fixture')
test('library UI guard refuses wrong or stale projects before page/store access', async () => {
  for (const marker of [null, {}, { kind: 'production' }, { kind: KIND, sourceHash: 'old' }]) {
    const miniProgram = new Proxy({ evaluate: async () => marker }, { get(target, key) {
      if (key in target) return target[key]; throw Error('Unexpected access ' + String(key))
    } })
    await assert.rejects(runScenario(miniProgram, 'unused', () => {}), /fixture|required/i)
  }
  await guard({ evaluate: async () => ({ kind: KIND, sourceHash: contents().manifest.sourceHash }) })
})

test('native removal requires settled page state, not successful empty native command output', async () => {
  for (const result of [false, null, undefined, {}, 'true']) {
    await assert.rejects(waitRemovalSettled({ evaluate: async () => result }, { timeoutMs: 0 }), { code: 'NATIVE_MODAL_NO_EFFECT' })
  }
  await waitRemovalSettled({ evaluate: async () => true }, { timeoutMs: 0 })
  await assert.rejects(waitRemovalSettled({ evaluate: async () => { throw Error('connection closed') } }, { timeoutMs: 0 }), { code: 'AUTOMATOR_CONNECTION_CLOSED' })
})
