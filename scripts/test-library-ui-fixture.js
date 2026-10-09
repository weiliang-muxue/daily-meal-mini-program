'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { contents, SOURCES, memoryStore } = require('./build-library-ui-fixture')
const { memoryStore: base } = require('./build-meal-edit-ui-fixture')
const library = require('../miniprogram/services/recipe-library')
const replacement = require('../miniprogram/services/meal-replacement')
const { reconcileChecks } = require('../miniprogram/services/meal-shopping')
test('favorites native fixture is deterministic, exact-source and offline only', () => {
  const result = contents(), { files, manifest } = result
  assert.deepEqual(contents(), result)
  for (const flag of ['productionConfigurationRead', 'cloudEnabled', 'personalDataIncluded', 'deployable']) assert.equal(manifest[flag], false)
  assert.equal(JSON.parse(files['project.config.json']).appid, 'touristappid')
  for (const source of SOURCES) assert.equal(files['miniprogram/' + source], fs.readFileSync(path.resolve(__dirname, '../miniprogram', source), 'utf8'))
  assert(!SOURCES.some(p => /config|user-store|membership-store/.test(p)))
  assert.doesNotMatch(Object.values(files).join('\n'), /wx\.(?:cloud|request|login|getStorage|setStorage)/)
  for (const [filename, source] of Object.entries(files)) {
    if (!filename.endsWith('.js')) continue
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      assert(match[1].startsWith('.'))
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1]))
      assert(Object.hasOwn(files, target) || Object.hasOwn(files, target + '.js'), filename + ': ' + target)
    }
  }
})
test('fictional favorite writes use pure library with failure, revision and reset controls', async () => {
  const { store, controls } = memoryStore(base(reconcileChecks), library), before = controls.snapshot()
  const capture = { mealId: 'fixture-meal-0', expectedPlanId: 'fixture-plan' }
  controls.failSave(true)
  await assert.rejects(store.changeFavorite('addFavorite', capture, 1))
  assert.deepEqual(controls.snapshot(), before)
  controls.failSave(false)
  await store.changeFavorite('addFavorite', capture, 1)
  assert.equal(store.data.favoriteRecipes.length, 1)
  assert.equal(library.reusable(store.data.favoriteRecipes[0]), true)
  const saved = controls.snapshot(), favoriteId = store.data.favoriteRecipes[0].id
  await assert.rejects(store.changeFavorite('removeFavorite', { favoriteId }, 1))
  const target = replacement.createTarget(store.data, 'fixture-meal-1')
  controls.offline(true)
  await assert.rejects(store.changeFavorite('applyFavorite', { favoriteId, target }, 2))
  assert.deepEqual(controls.snapshot(), saved)
  controls.offline(false)
  await store.changeFavorite('applyFavorite', { favoriteId, target }, 2)
  assert.deepEqual(store.data.activePlan, before.data.activePlan)
  assert.deepEqual(Object.keys(store.data.mealOverrides), ['fixture-meal-1'])
  assert.deepEqual(store.data.checkedShoppingIds, ['fixture-eggs'])
  await store.changeFavorite('removeFavorite', { favoriteId }, 3)
  assert.equal(store.data.favoriteRecipes.length, 0)
  assert.equal(store.data.mealOverrides['fixture-meal-1'].title, '虚构早餐 1')
  controls.reset(); assert.deepEqual(controls.snapshot(), before)
})
