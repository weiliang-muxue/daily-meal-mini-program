'use strict'

// Fictional fixtures: real state normalization, shopping and replacement paths,
// without wx, production configuration, external calls or private user records.
const assert = require('assert')
const stateCore = require('../shared/user-state')
const conditions = require('../shared/meal-conditions')
const shopping = require('../shared/meal-shopping')
const replacement = require('../shared/meal-replacement')
const { shoppingView, buildPlanView } = require('../miniprogram/services/plan-view')
const editor = require('../miniprogram/services/meal-editor')
const replacementView = require('../miniprogram/services/meal-replacement-view')
const copy = value => JSON.parse(JSON.stringify(value))
const oat = quantity => ({ name: '燕麦', quantity, unit: 'g', category: '其他' })
const egg = quantity => ({ name: '鸡蛋', quantity, unit: '个', category: '其他' })
const settings = { servings: 3, maxCookingMinutes: 30, pantryItems: [{ name: '燕麦', quantity: 120, unit: 'g' }] }
const metadata = { servings: 3, quantityBasis: 'total', estimatedCookingMinutes: 20 }
function fixture(length, id = 'fictional-cooking') {
  const activePlan = { id, planVersion: 1, contractVersion: 2, source: 'ai', title: '虚构采购计算', durationDays: length,
    startDate: '2026-10-09', generatedAt: '2026-10-09T00:00:00.000Z', rationale: ['离线测试'],
    generationBasis: { mealTypes: ['breakfast', 'dinner'], doubleDinner: true, ...copy(settings),
      pantryItems: [{ name: '燕麦', quantity: length * 100 + 20, unit: 'g' }] },
    days: Array.from({ length }, (_, index) => ({ id: `${id}-day-${index}`, date: `2026-10-${String(9 + index).padStart(2, '0')}`,
      theme: '测试', exercise: { dayIndex: index, planned: false }, meals: [
        { id: `${id}-breakfast-${index}`, type: 'breakfast', scenario: 'default', title: '燕麦鸡蛋', method: '煮熟', ingredients: [oat(40), egg(1)], ...metadata },
        { id: `${id}-rest-${index}`, type: 'dinner', scenario: 'rest', title: '燕麦晚餐', method: '煮熟', ingredients: [oat(60)], ...metadata },
        { id: `${id}-workout-${index}`, type: 'dinner', scenario: 'workout', title: '运动搭配', method: '煮熟', ingredients: [oat(100)], ...metadata },
      ] })),
    shoppingGroups: [{ id: `${id}-group`, name: '其他', items: [
      { id: `${id}-oats`, name: '燕麦', amount: `${length * 200} g` },
      { id: `${id}-eggs`, name: '鸡蛋', amount: `${length} 个` },
    ] }],
  }
  return stateCore.migrate({ ...stateCore.defaults(), stateRevision: 7, activePlan, activePlanId: id,
    checkedShoppingIds: [`${id}-oats`, `${id}-eggs`], generationPreferences: { ...stateCore.defaults().generationPreferences, ...copy(settings) } })
}
const items = state => shoppingView(state.activePlan, state).groups.flatMap(group => group.items)
const edit = (state, quantity) => stateCore.sanitizeState(shopping.reconcileChecks(state, { ...state,
  mealOverrides: { ...state.mealOverrides, [`${state.activePlan.id}-breakfast-0`]: { title: '调整餐食', method: '煮熟',
    ingredients: '结构化食材', ingredientItems: [oat(quantity), egg(1)], ...metadata, estimatedCookingMinutes: null } },
}))

