'use strict'

const assert = require('assert')
const {
  CURRENT_SCHEMA,
  CURRENT_AI_CONTRACT,
  MAX_HISTORY,
  MAX_MEAL_OVERRIDES,
  defaults,
  migrate,
  sanitizeState,
  sanitizeGenerationPreferences,
  sanitizeWaterReminder,
  confirmDraft,
  restoreHistory,
} = require('./user-state')

assert.strictEqual(MAX_HISTORY, 64)
assert.strictEqual(MAX_MEAL_OVERRIDES, 4620)

function meal(id, type = 'breakfast', scenario = 'default') {
  return {
    id,
    type,
    scenario,
    label: type,
    title: `Meal ${id}`,
    ingredients: [{ name: 'Ingredient', quantity: 100, unit: 'g', category: '其他' }],
    method: 'Cook it',
    tag: 'Test',
  }
}

function plan(id, shoppingIds = ['shared-item'], source = 'ai', durationDays = 7) {
  const days = Array.from({ length: durationDays }, (_, index) => ({
    id: `${id}-day-${index + 1}`,
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    short: String(index + 1),
    name: `Day ${index + 1}`,
    theme: 'Test day',
    exercise: { dayIndex: index, planned: false },
    meals: [meal(`${id}-meal-${index + 1}`)],
  }))
  return {
    id,
    planVersion: 1,
    contractVersion: source === 'legacy' ? 0 : 1,
    source,
    title: `Plan ${id}`,
    durationDays,
    startDate: '2026-09-01',
    generatedAt: source === 'legacy' ? '' : '2026-08-26T00:00:00.000Z',
    generationBasis: { mealTypes: ['breakfast'], doubleDinner: false },
    rationale: ['Test rationale'],
    days,
    shoppingGroups: [{
      id: `${id}-shopping`,
      name: 'Food',
      items: shoppingIds.map((itemId) => ({ id: itemId, name: itemId, amount: '1 item' })),
    }],
  }
}

function densePlan(id) {
  const result = plan(id, [`${id}-shopping-item`], 'ai', 14)
  result.generationBasis = {
    mealTypes: ['breakfast', 'lunch', 'dinner', 'snack'],
    doubleDinner: true,
  }
  result.days = result.days.map((day, dayIndex) => ({
    ...day,
    meals: [
      meal(`${id}-meal-${dayIndex + 1}-breakfast`, 'breakfast'),
      meal(`${id}-meal-${dayIndex + 1}-lunch`, 'lunch'),
      meal(`${id}-meal-${dayIndex + 1}-dinner-rest`, 'dinner', 'rest'),
      meal(`${id}-meal-${dayIndex + 1}-dinner-workout`, 'dinner', 'workout'),
      meal(`${id}-meal-${dayIndex + 1}-snack`, 'snack'),
    ],
  }))
  return result
}

function mealOverride(title, extra = {}) {
  return {
    title,
    ingredients: 'Personal ingredients',
    method: 'Personal method',
    tag: 'Personal',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...extra,
  }
}

function legacyTextMeal(id, type = 'breakfast', scenario = 'default') {
  return { ...meal(id, type, scenario), ingredients: 'Ingredient 100 g' }
}

function legacyPlan() {
  return {
    id: 'week-legacy-1',
    title: 'Legacy week',
    contentVersion: 3,
    days: Array.from({ length: 7 }, (_, index) => ({
      id: `legacy-day-${index + 1}`,
      short: String(index + 1),
      name: `Day ${index + 1}`,
      theme: 'Legacy',
      breakfast: {
        label: 'Breakfast', title: `Breakfast ${index + 1}`, ingredients: 'Milk 300 ml', method: 'Serve', tag: 'Calcium',
      },
      restDinner: {
        label: 'Rest dinner', title: `Rest ${index + 1}`, ingredients: 'Rice 100 g', method: 'Cook', tag: 'Light',
      },
      workoutDinner: {
        label: 'Workout dinner', title: `Workout ${index + 1}`, ingredients: 'Rice 150 g', method: 'Cook', tag: 'Recovery',
      },
    })),
    shoppingGroups: [{
      id: 'legacy-food',
      name: 'Food',
      items: [
        { id: 'shared-item', name: 'Milk', amount: '2 L' },
        { id: 'legacy-only', name: 'Rice', amount: '1 kg' },
      ],
    }],
  }
}

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error && error.code === code)
}

