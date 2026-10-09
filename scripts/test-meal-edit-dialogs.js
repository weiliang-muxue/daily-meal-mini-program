'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { memoryStore } = require('./build-meal-edit-ui-fixture')
const { reconcileChecks } = require('../miniprogram/services/meal-shopping')
const editor = require('../miniprogram/services/meal-editor')
const conditions = require('../miniprogram/services/meal-conditions')
const source = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/meal-edit/meal-edit.js'), 'utf8')
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture() {
  let definition, identityListener, navigation = 0, updatesAfterUnload = 0
  const dialogs = [], timers = [], { store, controls } = memoryStore(reconcileChecks)
  const member = { cacheNamespace: 'a'.repeat(32), init: async () => ({ status: 'active' }),
    onCacheNamespaceChange(callback) { identityListener = callback; return () => {} } }
  const modules = { '../../services/user-store': { userStore: store },
    '../../services/membership-store': { membershipStore: member },
    '../../services/meal-editor': editor, '../../services/meal-conditions': conditions }
  vm.runInNewContext(source, { Page(value) { definition = value }, require(name) {
    if (!Object.hasOwn(modules, name)) throw Error('Unexpected import'); return modules[name]
  }, wx: { showModal(options) { dialogs.push(options) }, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
    navigateBack() { navigation++ }, switchTab() { navigation++ }, reLaunch() { navigation++ }, showToast() {} },
  getCurrentPages: () => [{}, {}], setTimeout(fn) { timers.push(fn) } })
  const page = { ...definition, data: clone(definition.data), setData(patch, done) {
    if (this.unloaded) updatesAfterUnload++
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
    if (done) done()
  } }
  await page.onLoad({ mealId: 'fixture-meal-0' })
  return { page, store, controls, dialogs, timers,
    navigation: () => navigation, updatesAfterUnload: () => updatesAfterUnload,
    changeIdentity() { member.cacheNamespace = 'b'.repeat(32); identityListener() },
    edit() { page.input({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '虚构待保存餐名' } }) },
    async seedOverride() {
      await store.setMealOverride('fixture-meal-0', { title: '虚构个人餐名', ingredients: '虚构食材', method: '虚构做法', tag: '' })
      await page.load({ mealId: 'fixture-meal-0' })
    } }
}

test('discard cancellation preserves draft and blocks repeated prompts', async () => {
  const f = await fixture(); f.edit()
  const before = f.controls.snapshot(), first = f.page.navigateFromPage()
  assert.equal(await f.page.navigateFromPage(), false)
  assert.equal(f.dialogs.length, 1)
  f.dialogs[0].success({ confirm: false })
  assert.equal(await first, false)
  assert.equal(f.page.data.formDirty, true)
  assert.equal(f.navigation(), 0)
  assert.deepEqual(f.controls.snapshot(), before)
})

test('discard confirmation navigates once without changing saved data', async () => {
  const f = await fixture(); f.edit()
  const before = f.controls.snapshot(), pending = f.page.navigateFromPage()
  f.dialogs[0].success({ confirm: true }); await pending
  assert.equal(f.navigation(), 1)
  assert.deepEqual(f.controls.snapshot(), before)
})

for (const transition of ['unload', 'identity']) {
  test('late discard confirmation cannot navigate after ' + transition, async () => {
    const f = await fixture(); f.edit()
    const before = f.controls.snapshot(), pending = f.page.navigateFromPage()
    if (transition === 'unload') f.page.onUnload(); else f.changeIdentity()
    f.dialogs[0].success({ confirm: true }); await pending
    assert.equal(f.navigation(), 0)
    assert.equal(f.updatesAfterUnload(), 0)
    assert.deepEqual(f.controls.snapshot(), before)
  })
}

test('reset allows only one prompt and cancellation preserves the saved override', async () => {
  const f = await fixture(); await f.seedOverride()
  const before = f.controls.snapshot()
  f.page.reset(); f.page.reset()
  assert.equal(f.dialogs.length, 1)
  await f.dialogs[0].success({ confirm: false })
  assert.deepEqual(f.controls.snapshot(), before)
  assert.equal(f.navigation(), 0)
  f.page.reset(); assert.equal(f.dialogs.length, 2)
})

test('late reset confirmation after unload neither writes nor updates dead page', async () => {
  const f = await fixture(); await f.seedOverride()
  const before = f.controls.snapshot()
  f.page.reset(); f.page.onUnload()
  await f.dialogs[0].success({ confirm: true })
  assert.deepEqual(f.controls.snapshot(), before)
  assert.equal(f.updatesAfterUnload(), 0)
  assert.equal(f.navigation(), 0)
})

test('reset failure keeps override, and retry restores only the target', async () => {
  const f = await fixture(); await f.seedOverride()
  const before = f.controls.snapshot()
  f.controls.failSave(true); f.page.reset()
  await f.dialogs[0].success({ confirm: true })
  assert.deepEqual(f.controls.snapshot(), before)
  assert.equal(f.page.data.resetting, false)
  assert(f.page.data.inlineError)
  f.controls.failSave(false); f.page.reset()
  await f.dialogs[1].success({ confirm: true })
  assert.equal(f.controls.snapshot().writes, before.writes + 1)
  assert.deepEqual(f.store.data.mealOverrides, {})
  assert.deepEqual(f.store.data.activePlan, before.data.activePlan)
})

test('reset dialog failure releases the prompt for retry without writes', async () => {
  const f = await fixture(); await f.seedOverride()
  const before = f.controls.snapshot()
  f.page.reset()
  assert.equal(typeof f.dialogs[0].fail, 'function')
  f.dialogs[0].fail(); f.page.reset()
  assert.equal(f.dialogs.length, 2)
  assert.deepEqual(f.controls.snapshot(), before)
})

test('reset duplicate confirmation writes only once', async () => {
  const f = await fixture(); await f.seedOverride()
  const before = f.controls.snapshot()
  f.page.reset()
  await Promise.all([f.dialogs[0].success({ confirm: true }), f.dialogs[0].success({ confirm: true })])
  assert.equal(f.controls.snapshot().writes, before.writes + 1)
  assert.equal(f.timers.length, 1)
})

test('reset rejects identity changes, and late fail callback does not touch a dead page', async () => {
  const f = await fixture(); await f.seedOverride()
  const before = f.controls.snapshot()
  f.page.reset(); f.changeIdentity()
  await f.dialogs[0].success({ confirm: true })
  assert.deepEqual(f.controls.snapshot(), before)
  assert.equal(f.navigation(), 0)
  const other = await fixture(); await other.seedOverride()
  other.page.reset(); other.page.onUnload(); other.dialogs[0].fail()
  assert.equal(other.updatesAfterUnload(), 0)
})

test('discard and reset cannot open overlapping confirmations', async () => {
  const f = await fixture(); await f.seedOverride(); f.edit()
  const pending = f.page.navigateFromPage()
  f.page.reset(); assert.equal(f.dialogs.length, 1)
  f.dialogs[0].success({ confirm: false }); await pending
  f.page.reset()
  assert.equal(await f.page.navigateFromPage(), false)
  assert.equal(f.dialogs.length, 2)
  await f.dialogs[1].success({ confirm: false })
  assert.equal(f.page.data.formDirty, true)
})