for (const length of [1, 7, 14]) {
  const original = fixture(length), originalCopy = copy(original)
  assert.strictEqual(items(original).length, 1, 'covered oats are not a purchase checkbox')
  const covered = shoppingView(original.activePlan, original).coveredGroups[0].items[0]
  assert.strictEqual(covered.requiredQuantity, length * 100, 'only selected dinner contributes')
  assert.strictEqual(covered.pantryQuantity, length * 100)
  assert.strictEqual(covered.quantity, 0)
  assert.strictEqual(shoppingView(original.activePlan, original).unusedPantry[0].quantity, 20)
  const withinStock = edit(original, 50)
  assert.deepStrictEqual(withinStock.checkedShoppingIds, original.checkedShoppingIds, 'gross change alone must not reset unchanged net purchases')
  const exceedsStock = edit(original, 80)
  const purchase = items(exceedsStock).find(item => item.name === '燕麦')
  assert.strictEqual(purchase.quantity, 20)
  assert.strictEqual(purchase.requiredQuantity, length * 100 + 40)
  assert.deepStrictEqual(exceedsStock.checkedShoppingIds, ['fictional-cooking-eggs'])
  assert.strictEqual(editor.shoppingChanges(original, exceedsStock).changes[0].after, '20 g')
  const changedMode = shopping.reconcileChecks(original, { ...original, dinnerModeByDay: { 'fictional-cooking-day-0': 'workout' } })
  assert.strictEqual(items(changedMode).find(item => item.name === '燕麦').quantity, 20)
  assert.deepStrictEqual(changedMode.checkedShoppingIds, ['fictional-cooking-eggs'])
  const preferencesChanged = stateCore.sanitizeState({ ...original, generationPreferences: {
    ...original.generationPreferences, servings: 12, maxCookingMinutes: 180, pantryItems: [],
  } })
  assert.deepStrictEqual(shoppingView(preferencesChanged.activePlan, preferencesChanged), shoppingView(original.activePlan, original))
  assert.deepStrictEqual(original, originalCopy, 'preview must never spend pantry or mutate a plan')
  assert.deepStrictEqual(exceedsStock.activePlan, original.activePlan)
  const archived = stateCore.sanitizeState({ ...exceedsStock, activePlan: fixture(1, 'another').activePlan, activePlanId: 'another',
    planHistory: [original.activePlan], checkedShoppingIds: [], planUiStateByPlan: {
      ...exceedsStock.planUiStateByPlan, [original.activePlan.id]: { ...exceedsStock.planUiStateByPlan[original.activePlan.id], checkedShoppingIds: exceedsStock.checkedShoppingIds },
    } })
  const restored = stateCore.restoreHistory(archived, original.activePlan.id, archived.stateRevision)
  assert.strictEqual(items(restored).find(item => item.name === '燕麦').quantity, 20)
  assert.deepStrictEqual(restored.activePlan.generationBasis, original.activePlan.generationBasis)
  assert.deepStrictEqual(restored.mealOverrides, exceedsStock.mealOverrides)
}

// Legacy data gets editable preference defaults, never invented historical metadata.
for (const version of [8, 9, 10]) {
  const current = fixture(7), legacy = copy(current)
  legacy.schemaVersion = version
  for (const key of ['servings', 'maxCookingMinutes', 'pantryItems']) {
    delete legacy.generationPreferences[key]
    delete legacy.activePlan.generationBasis[key]
  }
  legacy.activePlan.days.forEach(day => day.meals.forEach(meal => {
    for (const key of ['servings', 'quantityBasis', 'estimatedCookingMinutes']) delete meal[key]
  }))
  legacy.waterReminder = { ...legacy.waterReminder, enabled: true, scheduleVersion: 8 }
  legacy.customReminders = [{ id: 'fictional-reminder', text: '测试提醒', done: true }]
  const migrated = stateCore.migrate(legacy)
  assert.strictEqual(migrated.schemaVersion, 11)
  assert.strictEqual(migrated.generationPreferences.servings, 1)
  assert.strictEqual(migrated.generationPreferences.maxCookingMinutes, 30)
  assert.deepStrictEqual(migrated.generationPreferences.pantryItems, [])
  for (const key of ['activePlan', 'checkedShoppingIds', 'stateRevision', 'waterReminder', 'customReminders', 'mealOverrides', 'planHistory']) {
    assert.deepStrictEqual(migrated[key], legacy[key], `${key} must survive v${version} migration unchanged`)
  }
  assert.deepStrictEqual(stateCore.migrate(migrated), migrated)
  assert.strictEqual(items(migrated).find(item => item.name === '燕麦').quantity, 700)
}
for (const partial of [ { servings: 0 }, { maxCookingMinutes: 181 }, { pantryItems: [{ name: '燕麦', quantity: 0, unit: 'g' }] } ]) {
  assert.throws(() => stateCore.sanitizeGenerationPreferences({ ...settings, ...partial }), error => error.code === 'MEAL_CONDITIONS_INVALID')
}
assert.deepStrictEqual(conditions.storedConditions({}), {})
assert.throws(() => conditions.storedConditions({ servings: 2 }), /重新确认/)
assert.throws(() => conditions.storedMealConditions({ ...metadata, quantityBasis: 'per-person' }), /总份量/)
assert.throws(() => conditions.storedMealConditions({ ...metadata, estimatedCookingMinutes: null }), /整数/)
assert.deepStrictEqual(conditions.storedMealConditions({ ...metadata, estimatedCookingMinutes: null }, { allowUnknownTime: true }), { ...metadata, estimatedCookingMinutes: null })