const empty = defaults()
assert.strictEqual(CURRENT_SCHEMA, 8)
assert.strictEqual(CURRENT_AI_CONTRACT, 2)
assert.strictEqual(empty.schemaVersion, 8)
assert.strictEqual(empty.stateRevision, 0)
assert.strictEqual(empty.activePlan, null)
assert.strictEqual(empty.draftPlan, null)
assert.deepStrictEqual(empty.planHistory, [])
assert.deepStrictEqual(empty.planUiStateByPlan, {})
assert.strictEqual(empty.generationPreferences.durationDays, 1)
assert.deepStrictEqual(empty.generationPreferences.mealTypes, [])
assert.strictEqual(empty.generationPreferences.contractVersion, 2)
assert.strictEqual(empty.generationPreferences.exerciseIntent, '', '新用户运动意图必须保持未确认')
assert.deepStrictEqual(empty.settings, { calciumAnchorReminder: false, vitaminDReminder: false })
assert.deepStrictEqual(empty.waterReminder, {
  enabled: false, cadence: 'daily', startTime: '09:00', endTime: '18:00', intervalMinutes: 60,
  timeZone: 'Asia/Shanghai', scheduleVersion: 0, updatedAt: '',
})
assert.deepStrictEqual(sanitizeState({}).settings, { calciumAnchorReminder: false, vitaminDReminder: false })
assert.deepStrictEqual(sanitizeState({ settings: { calciumAnchorReminder: true } }).settings, {
  calciumAnchorReminder: true,
  vitaminDReminder: false,
})

;Array.from({ length: 14 }, (_, index) => index + 1).forEach((durationDays) => {
  assert.strictEqual(sanitizeGenerationPreferences({ durationDays }).durationDays, durationDays)
  assert.strictEqual(sanitizeState({
    ...defaults(), activePlan: plan(`range-${durationDays}`, [`range-item-${durationDays}`], 'ai', durationDays),
  })
    .activePlan.durationDays, durationDays)
})
assert.strictEqual(sanitizeGenerationPreferences({}).durationDays, 1)
;[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 15].forEach((durationDays) => {
  assert.throws(() => sanitizeGenerationPreferences({ durationDays }), /integer between 1 and 14/)
})

const v4 = {
  schemaVersion: 4,
  activePlanId: 'week-legacy-1',
  selectedDayId: 'legacy-day-3',
  selectedDay: 2,
  defaultDinnerMode: 'workout',
  dinnerModeByDay: { 'legacy-day-3': 'workout' },
  mealOverrides: {
    'legacy-day-3:breakfast': {
      title: 'My breakfast', ingredients: 'Oats 40 g', method: 'Cook', tag: 'Personal', updatedAt: '2026-08-20T00:00:00.000Z',
    },
  },
  checkedShoppingIds: ['shared-item', 'legacy-only'],
  customReminders: [{ id: 'reminder-1', text: 'Bring notes', done: false }],
  settings: { calciumAnchorReminder: false, vitaminDReminder: true },
  futureServerField: { retained: true },
}

const legacySamples = [
  {
    version: 1,
    state: {
      schemaVersion: 1,
      selectedDay: 3,
      dinnerMode: 'workout',
      checkedShoppingIds: ['shared-item'],
      customReminders: [{ id: 'v1-reminder', text: 'Example reminder', done: false }],
      settings: { calciumAnchorReminder: false, vitaminDReminder: true },
    },
    assertState(state) {
      assert.strictEqual(state.selectedDay, 3)
      assert.strictEqual(state.defaultDinnerMode, 'workout')
      assert.deepStrictEqual(state.checkedShoppingIds, ['shared-item'])
      assert.strictEqual(state.customReminders[0].id, 'v1-reminder')
    },
  },
  {
    version: 2,
    state: {
      schemaVersion: 2,
      activePlanId: 'week-legacy-1',
      selectedDay: 1,
      dinnerMode: 'rest',
      checkedShoppingIds: ['legacy-only'],
      settings: { calciumAnchorReminder: true, vitaminDReminder: false },
    },
    assertState(state) {
      assert.strictEqual(state.activePlanId, 'week-legacy-1')
      assert.strictEqual(state.selectedDay, 1)
      assert.deepStrictEqual(state.checkedShoppingIds, ['legacy-only'])
    },
  },
  {
    version: 3,
    state: {
      schemaVersion: 3,
      activePlanId: 'week-legacy-1',
      selectedDayId: 'legacy-day-4',
      selectedDay: 3,
      defaultDinnerMode: 'rest',
      dinnerModeByDay: { 'legacy-day-4': 'workout' },
      customReminders: [{ id: 'v3-reminder', text: 'Another example', done: true }],
      settings: { calciumAnchorReminder: false, vitaminDReminder: false },
    },
    assertState(state) {
      assert.strictEqual(state.selectedDayId, 'legacy-day-4')
      assert.strictEqual(state.dinnerModeByDay['legacy-day-4'], 'workout')
      assert.strictEqual(state.customReminders[0].done, true)
    },
  },
  { version: 4, state: v4, assertState() {} },
]

