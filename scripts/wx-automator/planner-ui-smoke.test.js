'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { guard, runScenario, nativeBoolean } = require('./planner-ui-smoke')
const { KIND, contents } = require('../build-planner-ui-fixture')
test('planner UI guard refuses other or stale projects before page or store access', async () => {
  for (const marker of [null, {}, { kind: 'production' }, { kind: KIND, sourceHash: 'old' }]) {
    const m = new Proxy({ evaluate: async () => marker }, { get(target, name) {
      if (name in target) return target[name]; throw Error('Unexpected access ' + String(name))
    } })
    await assert.rejects(runScenario(m, 'unused', () => {}), /fixture|required/i)
  }
  await guard({ evaluate: async () => ({ kind: KIND, sourceHash: contents().manifest.sourceHash }) })
})
test('native boolean assertions accept explicit true/false only, not missing values', () => {
  for (const value of [true, 'true']) assert.equal(nativeBoolean(value), true)
  for (const value of [false, 'false']) assert.equal(nativeBoolean(value), false)
  for (const value of [null, undefined, '', '0', 0, {}, 'unknown']) assert.throws(() => nativeBoolean(value))
})
