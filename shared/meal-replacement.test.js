'use strict'

// Fictional meals only. Pure tests: no network, storage or real account data.
const assert = require('assert')
const { defaults, sanitizeState, migrate, confirmDraft, confirmMealReplacement } = require('./user-state')
const replacement = require('./meal-replacement')
const shopping = require('./meal-shopping')
const clone = value => JSON.parse(JSON.stringify(value))
const ingredient = (name, quantity, unit = 'g') => ({ name, quantity, unit, category: '其他' })
function plan(id, days = 7) {
  return {
    id, source: 'ai', title: '虚构测试餐单', planVersion: 1, contractVersion: 2,
    durationDays: days, startDate: '2026-10-09', generatedAt: '2026-10-09T00:00:00.000Z',
    generationBasis: { mealTypes: ['breakfast', 'dinner'], doubleDinner: true },
    days: Array.from({ length: days }, (_, day) => ({
      id: `${id}-day-${day}`, date: `2026-10-${String(9 + day).padStart(2, '0')}`,
      exercise: { dayIndex: day, planned: true, type: '步行', durationMinutes: 30 },
      meals: ['breakfast', 'rest', 'workout'].map(kind => ({
        id: `${id}-${day}-${kind}`, type: kind === 'breakfast' ? 'breakfast' : 'dinner',
        scenario: kind === 'breakfast' ? 'default' : kind, title: '虚构原餐', method: '煮熟',
        ingredients: kind === 'breakfast' ? [ingredient('鸡蛋', 1, '个')]
          : [ingredient('燕麦', kind === 'rest' ? 60 : 100)],
      })),
    })),
    shoppingGroups: [{ id: `${id}-group`, name: '其他', items: [
      { id: `${id}-eggs`, name: '鸡蛋', amount: `${days} 个` },
      { id: `${id}-oats`, name: '燕麦', amount: `${days * 100} g` },
    ] }],
  }
}
function fixture(days = 7) {
  const activePlan = plan('original', days)
  return sanitizeState({ ...defaults(), activePlan, planHistory: [plan('history', 1)],
    stateRevision: 5, generationPreferences: { durationDays: 14, mealTypes: ['breakfast', 'lunch', 'dinner'] },
    checkedShoppingIds: ['original-eggs', 'original-oats'],
    waterReminder: { ...defaults().waterReminder, enabled: true, scheduleVersion: 4 },
    mealOverrides: { 'original-0-breakfast': { title: '其他餐的个人修改', method: '煮熟' } },
    customReminders: [{ id: 'reminder-test', text: '虚构提醒', done: true }],
  })
}
function draft(state, mealId = 'original-0-rest', dinnerMode = 'rest') {
  const target = replacement.createTarget(state, mealId, { dinnerMode })
  const meal = state.activePlan.days[0].meals.find(item => item.id === mealId)
  const candidate = plan('candidate', 1)
  candidate.days[0].exercise = { dayIndex: 0, planned: false }
  candidate.days[0].meals = [{ ...clone(meal), id: 'candidate-meal', scenario: 'default', title: '虚构新餐',
    ingredients: [ingredient('燕麦', 80)], method: '蒸熟' }]
  candidate.generationBasis = { mealTypes: [meal.type], doubleDinner: false }
  candidate.replacementTarget = target
  return candidate
}
const throwsCode = (run, code) => assert.throws(run, error => error.code === code)

for (const days of [1, 7, 14]) {
  const before = fixture(days), source = clone(before)
  const candidate = draft(before)
  const state = sanitizeState({ ...before, draftPlan: candidate })
  const snapshot = clone(state)
  const preview = replacement.proposal(state, state.draftPlan)
  assert.deepStrictEqual(state, snapshot, 'preview must not mutate any source object')
  assert.deepStrictEqual(before, source)
  const confirmed = confirmMealReplacement(state, 5)
  assert.deepStrictEqual(confirmed.activePlan, before.activePlan, `${days} day base plan remains immutable`)
  for (const field of ['planHistory', 'generationPreferences', 'waterReminder', 'customReminders', 'settings', 'selectedDayId', 'selectedDay']) {
    assert.deepStrictEqual(confirmed[field], before[field], `${field} must survive replacement`)
  }
  assert.deepStrictEqual(confirmed.mealOverrides['original-0-breakfast'], before.mealOverrides['original-0-breakfast'])
  assert.strictEqual(confirmed.mealOverrides['original-0-rest'].title, '虚构新餐')
  assert.strictEqual(confirmed.dinnerModeByDay['original-day-0'], 'rest')
  assert.deepStrictEqual(confirmed.checkedShoppingIds, ['original-eggs'])
  assert.deepStrictEqual(preview.checkedShoppingIds, confirmed.checkedShoppingIds)
  assert.strictEqual(confirmed.stateRevision, 6)
  assert.strictEqual(confirmed.draftPlan, null)
  assert.deepStrictEqual(migrate(confirmed), confirmed, 'personal replacement survives reload and migration')
  throwsCode(() => confirmDraft(state, 5), 'MEAL_REPLACEMENT_CONFIRM_REQUIRED')
  throwsCode(() => confirmMealReplacement(state, 4), 'STATE_REVISION_CONFLICT')
  throwsCode(() => confirmMealReplacement(confirmed, 6), 'DRAFT_NOT_FOUND')
  throwsCode(() => confirmMealReplacement({ ...state, activePlan: plan('other', days) }, 5), 'MEAL_REPLACEMENT_CONFLICT')
  throwsCode(() => confirmMealReplacement({ ...state, dinnerModeByDay: { 'original-day-0': 'rest' } }, 5), 'MEAL_REPLACEMENT_CONFLICT')
  throwsCode(() => confirmMealReplacement({ ...state, mealOverrides: { ...state.mealOverrides,
    'original-0-rest': { title: '另一台设备修改' } } }, 5), 'MEAL_REPLACEMENT_CONFLICT')
  for (const key of ['activePlan', 'planHistory']) {
    throwsCode(() => sanitizeState({ ...before, [key]: key === 'planHistory' ? [candidate] : candidate }), 'MEAL_REPLACEMENT_INVALID')
  }
}