legacySamples.forEach(({ version, state, assertState }) => {
  const result = migrate(state, { legacyPlan: legacyPlan(), preserveUnknownFrom: state })
  assert.strictEqual(result.schemaVersion, 8, `schema v${version} should migrate to v8`)
  assert.strictEqual(result.generationPreferences.contractVersion, 2)
  assert.strictEqual(result.activePlan.id, 'week-legacy-1')
  assert.strictEqual(result.activePlan.source, 'legacy')
  assert.deepStrictEqual(result.settings, state.settings)
  assertState(result)
})

for (let schemaVersion = 1; schemaVersion <= 4; schemaVersion += 1) {
    assert.deepStrictEqual(migrate({ schemaVersion }).settings, {
    calciumAnchorReminder: true,
    vitaminDReminder: true,
  }, `schema v${schemaVersion} without settings must retain both legacy reminder defaults`)
  assert.deepStrictEqual(migrate({
    schemaVersion,
    settings: { calciumAnchorReminder: false },
  }).settings, {
    calciumAnchorReminder: false,
    vitaminDReminder: true,
  }, `schema v${schemaVersion} must retain the missing vitamin D reminder default`)
  assert.deepStrictEqual(migrate({
    schemaVersion,
    settings: { vitaminDReminder: false },
  }).settings, {
    calciumAnchorReminder: true,
    vitaminDReminder: false,
  }, `schema v${schemaVersion} must retain the missing calcium reminder default`)
  assert.deepStrictEqual(migrate({
    schemaVersion,
    settings: { calciumAnchorReminder: false, vitaminDReminder: false },
  }).settings, {
    calciumAnchorReminder: false,
    vitaminDReminder: false,
  }, `schema v${schemaVersion} must preserve explicit reminder opt-outs`)
}

assert.deepStrictEqual(migrate({ schemaVersion: 0 }).settings, {
  calciumAnchorReminder: false,
  vitaminDReminder: false,
}, 'schema 0 data must use the new opt-in reminder defaults')
assert.deepStrictEqual(migrate({ schemaVersion: 5, settings: { calciumAnchorReminder: true } }).settings, {
  calciumAnchorReminder: true,
  vitaminDReminder: false,
}, 'schema v5 must not inherit a legacy default for a missing reminder setting')

const migrated = migrate(v4, { legacyPlan: legacyPlan(), preserveUnknownFrom: v4 })
assert.strictEqual(migrated.schemaVersion, 8)
assert.strictEqual(migrated.activePlan.id, 'week-legacy-1')
assert.strictEqual(migrated.activePlan.source, 'legacy')
assert.strictEqual(migrated.activePlan.days[0].meals.length, 3)
assert.strictEqual(migrated.selectedDayId, 'legacy-day-3')
assert.strictEqual(migrated.defaultDinnerMode, 'workout')
assert.deepStrictEqual(migrated.checkedShoppingIds, ['shared-item', 'legacy-only'])
assert.deepStrictEqual(migrated.planUiStateByPlan['week-legacy-1'].checkedShoppingIds, ['shared-item', 'legacy-only'])
assert.strictEqual(migrated.planUiStateByPlan['week-legacy-1'].dinnerModeByDay['legacy-day-3'], 'workout')
assert.deepStrictEqual(migrated.customReminders, v4.customReminders)
assert.deepStrictEqual(migrated.settings, v4.settings)
assert.deepStrictEqual(migrated.futureServerField, { retained: true })
assert.deepStrictEqual(migrate(migrated, { legacyPlan: legacyPlan(), preserveUnknownFrom: migrated }), migrated)

const existingPlan = plan('already-confirmed')
const migratedWithPlan = migrate({ ...v4, activePlan: existingPlan, activePlanId: existingPlan.id }, { legacyPlan: legacyPlan() })
assert.strictEqual(migratedWithPlan.activePlan.id, 'already-confirmed', 'migration must not replace an existing confirmed plan')
assert.strictEqual(migratedWithPlan.activePlan.source, 'ai')
assert.strictEqual(sanitizeState({
  ...defaults(), activePlan: existingPlan, activePlanId: 'stale-plan-id',
}).activePlanId, existingPlan.id, 'activePlanId must always mirror the confirmed active plan')

