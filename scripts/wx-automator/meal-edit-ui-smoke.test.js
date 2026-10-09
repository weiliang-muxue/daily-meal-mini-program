'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { guard, runScenario, waitDiscardCancelled, waitResetCancelled } = require('./meal-edit-ui-smoke')
const { KIND, contents } = require('../build-meal-edit-ui-fixture')
test('meal UI guard rejects real or unknown projects before touching a page or test store', async () => {
  for (const marker of [null, {}, { kind: 'production' }, { kind: KIND, sourceHash: 'old' }]) {
    const m = new Proxy({ evaluate: async () => marker }, { get(target, name) {
      if (name in target) return target[name]; throw Error('Unexpected access ' + String(name))
    } })
    await assert.rejects(runScenario(m, 'unused', () => {}), /fixture|required/i)
  }
  await guard({ evaluate: async () => ({ kind: KIND, sourceHash: contents().manifest.sourceHash }) })
})
test('native cancel requires the actual callback, not an empty successful command result', async () => {
  for (const [wait, flag] of [[waitDiscardCancelled, 'discardPromptPending'], [waitResetCancelled, 'resetPromptPending']]) {
    for (const result of [false, null, undefined, {}, 'true']) {
      await assert.rejects(wait({ evaluate: async (_callback, actualFlag) => {
        assert.equal(actualFlag, flag); return result
      } }, { timeoutMs: 0 }), { code: 'NATIVE_MODAL_NO_EFFECT' })
    }
    await wait({ evaluate: async (_callback, actualFlag) => {
      assert.equal(actualFlag, flag); return true
    } }, { timeoutMs: 0 })
    await assert.rejects(wait({ evaluate: async () => { throw Error('connection closed') } }, { timeoutMs: 0 }), { code: 'AUTOMATOR_CONNECTION_CLOSED' })
  }
})
