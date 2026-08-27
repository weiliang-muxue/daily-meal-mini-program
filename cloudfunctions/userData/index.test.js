'use strict'

const assert = require('assert')
const Module = require('module')
const { defaults } = require('./user-state')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()

function collectionStore(name) {
  if (!stores.has(name)) stores.set(name, new Map())
  return stores.get(name)
}

function reference(name, id) {
  return {
    async get() {
      const value = collectionStore(name).get(id)
      if (value === undefined) {
        const error = new Error('document does not exist')
        error.code = 'DATABASE_DOCUMENT_NOT_FOUND'
        throw error
      }
      return { data: clone(value) }
    },
    async set({ data }) {
      collectionStore(name).set(id, clone(data))
      return { stats: { created: 1 } }
    },
    async update({ data }) {
      const current = collectionStore(name).get(id)
      if (current === undefined) throw new Error('document does not exist')
      collectionStore(name).set(id, { ...clone(current), ...clone(data) })
      return { stats: { updated: 1 } }
    },
  }
}

function collection(name) {
  return { doc(id) { return reference(name, id) } }
}

const database = {
  collection,
  serverDate() { return { $serverDate: true } },
  async runTransaction(callback) { return callback({ collection }) },
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return {} },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  return originalLoad.call(this, request, parent, isMain)
}
let userData
try { userData = require('./index') } finally { Module._load = originalLoad }

const owner = 'openid-user-state-test'

function put(name, id, value) { collectionStore(name).set(id, clone(value)) }
function get(name, id) { return clone(collectionStore(name).get(id)) }

function meal(id) {
  return {
    id,
    type: 'breakfast',
    scenario: 'default',
    label: 'Breakfast',
    title: `Meal ${id}`,
    ingredients: [{ name: 'Oats', quantity: 40, unit: 'g', category: '其他' }],
    method: 'Cook',
    tag: 'Test',
  }
}

function plan(id, futureValue) {
  const result = {
    id,
    planVersion: 1,
    contractVersion: 1,
    source: 'ai',
    title: `Plan ${id}`,
    durationDays: 7,
    startDate: '2026-09-01',
    generatedAt: new Date().toISOString(),
    generationBasis: { mealTypes: ['breakfast'], doubleDinner: false },
    rationale: ['Transaction test'],
    days: Array.from({ length: 7 }, (_, dayIndex) => ({
      id: `${id}-day-${dayIndex}`,
      date: `2026-09-${String(dayIndex + 1).padStart(2, '0')}`,
      short: String(dayIndex + 1),
      name: `Day ${dayIndex + 1}`,
      theme: 'Test',
      exercise: { dayIndex, planned: false },
      meals: [meal(`${id}-meal-${dayIndex}`)],
    })),
    shoppingGroups: [{
      id: `${id}-shopping`, name: 'Food', items: [{ id: 'shared-item', name: 'Oats', amount: '1 bag' }],
    }],
    futurePlanField: { value: futureValue },
  }
  result.days[0].futureDayField = `day-${futureValue}`
  result.days[0].meals[0].futureMealField = `meal-${futureValue}`
  result.days[0].meals[0].ingredients[0].futureIngredientField = `ingredient-${futureValue}`
  return result
}

function currentState(revision = 0) {
  const state = {
    ...defaults(),
    stateRevision: revision,
    activePlan: plan('active', 'active-future'),
    draftPlan: plan('draft', 'draft-future'),
    planHistory: [plan('history', 'history-future')],
    activePlanId: 'active',
    selectedDayId: 'active-day-0',
    generationPreferences: {
      ...defaults().generationPreferences,
      mealTypes: ['breakfast'],
      futureServerPreference: { cadence: 2 },
    },
    settings: {
      calciumAnchorReminder: true,
      vitaminDReminder: false,
      futureServerSetting: { channel: 'future' },
    },
    futureTopLevelField: { retainedByDatabasePatch: true },
  }
  state.generationPreferences.exerciseByDay = [{
    dayIndex: 0, planned: true, type: 'walk', durationMinutes: 20, intensity: 'low', futureExerciseField: 'future',
  }]
  return state
}

function reset(state = currentState()) {
  stores.clear()
  put('meal_members', owner, { status: 'active' })
  put('meal_user_states', owner, state)
}

function assertNestedFuture(state) {
  assert.deepStrictEqual(state.settings.futureServerSetting, { channel: 'future' })
  assert.deepStrictEqual(state.generationPreferences.futureServerPreference, { cadence: 2 })
  assert.strictEqual(state.generationPreferences.exerciseByDay[0].futureExerciseField, 'future')
  assert.deepStrictEqual(state.activePlan.futurePlanField, { value: 'active-future' })
  assert.strictEqual(state.activePlan.days[0].futureDayField, 'day-active-future')
  assert.strictEqual(state.activePlan.days[0].meals[0].futureMealField, 'meal-active-future')
  assert.strictEqual(state.activePlan.days[0].meals[0].ingredients[0].futureIngredientField, 'ingredient-active-future')
}

async function testBootstrapAndSave() {
  reset()
  const bootstrapped = await userData._test.bootstrap(owner)
  assertNestedFuture(bootstrapped)

  await userData._test.saveState(owner, {
    settings: {
      calciumAnchorReminder: false,
      vitaminDReminder: true,
      futureClientSetting: 'must-not-be-stored',
    },
    generationPreferences: {
      ...defaults().generationPreferences,
      mealTypes: ['breakfast'],
      styles: ['Updated'],
      exerciseByDay: [{
        dayIndex: 0, planned: true, type: 'walk', durationMinutes: 25, intensity: 'medium',
        futureClientExerciseField: 'must-not-be-stored',
      }],
      futureClientPreference: 'must-not-be-stored',
    },
    activePlan: { futureClientPlan: 'ignored because plans are not client editable' },
    futureTopLevelField: 'must-not-be-stored',
  }, 0)

  const stored = get('meal_user_states', owner)
  assertNestedFuture(stored)
  assert.strictEqual(stored.settings.calciumAnchorReminder, false)
  assert.strictEqual(stored.settings.vitaminDReminder, true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored.settings, 'futureClientSetting'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored.generationPreferences, 'futureClientPreference'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(
    stored.generationPreferences.exerciseByDay[0], 'futureClientExerciseField',
  ), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored.activePlan, 'futureClientPlan'), false)
  assert.deepStrictEqual(stored.futureTopLevelField, { retainedByDatabasePatch: true },
    'top-level future fields remain untouched by the database update patch')
}