const legacyV1Plan = plan('schema-v6-plan', ['schema-v6-item'], 'ai', 14)
const schemaV6 = {
  ...defaults(),
  schemaVersion: 6,
  stateRevision: 24,
  activePlan: legacyV1Plan,
  activePlanId: legacyV1Plan.id,
  planHistory: [plan('schema-v6-history', ['history-item'], 'ai', 7)],
  generationPreferences: {
    ...defaults().generationPreferences,
    contractVersion: 1,
    durationDays: 14,
    mealTypes: ['breakfast'],
  },
  checkedShoppingIds: ['schema-v6-item'],
  customReminders: [{ id: 'schema-v6-reminder', text: 'Keep this reminder', done: false }],
}
schemaV6.planUiStateByPlan = {
  [legacyV1Plan.id]: {
    selectedDayId: legacyV1Plan.days[6].id,
    selectedDay: 6,
    defaultDinnerMode: 'workout',
    dinnerModeByDay: { [legacyV1Plan.days[6].id]: 'workout' },
    checkedShoppingIds: ['schema-v6-item'],
  },
}
const schemaV7 = migrate(schemaV6, { preserveUnknownFrom: schemaV6 })
assert.strictEqual(schemaV7.schemaVersion, 8)
assert.strictEqual(schemaV7.stateRevision, 24)
assert.strictEqual(schemaV7.generationPreferences.contractVersion, 2,
  'schema v6 preferences must migrate to the current request contract')
assert.strictEqual(schemaV7.generationPreferences.durationDays, 14)
assert.strictEqual(schemaV7.activePlan.contractVersion, 1,
  'migration must keep an existing contract v1 plan readable')
assert.strictEqual(schemaV7.planHistory[0].contractVersion, 1)
assert.deepStrictEqual(schemaV7.checkedShoppingIds, ['schema-v6-item'])
assert.deepStrictEqual(schemaV7.customReminders, schemaV6.customReminders)
assert.deepStrictEqual(schemaV7.planUiStateByPlan[legacyV1Plan.id], schemaV6.planUiStateByPlan[legacyV1Plan.id])
assert.deepStrictEqual(migrate(schemaV7, { preserveUnknownFrom: schemaV7 }), schemaV7,
  'schema v8 migration must be idempotent')

for (let schemaVersion = 1; schemaVersion <= 7; schemaVersion += 1) {
  const legacy = { ...migrated, schemaVersion, waterReminder: { enabled: true, cadence: 'weekdays' } }
  const result = migrate(legacy, { preserveUnknownFrom: legacy })
  assert.strictEqual(result.waterReminder.enabled, false, `schema v${schemaVersion} must default water reminders off`)
  assert.strictEqual(result.activePlan.id, migrated.activePlan.id)
  assert.deepStrictEqual(result.customReminders, migrated.customReminders)
  assert.deepStrictEqual(result.checkedShoppingIds, migrated.checkedShoppingIds)
}

assert.deepStrictEqual(sanitizeWaterReminder({
  enabled: true, cadence: 'weekdays', startTime: '08:00', endTime: '18:00', intervalMinutes: 120,
  timeZone: 'Asia/Shanghai', scheduleVersion: 2, updatedAt: '2026-09-02T00:00:00.000Z',
}), {
  enabled: true, cadence: 'weekdays', startTime: '08:00', endTime: '18:00', intervalMinutes: 120,
  timeZone: 'Asia/Shanghai', scheduleVersion: 2, updatedAt: '2026-09-02T00:00:00.000Z',
})
;[
  { cadence: 'holidays' },
  { startTime: '8:00' },
  { startTime: '18:00', endTime: '18:00' },
  { intervalMinutes: 15 },
  { timeZone: 'UTC' },
].forEach((waterReminder) => assert.throws(() => sanitizeWaterReminder(waterReminder)))
assert.strictEqual(sanitizeWaterReminder({ startTime: '00:00', endTime: '11:30', intervalMinutes: 30 }).enabled, false)
assert.throws(
  () => sanitizeWaterReminder({ startTime: '00:00', endTime: '12:00', intervalMinutes: 30 }),
  /more than 24 reminders/,
)

throwsCode(() => migrate({ ...migrated, schemaVersion: 9 }), 'STATE_SCHEMA_UNSUPPORTED')

const clientSanitized = sanitizeState(migrated)
assert.strictEqual(Object.prototype.hasOwnProperty.call(clientSanitized, 'futureServerField'), false)
const serverSanitized = sanitizeState(migrated, { preserveUnknownFrom: migrated })
assert.deepStrictEqual(serverSanitized.futureServerField, { retained: true })
assert.strictEqual(sanitizeState(migrated, { preserveUnknown: true }).futureServerField, undefined,
  '旧的隐式信任选项不能再放行未知字段')

