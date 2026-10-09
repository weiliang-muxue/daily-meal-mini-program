'use strict'

const assert = require('assert')
const core = require('../shared/user-state')
const library = require('../shared/recipe-library')
const replacement = require('../shared/meal-replacement')
const { shoppingView } = require('../miniprogram/services/plan-view')
const copy = value => JSON.parse(JSON.stringify(value))
const NOW = '2026-10-09T00:00:00.000Z'
const ID = 'fav_' + 'a'.repeat(32)
function fixture(days = 7) {
  const activePlan = { id: 'test-library-plan', title: '虚构收藏测试', source: 'ai', planVersion: 1, contractVersion: 2,
    durationDays: days, startDate: '2026-10-09', generatedAt: NOW,
    generationBasis: { mealTypes: ['breakfast', 'dinner'], doubleDinner: true },
    days: Array.from({ length: days }, (_, i) => ({ id: `day-${i}`, date: `2026-10-${String(9 + i).padStart(2, '0')}`,
      exercise: { dayIndex: i, planned: false }, meals: ['breakfast', 'rest', 'workout'].map(kind => ({
        id: `meal-${i}-${kind}`, type: kind === 'breakfast' ? 'breakfast' : 'dinner', scenario: kind === 'breakfast' ? 'default' : kind,
        title: `虚构${kind}`, method: '煮熟', tag: '仅测试', servings: 2, quantityBasis: 'total', estimatedCookingMinutes: 15,
        ingredients: [{ name: kind === 'breakfast' ? '鸡蛋' : '燕麦', quantity: kind === 'breakfast' ? 2 : kind === 'rest' ? 60 : 100,
          unit: kind === 'breakfast' ? '个' : 'g', category: '其他' }],
      })) })),
    shoppingGroups: [{ id: 'test-shopping', name: '其他', items: [
      { id: 'egg', name: '鸡蛋', amount: `${days * 2} 个` }, { id: 'oat', name: '燕麦', amount: `${days * 160} g` },
    ] }],
  }
  return core.sanitizeState({ ...core.defaults(), activePlan, stateRevision: 3, checkedShoppingIds: ['egg', 'oat'],
    generationPreferences: { ...core.defaults().generationPreferences, restrictions: '虚构忌口，仅供测试' },
    customReminders: [{ id: 'test-reminder', text: '测试提醒', done: false }],
  })
}
function run() {
  for (const days of [1, 7, 14]) {
    const before = fixture(days), original = copy(before)
    const state = library.add(before, 'meal-0-breakfast', ID, NOW)
    assert.deepStrictEqual(before, original, 'capture is pure')
    assert.strictEqual(state.favoriteRecipes[0].recipe.servings, 2)
    assert.strictEqual(state.favoriteRecipes[0].recipe.ingredientItems[0].quantity, 2)
    assert.strictEqual(library.add(state, 'meal-0-breakfast', 'fav_' + 'b'.repeat(32), NOW), state, 'duplicate snapshot is not another entry')
    const target = replacement.createTarget(state, 'meal-0-rest')
    const next = core.sanitizeState(library.proposal(state, ID, target, NOW), { preserveUnknownFrom: state })
    assert.deepStrictEqual(next.activePlan, state.activePlan)
    assert.deepStrictEqual(next.planHistory, state.planHistory)
    assert.deepStrictEqual(next.favoriteRecipes, state.favoriteRecipes)
    assert.deepStrictEqual(next.generationPreferences, state.generationPreferences, 'favorites never change restrictions')
    assert.deepStrictEqual(next.customReminders, state.customReminders)
    assert.strictEqual(next.mealOverrides['meal-0-rest'].ingredientItems[0].quantity, 2, 'no second scale by diners')
    assert.strictEqual(next.mealOverrides['meal-0-rest'].servings, 2)
    assert.deepStrictEqual(next.checkedShoppingIds, [], 'both changed net amounts need checking again')
    const removed = core.sanitizeState(library.remove(next, ID), { preserveUnknownFrom: next })
    assert.deepStrictEqual(removed.favoriteRecipes, [], 'trusted merge must not resurrect a removed snapshot')
    assert.deepStrictEqual(removed.mealOverrides, next.mealOverrides)
    assert.throws(() => library.proposal(removed, ID, target, NOW), error => error.code === 'RECIPE_LIBRARY_CONFLICT')
    assert.throws(() => library.proposal({ ...state, mealOverrides: { 'meal-0-rest': { title: '已改变' } } }, ID, target, NOW), error => error.code === 'MEAL_REPLACEMENT_CONFLICT')
    assert.throws(() => library.proposal(state, ID, { ...target, dinnerMode: 'rest' }, NOW))
    assert.throws(() => replacement.createTarget(state, 'meal-0-workout'))
    const unchanged = library.proposal(state, ID, replacement.createTarget(state, 'meal-0-breakfast'), NOW)
    assert.deepStrictEqual(unchanged.checkedShoppingIds, state.checkedShoppingIds)
    assert.deepStrictEqual(shoppingView(unchanged.activePlan, unchanged), shoppingView(state.activePlan, state))
    const newPlan = copy(state.activePlan); newPlan.id = 'new-plan'
    const afterUpgrade = core.migrate({ ...state, schemaVersion: 11, activePlan: newPlan, planHistory: [state.activePlan] })
    assert.deepStrictEqual(afterUpgrade.favoriteRecipes, state.favoriteRecipes)
    assert.deepStrictEqual(core.migrate(afterUpgrade), afterUpgrade)
    const confirmed = core.confirmDraft({ ...state, draftPlan: newPlan }, state.stateRevision)
    assert.deepStrictEqual(confirmed.favoriteRecipes, state.favoriteRecipes, 'confirming another period cannot change favorite snapshots')
    const restored = core.restoreHistory(confirmed, state.activePlan.id, confirmed.stateRevision)
    assert.deepStrictEqual(restored.favoriteRecipes, state.favoriteRecipes, 'restoring history cannot change favorite snapshots')
  }
  const state = fixture(1)
  state.mealOverrides['meal-0-breakfast'] = { title: '我的调整', ingredients: '仅文字新食材', method: '新做法', tag: '' }
  const legacy = library.add(state, 'meal-0-breakfast', ID, NOW)
  assert.strictEqual(legacy.favoriteRecipes[0].recipe.title, '我的调整')
  assert.strictEqual(legacy.favoriteRecipes[0].recipe.ingredients, '仅文字新食材')
  assert.strictEqual(legacy.favoriteRecipes[0].recipe.ingredientItems, undefined, 'do not silently copy incompatible base ingredients')
  assert.strictEqual(legacy.favoriteRecipes[0].recipe.estimatedCookingMinutes, null)
  assert.strictEqual(library.reusable(legacy.favoriteRecipes[0]), false)
  assert.throws(() => library.proposal(legacy, ID, replacement.createTarget(state, 'meal-0-rest'), NOW))
  state.mealOverrides['meal-0-breakfast'].ingredientItems = [{ name: '豆腐', quantity: 125, unit: 'g', category: '其他' }]
  const adjusted = library.capture(state, 'meal-0-breakfast')
  assert.strictEqual(adjusted.ingredientItems[0].name, '豆腐')
  state.mealOverrides['meal-0-breakfast'].ingredientItems[0].quantity = 300
  assert.strictEqual(adjusted.ingredientItems[0].quantity, 125, 'snapshot must not alias original objects')
  const favorite = library.add(fixture(1), 'meal-0-breakfast', ID, NOW).favoriteRecipes[0]
  assert.deepStrictEqual(library.sanitizeFavorites([{ ...favorite, openid: 'fictional-only', recipe: { ...favorite.recipe, secret: 'ignored' } }]), [favorite])
  for (const invalid of [null, {}, [favorite, favorite], [{ ...favorite, id: '__proto__' }], [{ ...favorite, createdAt: 'invalid' }]]) assert.throws(() => library.sanitizeFavorites(invalid))
  const invalidQuantities = [0, -1, Infinity, NaN, 0.0001, 100001, '2']
  invalidQuantities.forEach(quantity => assert.throws(() => library.sanitizeFavorites([{ ...favorite, recipe: { ...favorite.recipe,
    ingredientItems: [{ ...favorite.recipe.ingredientItems[0], quantity }] } }])))
  const filled = Array.from({ length: 30 }, (_, i) => ({ ...favorite, id: `fav_${i.toString(16).padStart(32, '0')}` }))
  assert.strictEqual(library.sanitizeFavorites(filled).length, 30)
  assert.throws(() => library.sanitizeFavorites([...filled, favorite]), error => error.code === 'RECIPE_LIBRARY_FULL')
  assert.throws(() => library.sanitizeFavorites(filled.map(item => ({ ...item, recipe: { ...item.recipe,
    title: '测试'.repeat(25), method: '文'.repeat(500), ingredients: '食'.repeat(500),
    ingredientItems: Array.from({ length: 30 }, () => ({ name: '食'.repeat(50), quantity: 100, unit: 'g', category: '其他' })) } }))), error => error.code === 'RECIPE_LIBRARY_FULL')
  for (const version of [8, 9, 10, 11]) {
    const previous = fixture(7); delete previous.favoriteRecipes
    const migrated = core.migrate({ ...previous, schemaVersion: version })
    assert.deepStrictEqual(migrated, { ...previous, schemaVersion: 12, favoriteRecipes: [] })
  }
  console.log('Recipe library: snapshot, 1/7/14-day shopping, migration, limits and conflict tests passed')
}
module.exports = { fixture, NOW, ID }
if (require.main === module) run()