const before = fixture()
const candidate = draft(before)
const request = { durationDays: 1, startDate: '2026-10-09', mealTypes: ['dinner'], doubleDinner: false,
  exerciseByDay: [{ dayIndex: 0, planned: false }] }
assert.deepStrictEqual(replacement.assertRequest(before, candidate.replacementTarget, request), candidate.replacementTarget)
for (const patch of [{ durationDays: 7 }, { mealTypes: ['dinner', 'lunch'] }, { doubleDinner: true },
  { startDate: '2026-10-10' }, { exerciseByDay: [{ dayIndex: 0, planned: true }] }]) {
  throwsCode(() => replacement.assertRequest(before, candidate.replacementTarget, { ...request, ...patch }), 'MEAL_REPLACEMENT_INVALID')
}
for (const mutate of [
  p => { p.durationDays = 7 }, p => { p.days[0].meals.push(clone(p.days[0].meals[0])) },
  p => { p.days[0].meals[0].ingredients[0].quantity = 0 },
  p => { p.days[0].meals[0].type = 'lunch' }, p => { p.days[0].date = '2026-10-10' },
  p => { p.days[0].exercise.planned = true }, p => { p.replacementTarget.extra = 'untrusted' },
]) {
  const invalid = clone(candidate); mutate(invalid)
  throwsCode(() => replacement.proposal(before, invalid), 'MEAL_REPLACEMENT_INVALID')
}
const noDraft = fixture()
noDraft.draftPlan = plan('ordinary', 1)
throwsCode(() => confirmMealReplacement(noDraft, 5), 'MEAL_REPLACEMENT_INVALID')
assert.strictEqual(confirmDraft(noDraft, 5).activePlan.id, 'ordinary', 'normal full-plan confirmation still works')
throwsCode(() => replacement.createTarget(before, 'original-0-rest'), 'MEAL_REPLACEMENT_INVALID')
const breakfast = replacement.createTarget(before, 'original-0-breakfast')
throwsCode(() => replacement.assertTargetCurrent(before, { ...breakfast, dinnerMode: 'rest' }), 'MEAL_REPLACEMENT_INVALID')

// Switching mode alone must also reset only quantities that actually changed.
const switched = shopping.reconcileChecks(before, { ...before, dinnerModeByDay: { 'original-day-0': 'rest' } })
assert.deepStrictEqual(switched.checkedShoppingIds, ['original-eggs'])
const equalCandidate = draft(before)
equalCandidate.days[0].meals[0].ingredients[0].quantity = 100
assert.deepStrictEqual(replacement.proposal(before, equalCandidate).checkedShoppingIds, before.checkedShoppingIds,
  'changing mode and recipe but keeping net total must retain the check')
const oldV9 = { ...before, schemaVersion: 9 }
assert.deepStrictEqual(migrate(oldV9), before, 'v9 to v10 must not reset data or settings')
const futureFields = clone(before)
futureFields.activePlan.days[0].meals[1].ingredients[0].futureServerAnnotation = 'unrelated metadata'
replacement.assertTargetCurrent(futureFields, candidate.replacementTarget)
assert.deepStrictEqual(replacement.createTarget(futureFields, 'original-0-rest', { dinnerMode: 'rest' }), candidate.replacementTarget,
  'trusted future fields do not create a false original-meal conflict')
console.log('single-meal replacement scope, confirmation, conflicts, shopping and migration tests passed')