async function testPlanActions() {
  reset(currentState(10))
  const beforeConflict = get('meal_user_states', owner)
  await assert.rejects(
    userData._test.changePlan(owner, 'confirmDraft', { expectedStateRevision: 9 }),
    (error) => error && error.code === 'STATE_REVISION_CONFLICT',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), beforeConflict,
    'revision conflict must not alter current, draft, or history plans')
  await userData._test.changePlan(owner, 'confirmDraft', { expectedStateRevision: 10 })
  let stored = get('meal_user_states', owner)
  assert.strictEqual(stored.activePlan.id, 'draft')
  assert.deepStrictEqual(stored.activePlan.futurePlanField, { value: 'draft-future' })
  assert.strictEqual(stored.activePlan.days[0].futureDayField, 'day-draft-future')
  assert.strictEqual(stored.planHistory[0].id, 'active')
  assert.deepStrictEqual(stored.planHistory[0].futurePlanField, { value: 'active-future' })

  await userData._test.changePlan(owner, 'restoreHistory', { planId: 'active', expectedStateRevision: 11 })
  stored = get('meal_user_states', owner)
  assert.strictEqual(stored.activePlan.id, 'active')
  assert.deepStrictEqual(stored.activePlan.futurePlanField, { value: 'active-future' })
  assert.strictEqual(stored.planHistory[0].id, 'draft')
  assert.deepStrictEqual(stored.planHistory[0].futurePlanField, { value: 'draft-future' })

  put('meal_user_states', owner, currentState(20))
  await userData._test.changePlan(owner, 'discardDraft', { expectedStateRevision: 20 })
  stored = get('meal_user_states', owner)
  assert.strictEqual(stored.draftPlan, null)
  assertNestedFuture(stored)

  const capacityState = {
    ...currentState(30),
    planHistory: Array.from({ length: 64 }, (_, index) => plan(`capacity-${index + 1}`, `future-${index + 1}`)),
  }
  reset(capacityState)
  await assert.rejects(
    userData._test.changePlan(owner, 'confirmDraft', { expectedStateRevision: 30 }),
    (error) => error && error.code === 'STATE_HISTORY_LIMIT',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), capacityState,
    'history capacity failure must leave the entire stored archive unchanged')
}

async function testMigrations() {
  for (let schemaVersion = 1; schemaVersion <= 6; schemaVersion += 1) {
    const raw = currentState(schemaVersion)
    raw.schemaVersion = schemaVersion
    raw.settings.futureServerSetting = { fromSchema: schemaVersion }
    raw.generationPreferences.futureServerPreference = { fromSchema: schemaVersion }
    const migrated = userData._test.migrateStored(raw)
    assert.strictEqual(migrated.schemaVersion, 6)
    assert.deepStrictEqual(migrated.settings.futureServerSetting, { fromSchema: schemaVersion })
    assert.deepStrictEqual(migrated.generationPreferences.futureServerPreference, { fromSchema: schemaVersion })
    reset(raw)
    const bootstrapped = await userData._test.bootstrap(owner)
    const stored = get('meal_user_states', owner)
    assert.strictEqual(bootstrapped.schemaVersion, 6)
    assert.deepStrictEqual(stored.settings.futureServerSetting, { fromSchema: schemaVersion })
    assert.deepStrictEqual(stored.generationPreferences.futureServerPreference, { fromSchema: schemaVersion })
    assert.deepStrictEqual(stored.activePlan.futurePlanField, { value: 'active-future' })
  }
  const unsupported = { ...currentState(), schemaVersion: 7 }
  reset(unsupported)
  await assert.rejects(
    userData._test.bootstrap(owner),
    (error) => error && error.code === 'STATE_SCHEMA_UNSUPPORTED',
    'states created by a newer schema must still be rejected',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), unsupported,
    'rejecting a newer schema must not rewrite the stored document')
}

function testHistoryCapacityErrorIsActionable() {
  const error = new Error('planHistory exceeds 64 plans')
  error.code = 'STATE_HISTORY_LIMIT'
  assert.deepStrictEqual(userData._test.publicError(error), {
    code: 'STATE_HISTORY_LIMIT', message: 'planHistory exceeds 64 plans',
  })
  assert.strictEqual(userData._test.publicErrorMessage(error),
    '历史计划已达 64 份上限。为避免删除旧计划，本次计划更新未生效，请完成分页归档后重试')
  const tooLarge = new Error('user state exceeds byte limit')
  tooLarge.code = 'STATE_TOO_LARGE'
  assert.strictEqual(userData._test.publicErrorMessage(tooLarge),
    '计划历史已达文档容量上限。为避免删除旧计划，本次计划更新未生效，请完成分页归档后重试')
  assert.strictEqual(userData._test.publicErrorMessage(new Error('private internal detail')), '',
    'unknown server errors must not expose their raw message')
}

;(async () => {
  await testBootstrapAndSave()
  await testPlanActions()
  await testMigrations()
  testHistoryCapacityErrorIsActionable()
  console.log('userData future nested field transaction tests passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