const nestedFutureState = {
  ...defaults(),
  settings: {
    calciumAnchorReminder: true,
    vitaminDReminder: false,
    futureServerSetting: { channel: 'future' },
  },
  generationPreferences: {
    ...defaults().generationPreferences,
    futureServerPreference: { cadence: 2 },
    exerciseByDay: [{
      dayIndex: 0, planned: true, type: 'walk', durationMinutes: 30, intensity: 'low',
      futureExerciseField: 'preserve',
    }],
  },
  activePlan: {
    ...plan('future-active'),
    futurePlanField: { version: 6 },
  },
}
nestedFutureState.activePlan.days[0].futureDayField = 'future-day'
nestedFutureState.activePlan.days[0].meals[0].futureMealField = 'future-meal'
nestedFutureState.activePlan.days[0].meals[0].ingredients[0].futureIngredientField = 'future-ingredient'
const nestedPreserved = sanitizeState({
  ...nestedFutureState,
  settings: { calciumAnchorReminder: false, vitaminDReminder: true, clientInjected: 'reject' },
  generationPreferences: {
    ...nestedFutureState.generationPreferences,
    styles: ['Updated'],
    clientInjected: 'reject',
  },
}, { preserveUnknownFrom: nestedFutureState })
assert.strictEqual(nestedPreserved.settings.calciumAnchorReminder, false)
assert.deepStrictEqual(nestedPreserved.settings.futureServerSetting, { channel: 'future' })
assert.strictEqual(Object.prototype.hasOwnProperty.call(nestedPreserved.settings, 'clientInjected'), false)
assert.deepStrictEqual(nestedPreserved.generationPreferences.futureServerPreference, { cadence: 2 })
assert.strictEqual(Object.prototype.hasOwnProperty.call(nestedPreserved.generationPreferences, 'clientInjected'), false)
assert.strictEqual(nestedPreserved.generationPreferences.exerciseByDay[0].futureExerciseField, 'preserve')
assert.deepStrictEqual(nestedPreserved.activePlan.futurePlanField, { version: 6 })
assert.strictEqual(nestedPreserved.activePlan.days[0].futureDayField, 'future-day')
assert.strictEqual(nestedPreserved.activePlan.days[0].meals[0].futureMealField, 'future-meal')
assert.strictEqual(nestedPreserved.activePlan.days[0].meals[0].ingredients[0].futureIngredientField, 'future-ingredient')