const source = fixture(1), mealId = 'fictional-cooking-breakfast-0'
const target = replacement.createTarget(source, mealId)
const context = replacementView.createContext(source, { planId: source.activePlan.id, mealId })
const preferences = replacementView.initialPreferences(source, context)
assert.deepStrictEqual(preferences.pantryItems, source.activePlan.generationBasis.pantryItems)
const input = { ...preferences, durationDays: 1, mealTypes: ['breakfast'], doubleDinner: false, startDate: source.activePlan.startDate }
assert.deepStrictEqual(replacement.assertRequest(source, target, input), target)
assert.throws(() => replacement.assertRequest(source, target, { ...input, pantryItems: [] }), /已有食材/)
const changedBasis = copy(source)
changedBasis.activePlan.generationBasis.pantryItems[0].quantity++
assert.throws(() => replacement.assertTargetCurrent(changedBasis, target), error => error.code === 'MEAL_REPLACEMENT_CONFLICT')
const draft = fixture(1, 'single').activePlan
draft.days[0].meals = [{ ...draft.days[0].meals[0], servings: 2, estimatedCookingMinutes: 15, ingredients: [oat(70), egg(1)] }]
draft.replacementTarget = target
const proposed = replacement.proposal(source, draft)
assert.strictEqual(proposed.mealOverrides[mealId].servings, 2)
assert.strictEqual(proposed.mealOverrides[mealId].estimatedCookingMinutes, 15)
assert.strictEqual(buildPlanView(proposed.activePlan, proposed).selectedDay.meals[0].servings, 2)
assert.strictEqual(items(proposed).find(item => item.name === '燕麦').quantity, 10)
assert.deepStrictEqual(proposed.activePlan, source.activePlan)
assert.throws(() => replacement.proposal(source, { ...draft, generationBasis: { ...draft.generationBasis, pantryItems: [] } }), /已有食材/)
const meal = proposed.mealOverrides[mealId], base = { ...meal, ingredients: editor.rowsText(meal.ingredientItems) }
const editTitle = editor.draftOverride({ ...base, title: '改名' }, base, meal.ingredientItems, meal.ingredientItems, meal, false)
assert.strictEqual(editTitle.estimatedCookingMinutes, 15)
const editMethod = editor.draftOverride({ ...base, method: '手动修改做法' }, base, meal.ingredientItems, meal.ingredientItems, meal, false)
assert.strictEqual(editMethod.estimatedCookingMinutes, null, 'do not carry an old AI duration estimate into changed cooking instructions')
const changedIngredients = editor.draftOverride(base, base, [oat(100), egg(1)], meal.ingredientItems, meal, true)
assert.strictEqual(changedIngredients.estimatedCookingMinutes, null)
assert.strictEqual(changedIngredients.servings, 2)
const changedWithoutMetadata = { ...proposed, mealOverrides: { [mealId]: { title: meal.title, ingredients: meal.ingredients,
  ingredientItems: meal.ingredientItems, method: '另一种做法' } } }
const preserved = stateCore.sanitizeState(changedWithoutMetadata, { preserveUnknownFrom: proposed })
assert.strictEqual(preserved.mealOverrides[mealId].servings, 2)
assert.strictEqual(preserved.mealOverrides[mealId].estimatedCookingMinutes, null, 'preserving trusted fields must not resurrect a stale estimate')
const sameTextDifferentServings = editor.draftOverride(base, { ...base, servings: 3 }, meal.ingredientItems, meal.ingredientItems, meal, false)
assert.strictEqual(sameTextDifferentServings.servings, 2, 'unchanged recipe text alone must not silently reset different serving metadata')
const large = conditions.applyPantry([{ id: 'large', items: [{ id: 'sum', name: '燕麦', quantity: 1400000, unit: 'g' }] }], [{ name: '燕麦', quantity: 100000, unit: 'g' }])
assert.strictEqual(large.groups[0].items[0].quantity, 1300000, 'plan sum may exceed a single input bound')
const customUnit = conditions.applyPantry([{ id: 'custom', items: [{ id: 'custom-item', name: '燕麦', quantity: 2, unit: '小碗' }] }], settings.pantryItems)
assert.strictEqual(customUnit.groups[0].items[0].quantity, 2, 'unknown units do not consume another unit or break projection')
console.log('cooking state tests passed: v8-v11 preservation, net purchases, history, fixed pantry scope, single replacement and metadata')
