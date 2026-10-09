'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { contents, SOURCES, memoryStore } = require('./build-meal-edit-ui-fixture')
const { reconcileChecks } = require('../miniprogram/services/meal-shopping')

test('native meal fixture copies exact public files and has no production entry point', () => {
  const result = contents(), { files, manifest } = result
  assert.deepEqual(contents(), result)
  for (const flag of ['productionConfigurationRead', 'cloudEnabled', 'personalDataIncluded', 'deployable']) assert.equal(manifest[flag], false)
  assert.equal(JSON.parse(files['project.config.json']).appid, 'touristappid')
  for (const source of SOURCES) assert.equal(files['miniprogram/' + source], fs.readFileSync(path.resolve(__dirname, '../miniprogram', source), 'utf8'))
  assert(!SOURCES.some(p => /config|user-store|membership-store/.test(p)))
  assert.doesNotMatch(Object.values(files).join('\n'), /wx\.(?:cloud|request|login|getStorage|setStorage)/)
  for (const [filename, source] of Object.entries(files)) {
    if (!/\.(?:js|wxss)$/.test(filename)) continue
    const re = filename.endsWith('.js') ? /require\(['"]([^'"]+)['"]\)/g : /@import\s+['"]([^'"]+)['"]/g
    for (const match of source.matchAll(re)) {
      assert(match[1].startsWith('.'))
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1]))
      assert(Object.hasOwn(files, target) || Object.hasOwn(files, target + '.js'), filename + ': ' + target)
    }
  }
})
test('meal editor and planner use boolean bindings for every fixed-height textarea', () => {
  for (const [page, expected] of [['meal-edit', 3], ['planner', 5]]) {
    const markup = fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${page}/${page}.wxml`), 'utf8')
    const textareas = [...markup.matchAll(/<textarea\b[^>]*>/g)].map(match => match[0])
    assert.equal(textareas.length, expected)
    for (const textarea of textareas) {
      assert.match(textarea, /auto-height="\{\{false\}\}"/)
      assert.doesNotMatch(textarea, /auto-height="false"/)
    }
  }
})
test('fictional store failures do not write; success affects one override and changed checks only', async () => {
  const { store, controls } = memoryStore(reconcileChecks), before = controls.snapshot()
  const override = { title: '虚构个人早餐', ingredients: '虚构食材', method: '虚构做法', tag: '',
    ingredientItems: [{ name: '虚构燕麦', quantity: 80, unit: 'g', category: '其他' }, { name: '虚构鸡蛋', quantity: 1, unit: '个', category: '其他' }] }
  controls.failSave(true)
  await assert.rejects(store.setMealOverride('fixture-meal-0', override))
  assert.deepEqual(controls.snapshot(), before)
  controls.failSave(false)
  await store.setMealOverride('fixture-meal-0', override)
  assert.equal(controls.snapshot().writes, 1)
  assert.deepEqual(store.data.activePlan, before.data.activePlan)
  assert.deepEqual(store.data.checkedShoppingIds, ['fixture-eggs'])
  assert.deepEqual(Object.keys(store.data.mealOverrides), ['fixture-meal-0'])
  await assert.rejects(store.setMealOverride('not-fixture', override))
  controls.reset(); assert.deepEqual(controls.snapshot(), before)
})