const clientCannotAddUnknown = sanitizeState({
  ...defaults(),
  settings: { calciumAnchorReminder: true, futureClientSetting: true },
  generationPreferences: { ...defaults().generationPreferences, futureClientPreference: true },
  activePlan: { ...plan('client-plan'), futureClientPlan: true },
})
assert.strictEqual(Object.prototype.hasOwnProperty.call(clientCannotAddUnknown.settings, 'futureClientSetting'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(clientCannotAddUnknown.generationPreferences, 'futureClientPreference'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(clientCannotAddUnknown.activePlan, 'futureClientPlan'), false)

const dynamicMapSource = {
  ...defaults(),
  activePlan: plan('dynamic-map'),
  dinnerModeByDay: { 'dynamic-map-day-1': 'workout' },
  mealOverrides: {
    'dynamic-map-meal-1': {
      title: 'Old override', ingredients: 'Old', method: 'Old', tag: '', futureOverrideField: 'stored-future',
    },
  },
}
const dynamicMapCurrent = sanitizeState(dynamicMapSource, { preserveUnknownFrom: dynamicMapSource })
const dynamicMapCleared = sanitizeState({
  ...dynamicMapCurrent,
  dinnerModeByDay: {},
  mealOverrides: {},
}, { preserveUnknownFrom: dynamicMapCurrent })
assert.deepStrictEqual(dynamicMapCleared.dinnerModeByDay, {}, '用户删除的晚餐模式映射不能被未来字段保留逻辑恢复')
assert.deepStrictEqual(dynamicMapCleared.mealOverrides, {}, '用户删除的餐食覆盖不能被未来字段保留逻辑恢复')

const draft = plan('new-plan', ['shared-item', 'new-only'])
const stateWithDraftSource = { ...migrated, stateRevision: 7, draftPlan: draft }
const stateWithDraft = sanitizeState(stateWithDraftSource, { preserveUnknownFrom: stateWithDraftSource })
throwsCode(() => confirmDraft(stateWithDraft, 6), 'STATE_REVISION_CONFLICT')
const confirmed = confirmDraft(stateWithDraft, 7)
assert.strictEqual(confirmed.stateRevision, 8)
assert.strictEqual(confirmed.activePlan.id, 'new-plan')
assert.strictEqual(confirmed.draftPlan, null)
assert.strictEqual(confirmed.planHistory[0].id, 'week-legacy-1')
assert.deepStrictEqual(confirmed.checkedShoppingIds, [])
assert.deepStrictEqual(confirmed.futureServerField, { retained: true })

const twentyHistoryPlans = Array.from({ length: 20 }, (_, index) => plan(`history-${index + 1}`, [`history-item-${index + 1}`]))
const fullHistoryState = sanitizeState({
  ...defaults(),
  stateRevision: 10,
  activePlan: plan('current-plan', ['shared-item']),
  draftPlan: plan('next-plan', ['shared-item']),
  planHistory: twentyHistoryPlans,
  planUiStateByPlan: {
    'history-20': {
      selectedDayId: 'history-20-day-4',
      selectedDay: 3,
      defaultDinnerMode: 'workout',
      dinnerModeByDay: { 'history-20-day-4': 'workout' },
      checkedShoppingIds: ['history-item-20'],
    },
  },
})
const retained = confirmDraft(fullHistoryState, 10)
assert.strictEqual(retained.planHistory.length, 21)
assert.strictEqual(retained.planHistory[0].id, 'current-plan')
assert.deepStrictEqual(retained.planHistory.slice(1).map((item) => item.id), twentyHistoryPlans.map((item) => item.id))
const oldestRestored = restoreHistory(retained, 'history-20', 11)
assert.strictEqual(oldestRestored.activePlan.id, 'history-20')
assert.strictEqual(oldestRestored.planHistory.length, 21)
assert.strictEqual(oldestRestored.planHistory.some((item) => item.id === 'history-20'), false)
assert.strictEqual(oldestRestored.planHistory.some((item) => item.id === 'next-plan'), true)
assert.deepStrictEqual(oldestRestored.checkedShoppingIds, ['history-item-20'])
assert.strictEqual(oldestRestored.defaultDinnerMode, 'workout')
assert.strictEqual(oldestRestored.dinnerModeByDay['history-20-day-4'], 'workout')
const maximumHistory = Array.from({ length: 64 }, (_, index) => plan(`maximum-${index + 1}`))
throwsCode(() => confirmDraft(sanitizeState({
  ...defaults(), stateRevision: 11, activePlan: plan('overflow-current'), draftPlan: plan('overflow-next'), planHistory: maximumHistory,
}), 11), 'STATE_HISTORY_LIMIT')

const restoreStateSource = {
  ...confirmed,
  stateRevision: 20,
  checkedShoppingIds: ['shared-item', 'new-only'],
  planHistory: [migrated.activePlan, ...twentyHistoryPlans.slice(0, 4)],
}
const restoreState = sanitizeState(restoreStateSource, { preserveUnknownFrom: restoreStateSource })
throwsCode(() => restoreHistory(restoreState, 'week-legacy-1', 19), 'STATE_REVISION_CONFLICT')
const restored = restoreHistory(restoreState, 'week-legacy-1', 20)
assert.strictEqual(restored.stateRevision, 21)
assert.strictEqual(restored.activePlan.id, 'week-legacy-1')
assert.strictEqual(restored.planHistory[0].id, 'new-plan')
assert.strictEqual(restored.planHistory.some((item) => item.id === 'week-legacy-1'), false)
assert.deepStrictEqual(restored.checkedShoppingIds, ['shared-item', 'legacy-only'])
assert.strictEqual(restored.planHistory.length, 5)

// A later 14-day generation only changes plans. User-owned preferences and UI state survive
// confirmation and restoration in both directions.
const originalSevenDay = plan('confirmed-seven', ['shared-item', 'seven-only'])
const generatedFourteenDay = plan('generated-fourteen', ['shared-item', 'fourteen-only'], 'ai', 14)
const personalState = sanitizeState({
  ...defaults(),
  stateRevision: 30,
  activePlan: originalSevenDay,
  activePlanId: originalSevenDay.id,
  selectedDayId: originalSevenDay.days[2].id,
  selectedDay: 2,
  draftPlan: generatedFourteenDay,
  generationPreferences: {
    contractVersion: 1,
    durationDays: 14,
    startDate: '2026-09-01',
    mealTypes: ['breakfast'],
    goals: ['Custom goal'],
    styles: ['Custom style'],
    restrictions: 'No peanuts',
    healthNotes: '',
    exerciseIntent: 'daily',
    exerciseNotes: 'Morning sessions',
    exerciseByDay: [{ dayIndex: 0, planned: true, type: 'run', durationMinutes: 30, intensity: 'medium' }],
  },
  mealOverrides: {
    'confirmed-seven-meal-1': {
      title: 'Personal breakfast', ingredients: 'Oats 40 g', method: 'Cook', tag: 'Personal', updatedAt: '2026-08-25T00:00:00.000Z',
    },
    'orphaned-meal': {
      title: 'Old edit', ingredients: 'Old ingredients', method: 'Old method', tag: '', updatedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  checkedShoppingIds: ['shared-item', 'seven-only'],
  defaultDinnerMode: 'workout',
  dinnerModeByDay: { [originalSevenDay.days[2].id]: 'workout' },
  customReminders: [{ id: 'personal-reminder', text: 'Bring notes', done: false }],
  settings: { calciumAnchorReminder: true, vitaminDReminder: false },
})
assert.deepStrictEqual(Object.keys(personalState.mealOverrides), ['confirmed-seven-meal-1'])
const fourteenConfirmed = confirmDraft(personalState, 30)
assert.strictEqual(fourteenConfirmed.activePlan.id, 'generated-fourteen')
assert.strictEqual(fourteenConfirmed.activePlan.durationDays, 14)
assert.strictEqual(fourteenConfirmed.planHistory[0].id, 'confirmed-seven')
assert.deepStrictEqual(fourteenConfirmed.checkedShoppingIds, [])
assert.deepStrictEqual(fourteenConfirmed.generationPreferences, personalState.generationPreferences)
assert.deepStrictEqual(fourteenConfirmed.customReminders, personalState.customReminders)
assert.deepStrictEqual(fourteenConfirmed.mealOverrides, personalState.mealOverrides)
assert.deepStrictEqual(fourteenConfirmed.settings, personalState.settings)

const sevenRestored = restoreHistory(fourteenConfirmed, 'confirmed-seven', 31)
assert.strictEqual(sevenRestored.activePlan.id, 'confirmed-seven')
assert.strictEqual(sevenRestored.activePlan.durationDays, 7)
assert.strictEqual(sevenRestored.planHistory[0].id, 'generated-fourteen')
assert.deepStrictEqual(sevenRestored.generationPreferences, personalState.generationPreferences)
assert.deepStrictEqual(sevenRestored.customReminders, personalState.customReminders)
assert.deepStrictEqual(sevenRestored.mealOverrides, personalState.mealOverrides)
assert.deepStrictEqual(sevenRestored.settings, personalState.settings)
assert.deepStrictEqual(sevenRestored.checkedShoppingIds, ['shared-item', 'seven-only'])
assert.strictEqual(sevenRestored.defaultDinnerMode, 'workout')
assert.strictEqual(sevenRestored.dinnerModeByDay[originalSevenDay.days[2].id], 'workout')

const cappedOverrideState = sanitizeState({
  ...defaults(),
  stateRevision: 40,
  activePlan: plan('override-current'),
  draftPlan: plan('override-next'),
  planHistory: Array.from({ length: 6 }, (_, index) => plan(`override-history-${index + 1}`)),
  mealOverrides: {
    'override-current-meal-1': { title: 'Current', ingredients: 'A', method: 'B', tag: '' },
    'override-next-meal-1': { title: 'Draft', ingredients: 'A', method: 'B', tag: '' },
    'override-history-5-meal-1': { title: 'Kept history', ingredients: 'A', method: 'B', tag: '' },
    'override-history-6-meal-1': { title: 'Capped history', ingredients: 'A', method: 'B', tag: '' },
    'unknown-meal': { title: 'Unknown', ingredients: 'A', method: 'B', tag: '' },
  },
})
assert.deepStrictEqual(Object.keys(cappedOverrideState.mealOverrides).sort(), [
  'override-current-meal-1', 'override-history-5-meal-1', 'override-history-6-meal-1', 'override-next-meal-1',
])

const filterFirstPlan = plan('override-filter-first')
const filterFirstMealId = filterFirstPlan.days[0].meals[0].id
const invalidLegacyOverrides = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [
  `removed-plan-meal-${index + 1}`,
  index % 2 ? null : { malformed: true },
]))
const filterFirstSource = {
  ...defaults(),
  activePlan: filterFirstPlan,
  mealOverrides: {
    ...invalidLegacyOverrides,
    [filterFirstMealId]: mealOverride('Still referenced', { futureOverrideField: { format: 2 } }),
  },
}
const filteredFirst = sanitizeState(filterFirstSource, { preserveUnknownFrom: filterFirstSource })
assert.deepStrictEqual(Object.keys(filteredFirst.mealOverrides), [filterFirstMealId],
  'unreferenced legacy overrides must be filtered before entry validation or capacity checks')
assert.deepStrictEqual(filteredFirst.mealOverrides[filterFirstMealId].futureOverrideField, { format: 2 },
  'trusted future fields must survive on a retained personal override')

const denseActive = densePlan('override-dense-active')
const denseDraft = densePlan('override-dense-draft')
const denseHistory = densePlan('override-dense-history')
const densePlans = [denseActive, denseDraft, denseHistory]
const denseOverrides = Object.fromEntries(densePlans.flatMap((item) => item.days.flatMap((day) => (
  day.meals.map((itemMeal) => [itemMeal.id, mealOverride('Personal dense meal')])
))))
const firstDenseMealId = denseActive.days[0].meals[0].id
denseOverrides[firstDenseMealId].futureOverrideField = 'trusted-vNext-value'
const denseOverrideSource = {
  ...defaults(),
  stateRevision: 50,
  activePlan: denseActive,
  planHistory: [denseHistory],
  mealOverrides: denseOverrides,
}
const denseBeforeDraft = sanitizeState(denseOverrideSource, { preserveUnknownFrom: denseOverrideSource })
const denseAddedDraft = sanitizeState({
  ...denseBeforeDraft,
  draftPlan: denseDraft,
}, { preserveUnknownFrom: denseBeforeDraft })
assert.deepStrictEqual(denseAddedDraft.mealOverrides, denseBeforeDraft.mealOverrides,
  'adding a new draft period must not replace adjustments belonging to retained plans')
const denseOverrideState = sanitizeState({
  ...denseOverrideSource,
  draftPlan: denseDraft,
}, { preserveUnknownFrom: { ...denseOverrideSource, draftPlan: denseDraft } })
assert.strictEqual(Object.keys(denseOverrideState.mealOverrides).length, 210,
  'all personal overrides referenced by retained plans must survive beyond the legacy 200-entry limit')
assert.strictEqual(denseOverrideState.mealOverrides[firstDenseMealId].futureOverrideField, 'trusted-vNext-value')
const denseConfirmed = confirmDraft(denseOverrideState, 50)
assert.deepStrictEqual(denseConfirmed.mealOverrides, denseOverrideState.mealOverrides,
  'confirming a later plan must not replace retained personal meal adjustments')
const denseRestored = restoreHistory(denseConfirmed, denseHistory.id, 51)
assert.deepStrictEqual(denseRestored.mealOverrides, denseOverrideState.mealOverrides,
  'restoring an older plan must not replace adjustments belonging to any retained plan')

const tooManyDays = plan('too-many-days')
tooManyDays.days.push(...Array.from({ length: 8 }, (_, index) => ({
  ...tooManyDays.days[0],
  id: `extra-day-${index}`,
  meals: [meal(`extra-meal-${index}`)],
})))
tooManyDays.durationDays = 15
assert.throws(() => sanitizeState({ ...defaults(), activePlan: tooManyDays }), /too many items/)

const emptyPlan = plan('empty-plan', [], 'ai', 1)
emptyPlan.days = []
emptyPlan.durationDays = 0
assert.throws(() => sanitizeState({ ...defaults(), activePlan: emptyPlan }), /at least 1 day/)

const mismatchedDuration = plan('mismatched-duration', [], 'ai', 10)
mismatchedDuration.durationDays = 9
assert.throws(() => sanitizeState({ ...defaults(), activePlan: mismatchedDuration }), /does not match days/)

const tooManyMeals = plan('too-many-meals')
tooManyMeals.days[0].meals = [
  meal('m1', 'breakfast'),
  meal('m2', 'lunch'),
  meal('m3', 'dinner', 'default'),
  meal('m4', 'dinner', 'rest'),
  meal('m5', 'dinner', 'workout'),
  meal('m6', 'snack'),
]
assert.throws(() => sanitizeState({ ...defaults(), activePlan: tooManyMeals }), /too many items/)

const longTitle = plan('long-title')
longTitle.title = 'x'.repeat(51)
assert.throws(() => sanitizeState({ ...defaults(), activePlan: longTitle }), /exceeds 50 characters/)

const aiTextIngredients = plan('bad-ai-text')
aiTextIngredients.days[0].meals = [legacyTextMeal('bad-text')]
assert.throws(() => sanitizeState({ ...defaults(), activePlan: aiTextIngredients }), /structured array/)

const exerciseBasis = plan('exercise-basis')
exerciseBasis.generationBasis.exerciseByDay = [{ dayIndex: 0, planned: true, type: 'run', durationMinutes: 30, intensity: 'high' }]
const exerciseState = sanitizeState({ ...defaults(), activePlan: exerciseBasis })
assert.strictEqual(exerciseState.activePlan.generationBasis.exerciseByDay[0].planned, true)

const oversized = plan('oversized')
oversized.untrustedPadding = 'x'.repeat(256 * 1024)
throwsCode(() => sanitizeState({ ...defaults(), activePlan: oversized }), 'PLAN_TOO_LARGE')

console.log('user-state schema v8 tests passed')
