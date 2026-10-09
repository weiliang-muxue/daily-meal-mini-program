'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { guard, runScenario } = require('./meal-edit-ui-smoke')
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
