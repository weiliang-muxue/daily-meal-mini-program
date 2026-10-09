'use strict'

const assert = require('assert')
const Module = require('module')
const { defaults } = require('./user-state')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()

function atomicSet(value) { return { $testAtomicSet: true, value: clone(value) } }
function isAtomicSet(value) { return value && value.$testAtomicSet === true }

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
      const next = { ...clone(current) }
      Object.entries(data).forEach(([key, value]) => {
        next[key] = isAtomicSet(value) ? clone(value.value) : clone(value)
      })
      collectionStore(name).set(id, next)
      return { stats: { updated: 1 } }
    },
  }
}

function collection(name) {
  return { doc(id) { return reference(name, id) } }
}

const database = {
  collection,
  command: { set: atomicSet },
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
const cacheNamespace = 'a'.repeat(32)
const rotatedCacheNamespace = 'b'.repeat(32)

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
  put('meal_members', owner, { status: 'active', cacheNamespace })
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
  const bootstrapped = await userData._test.bootstrap(owner, cacheNamespace)
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
    waterReminder: {
      enabled: true, cadence: 'weekdays', startTime: '09:00', endTime: '17:00', intervalMinutes: 60,
      timeZone: 'Asia/Shanghai', scheduleVersion: 1, updatedAt: '2026-09-02T00:00:00.000Z',
    },
    activePlan: { futureClientPlan: 'ignored because plans are not client editable' },
    futureTopLevelField: 'must-not-be-stored',
  }, 0, cacheNamespace)

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
  assert.strictEqual(stored.waterReminder.enabled, true)
  assert.strictEqual(stored.waterReminder.cadence, 'weekdays')
  assert.strictEqual(stored.activePlan.id, 'active', 'saving a reminder must not replace the active plan')
  assert.deepStrictEqual(stored.futureTopLevelField, { retainedByDatabasePatch: true },
    'top-level future fields remain untouched by the database update patch')
}

async function testDurationPersistenceBoundaries() {
  for (const durationDays of [0, 15]) {
    reset(currentState(20))
    const before = get('meal_user_states', owner)
    await assert.rejects(
      () => userData._test.saveState(owner, {
        generationPreferences: {
          ...defaults().generationPreferences,
          durationDays,
          mealTypes: ['breakfast'],
        },
      }, 20, cacheNamespace),
      (error) => error && error.code === 'INVALID_USER_STATE',
      `${durationDays} days must be rejected before persistence`,
    )
    assert.deepStrictEqual(get('meal_user_states', owner), before,
      `${durationDays} days must not advance the revision or alter any stored field`)
  }

  for (const durationDays of [1, 10, 14]) {
    reset(currentState(30))
    const exerciseByDay = Array.from({ length: durationDays }, (_, dayIndex) => ({
      dayIndex,
      planned: dayIndex === durationDays - 1,
      type: dayIndex === durationDays - 1 ? 'walk' : '',
      durationMinutes: dayIndex === durationDays - 1 ? 30 : 0,
      intensity: 'medium',
    }))
    const saved = await userData._test.saveState(owner, {
      generationPreferences: {
        ...defaults().generationPreferences,
        durationDays,
        mealTypes: ['breakfast', 'lunch', 'dinner'],
        exerciseByDay,
      },
    }, 30, cacheNamespace)
    assert.strictEqual(saved.stateRevision, 31,
      'saveState must return the exact committed expectedStateRevision + 1 token')
    assert.strictEqual(saved.generationPreferences.durationDays, durationDays)
    assert.strictEqual(saved.generationPreferences.exerciseByDay.length, durationDays)
    const bootstrapped = await userData._test.bootstrap(owner, cacheNamespace)
    assert.strictEqual(bootstrapped.generationPreferences.durationDays, durationDays,
      `${durationDays} days must survive a complete database round trip`)
    assert.strictEqual(bootstrapped.generationPreferences.exerciseByDay.length, durationDays)
    assert.strictEqual(get('meal_user_states', owner).stateRevision, 31)
  }
}

async function testPlanActions() {
  reset(currentState(10))
  const beforeConflict = get('meal_user_states', owner)
  await assert.rejects(
    userData._test.changePlan(owner, 'confirmDraft', {
      expectedDraftPlanId: 'draft', expectedStateRevision: 9, expectedCacheNamespace: cacheNamespace,
    }),
    (error) => error && error.code === 'STATE_REVISION_CONFLICT',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), beforeConflict,
    'revision conflict must not alter current, draft, or history plans')
  await userData._test.changePlan(owner, 'confirmDraft', {
    expectedDraftPlanId: 'draft', expectedStateRevision: 10, expectedCacheNamespace: cacheNamespace,
  })
  let stored = get('meal_user_states', owner)
  assert.strictEqual(stored.activePlan.id, 'draft')
  assert.deepStrictEqual(stored.activePlan.futurePlanField, { value: 'draft-future' })
  assert.strictEqual(stored.activePlan.days[0].futureDayField, 'day-draft-future')
  assert.strictEqual(stored.planHistory[0].id, 'active')
  assert.deepStrictEqual(stored.planHistory[0].futurePlanField, { value: 'active-future' })

  await userData._test.changePlan(owner, 'restoreHistory', {
    planId: 'active', expectedStateRevision: 11, expectedCacheNamespace: cacheNamespace,
  })
  stored = get('meal_user_states', owner)
  assert.strictEqual(stored.activePlan.id, 'active')
  assert.deepStrictEqual(stored.activePlan.futurePlanField, { value: 'active-future' })
  assert.strictEqual(stored.planHistory[0].id, 'draft')
  assert.deepStrictEqual(stored.planHistory[0].futurePlanField, { value: 'draft-future' })

  put('meal_user_states', owner, currentState(20))
  const beforeWrongDraft = get('meal_user_states', owner)
  await assert.rejects(
    userData._test.changePlan(owner, 'discardDraft', {
      expectedDraftPlanId: 'another-draft', expectedStateRevision: 20,
      expectedCacheNamespace: cacheNamespace,
    }),
    (error) => error && error.code === 'STATE_REVISION_CONFLICT',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), beforeWrongDraft,
    '另一页面看到的候选不得被当前页面丢弃')
  await userData._test.changePlan(owner, 'discardDraft', {
    expectedDraftPlanId: 'draft', expectedStateRevision: 20, expectedCacheNamespace: cacheNamespace,
  })
  stored = get('meal_user_states', owner)
  assert.strictEqual(stored.draftPlan, null)
  assertNestedFuture(stored)

  const capacityState = {
    ...currentState(30),
    planHistory: Array.from({ length: 64 }, (_, index) => plan(`capacity-${index + 1}`, `future-${index + 1}`)),
  }
  reset(capacityState)
  await assert.rejects(
    userData._test.changePlan(owner, 'confirmDraft', {
      expectedDraftPlanId: 'draft', expectedStateRevision: 30, expectedCacheNamespace: cacheNamespace,
    }),
    (error) => error && error.code === 'STATE_HISTORY_LIMIT',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), capacityState,
    'history capacity failure must leave the entire stored archive unchanged')
}

async function testDiscardDraftFailsClosedWithoutExactDraftId() {
  const invalidExpectedIds = [
    { label: 'missing expectedDraftPlanId', payload: {} },
    { label: 'empty expectedDraftPlanId', payload: { expectedDraftPlanId: '' } },
    { label: 'non-string expectedDraftPlanId', payload: { expectedDraftPlanId: 42 } },
    { label: '121-character expectedDraftPlanId', payload: { expectedDraftPlanId: 'x'.repeat(121) } },
  ]

  for (const testCase of invalidExpectedIds) {
    reset(currentState(40))
    const before = get('meal_user_states', owner)
    await assert.rejects(
      userData._test.changePlan(owner, 'discardDraft', {
        expectedStateRevision: 40,
        expectedCacheNamespace: cacheNamespace,
        ...testCase.payload,
      }),
      (error) => error && error.code === 'STATE_REVISION_CONFLICT',
      `${testCase.label} must fail closed`,
    )
    const after = get('meal_user_states', owner)
    assert.strictEqual(after.stateRevision, before.stateRevision,
      `${testCase.label} must not advance stateRevision`)
    assert.deepStrictEqual(after, before,
      `${testCase.label} must leave the entire stored document unchanged`)
  }

  const noDraft = { ...currentState(41), draftPlan: null }
  reset(noDraft)
  const beforeNoDraft = get('meal_user_states', owner)
  await assert.rejects(
    userData._test.changePlan(owner, 'discardDraft', {
      expectedDraftPlanId: 'draft',
      expectedStateRevision: 41,
      expectedCacheNamespace: cacheNamespace,
    }),
    (error) => error && error.code === 'STATE_REVISION_CONFLICT',
    'a missing stored draft must fail closed',
  )
  const afterNoDraft = get('meal_user_states', owner)
  assert.strictEqual(afterNoDraft.stateRevision, beforeNoDraft.stateRevision,
    'a missing stored draft must not advance stateRevision')
  assert.deepStrictEqual(afterNoDraft, beforeNoDraft,
    'a missing stored draft must leave the entire stored document unchanged')
}

async function testMigrations() {
  for (let schemaVersion = 1; schemaVersion <= 7; schemaVersion += 1) {
    const raw = currentState(schemaVersion)
    raw.schemaVersion = schemaVersion
    raw.settings.futureServerSetting = { fromSchema: schemaVersion }
    raw.generationPreferences.futureServerPreference = { fromSchema: schemaVersion }
    const migrated = userData._test.migrateStored(raw)
    assert.strictEqual(migrated.schemaVersion, 11)
    assert.strictEqual(migrated.waterReminder.enabled, false)
    assert.deepStrictEqual(migrated.settings.futureServerSetting, { fromSchema: schemaVersion })
    assert.deepStrictEqual(migrated.generationPreferences.futureServerPreference, { fromSchema: schemaVersion })
    reset(raw)
    const bootstrapped = await userData._test.bootstrap(owner, cacheNamespace)
    const stored = get('meal_user_states', owner)
    assert.strictEqual(bootstrapped.schemaVersion, 11)
    assert.strictEqual(bootstrapped.waterReminder.enabled, false)
    assert.deepStrictEqual(stored.settings.futureServerSetting, { fromSchema: schemaVersion })
    assert.deepStrictEqual(stored.generationPreferences.futureServerPreference, { fromSchema: schemaVersion })
    assert.deepStrictEqual(stored.activePlan.futurePlanField, { value: 'active-future' })
  }
  const unsupported = { ...currentState(), schemaVersion: 12 }
  reset(unsupported)
  await assert.rejects(
    userData._test.bootstrap(owner, cacheNamespace),
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

function testStateWritesUseTopLevelAtomicReplacement() {
  const state = currentState()
  state.dinnerModeByDay['week.2026$08'] = 'exercise'
  state.planUiStateByPlan['plan.with$dynamic-key'] = { selectedDayId: 'day.with.dot' }
  state.mealOverrides['meal.with$dynamic-key'] = { title: 'Safe nested value' }
  const replacement = userData._test.atomicStateFields(state)
  assert.deepStrictEqual(Object.keys(replacement).sort(), [
    'activePlan', 'activePlanId', 'checkedShoppingIds', 'customReminders', 'defaultDinnerMode',
    'dinnerModeByDay', 'draftPlan', 'generationPreferences', 'mealOverrides', 'planHistory',
    'planUiStateByPlan', 'schemaVersion', 'selectedDay', 'selectedDayId', 'settings', 'stateRevision',
    'waterReminder',
  ])
  Object.entries(replacement).forEach(([key, value]) => {
    assert.strictEqual(isAtomicSet(value), true, `${key} must be replaced atomically instead of flattened into field paths`)
  })
  assert.strictEqual(isAtomicSet(replacement.activePlan), true)
  assert.strictEqual(replacement.activePlan.value.days[0].meals[0].id, 'active-meal-0')
  assert.strictEqual(replacement.dinnerModeByDay.value['week.2026$08'], 'exercise')
  assert.strictEqual(replacement.planUiStateByPlan.value['plan.with$dynamic-key'].selectedDayId, 'day.with.dot')
  assert.strictEqual(replacement.mealOverrides.value['meal.with$dynamic-key'].title, 'Safe nested value')
}

async function testCacheNamespaceGenerationGuard() {
  reset(currentState(7))
  const beforeMissing = get('meal_user_states', owner)
  await assert.rejects(
    () => userData._test.saveState(owner, { selectedDay: 3 }, 7),
    (error) => error && error.code === 'STALE_DATA_GENERATION'
      && error.message === '账号数据版本已变化，请刷新后重试',
    '缺少 expectedCacheNamespace 的旧客户端不得写入',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), beforeMissing)

  put('meal_members', owner, { status: 'active', cacheNamespace: rotatedCacheNamespace })
  const beforeRotatedWrite = get('meal_user_states', owner)
  await assert.rejects(
    () => userData._test.saveState(owner, { selectedDay: 4 }, 7, cacheNamespace),
    (error) => error && error.code === 'STALE_DATA_GENERATION',
    '清空轮换 namespace 后旧设备不得写入新世代',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), beforeRotatedWrite)

  const legacy = { ...currentState(5), schemaVersion: 5 }
  put('meal_user_states', owner, legacy)
  await assert.rejects(
    () => userData._test.bootstrap(owner, cacheNamespace),
    (error) => error && error.code === 'STALE_DATA_GENERATION',
    '旧设备 bootstrap 不得迁移新世代的数据文档',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), legacy)

  const failure = userData._test.publicError(Object.assign(new Error('private detail'), {
    code: 'STALE_DATA_GENERATION',
  }))
  assert.deepStrictEqual(failure, {
    code: 'STALE_DATA_GENERATION', message: '账号数据版本已变化，请刷新后重试',
  })
}

async function testStructuredMealShoppingSave() {
  const source = currentState(4)
  source.activePlan.shoppingGroups = [{ id: 'test-group', name: '其他', items: [
    { id: 'oats', name: 'Oats', amount: '280 g' }, { id: 'eggs', name: 'Eggs', amount: '1 个' },
  ] }]
  source.activePlan.days[0].meals[0].ingredients.push({ name: 'Eggs', quantity: 1, unit: '个', category: '其他' })
  source.checkedShoppingIds = ['oats', 'eggs']
  reset(source)
  const value = { title: 'Changed', ingredients: 'Oats 80 g', method: 'Cook', tag: '', updatedAt: '2026-10-09T00:00:00.000Z',
    ingredientItems: [{ name: 'Oats', quantity: 80, unit: 'g', category: '其他' }, { name: 'Eggs', quantity: 1, unit: '个', category: '其他' }] }
  const saved = await userData._test.saveState(owner, { mealOverrides: { 'active-meal-0': value }, checkedShoppingIds: ['oats', 'eggs'] }, 4, cacheNamespace)
  assert.deepStrictEqual(saved.checkedShoppingIds, ['eggs'], 'server independently resets affected marks even when client sends old checked IDs')
  assert.deepStrictEqual(saved.activePlan, userData._test.migrateStored(source).activePlan)
  assert.deepStrictEqual(saved.planHistory, userData._test.migrateStored(source).planHistory)
  assert.deepStrictEqual(saved.mealOverrides['active-meal-0'].ingredientItems, value.ingredientItems)
  assertNestedFuture(saved)
  const beforeInvalid = get('meal_user_states', owner)
  await assert.rejects(userData._test.saveState(owner, { mealOverrides: { 'active-meal-0': { ...value, ingredientItems: [{ ...value.ingredientItems[0], quantity: -1 }] } } }, 5, cacheNamespace))
  assert.deepStrictEqual(get('meal_user_states', owner), beforeInvalid)

  const originalContext = cloudStub.getWXContext
  cloudStub.getWXContext = () => ({ OPENID: owner })
  try {
    for (const clientSchemaVersion of [undefined, 8, 9, 10, 12]) {
      const reply = await userData.main({ action: 'saveState', clientSchemaVersion, expectedStateRevision: 5, expectedCacheNamespace: cacheNamespace, state: { mealOverrides: {} } })
      assert.strictEqual(reply.code, 'STATE_SCHEMA_UNSUPPORTED')
      assert.deepStrictEqual(get('meal_user_states', owner), beforeInvalid)
    }
    const reply = await userData.main({ action: 'saveState', clientSchemaVersion: 11, expectedStateRevision: 5, expectedCacheNamespace: cacheNamespace, state: { mealOverrides: {} } })
    assert.strictEqual(reply.success, true)
    assert.deepStrictEqual(reply.data.checkedShoppingIds, ['eggs'])
  } finally { cloudStub.getWXContext = originalContext }
}

async function testSingleMealConfirmation() {
  const replacement = require('./meal-replacement')
  const source = currentState(4)
  source.draftPlan = null
  const target = replacement.createTarget(source, 'active-meal-0')
  const candidate = plan('single', 'candidate-future')
  candidate.durationDays = 1
  candidate.days = candidate.days.slice(0, 1)
  candidate.days[0].meals[0].title = 'Single replacement'
  candidate.days[0].meals[0].ingredients[0].quantity = 80
  candidate.replacementTarget = target
  source.draftPlan = candidate
  const payload = { expectedDraftPlanId: candidate.id, expectedStateRevision: 4, expectedCacheNamespace: cacheNamespace }
  reset(source)
  const before = get('meal_user_states', owner)
  for (const [action, data, code] of [
    ['confirmDraft', payload, 'MEAL_REPLACEMENT_CONFIRM_REQUIRED'],
    ['confirmMealReplacement', { ...payload, expectedDraftPlanId: 'wrong' }, 'STATE_REVISION_CONFLICT'],
    ['confirmMealReplacement', { ...payload, expectedStateRevision: 3 }, 'STATE_REVISION_CONFLICT'],
    ['confirmMealReplacement', { ...payload, expectedCacheNamespace: rotatedCacheNamespace }, 'STALE_DATA_GENERATION'],
  ]) {
    await assert.rejects(userData._test.changePlan(owner, action, data), error => error.code === code)
    assert.deepStrictEqual(get('meal_user_states', owner), before)
  }
  put('meal_members', 'another-member', { status: 'active', cacheNamespace: rotatedCacheNamespace })
  put('meal_user_states', 'another-member', { ...defaults(), stateRevision: 4 })
  await assert.rejects(userData._test.changePlan('another-member', 'confirmMealReplacement', {
    ...payload, expectedCacheNamespace: rotatedCacheNamespace,
  }), error => error.code === 'STATE_REVISION_CONFLICT')
  assert.deepStrictEqual(get('meal_user_states', owner), before, 'another member cannot confirm this draft')
  const saved = await userData._test.changePlan(owner, 'confirmMealReplacement', payload)
  const normalized = userData._test.migrateStored(before)
  for (const field of ['activePlan', 'activePlanId', 'planHistory', 'generationPreferences', 'settings', 'customReminders']) {
    assert.deepStrictEqual(saved[field], normalized[field], `${field} must remain unchanged`)
  }
  assert.strictEqual(saved.mealOverrides['active-meal-0'].title, 'Single replacement')
  assert.strictEqual(saved.stateRevision, 5)
  assert.strictEqual(saved.draftPlan, null)
  assertNestedFuture(saved)
  await assert.rejects(userData._test.changePlan(owner, 'confirmMealReplacement', payload), error => error.code === 'STATE_REVISION_CONFLICT')

  // Client-controlled state cannot create a trusted AI candidate or alter its scope.
  reset({ ...source, draftPlan: null })
  const spoof = await userData._test.saveState(owner, { draftPlan: candidate }, 4, cacheNamespace)
  assert.strictEqual(spoof.draftPlan, null)
  reset(source)
  put('meal_members', owner, { status: 'deleting', cacheNamespace })
  await assert.rejects(userData._test.changePlan(owner, 'confirmMealReplacement', payload), error => error.code === 'ACCOUNT_DELETION_IN_PROGRESS')
  assert.deepStrictEqual(get('meal_user_states', owner), source)
  reset({ ...source, draftPlan: { ...candidate, generatedAt: '2000-01-01T00:00:00.000Z' } })
  await assert.rejects(userData._test.changePlan(owner, 'confirmMealReplacement', payload), error => error.code === 'DRAFT_EXPIRED')
}

async function testCookingConditionsAndPantryTransactions() {
  const source = currentState(4)
  const conditions = { servings: 2, maxCookingMinutes: 25, pantryItems: [{ name: 'Oats', quantity: 300, unit: 'g' }] }
  source.activePlan.generationBasis = { ...source.activePlan.generationBasis, ...conditions }
  source.activePlan.shoppingGroups = [{ id: 'food', name: '其他', items: [{ id: 'oats', name: 'Oats', amount: '280 g' }] }]
  source.checkedShoppingIds = ['oats']
  source.schemaVersion = 10
  reset(source)
  const before = get('meal_user_states', owner)
  const upgraded = await userData._test.bootstrap(owner, cacheNamespace)
  assert.strictEqual(upgraded.schemaVersion, 11)
  assert.deepStrictEqual(upgraded.activePlan, userData._test.migrateStored(before).activePlan)
  assert.strictEqual(upgraded.stateRevision, 4)
  const persisted = get('meal_user_states', owner)
  await userData._test.bootstrap(owner, cacheNamespace)
  assert.deepStrictEqual(get('meal_user_states', owner), persisted, 'second bootstrap must not write or remigrate')
  const saved = await userData._test.saveState(owner, {
    generationPreferences: { ...upgraded.generationPreferences, ...conditions, servings: 5, pantryItems: [] },
    activePlan: { ...upgraded.activePlan, generationBasis: { ...conditions, pantryItems: [] } },
    mealOverrides: { 'active-meal-0': { title: '测试调整', method: 'Cook', ingredients: 'Oats',
      ingredientItems: [{ name: 'Oats', quantity: 50, unit: 'g', category: '其他' }],
      servings: 2, quantityBasis: 'total', estimatedCookingMinutes: null } },
    checkedShoppingIds: ['oats'],
  }, 4, cacheNamespace)
  assert.strictEqual(saved.generationPreferences.servings, 5)
  assert.deepStrictEqual(saved.generationPreferences.pantryItems, [])
  assert.deepStrictEqual(saved.activePlan.generationBasis.pantryItems, conditions.pantryItems, 'client cannot change a trusted plan snapshot')
  assert.deepStrictEqual(saved.checkedShoppingIds, ['oats'], 'no purchase needed before or after; retain untouched check state')
  const changed = await userData._test.saveState(owner, { mealOverrides: { 'active-meal-0': {
    ...saved.mealOverrides['active-meal-0'], ingredientItems: [{ name: 'Oats', quantity: 80, unit: 'g', category: '其他' }],
  } }, checkedShoppingIds: ['oats'] }, 5, cacheNamespace)
  assert.deepStrictEqual(changed.checkedShoppingIds, [], 'server recomputes stock once and independently invalidates the new shortage')
  const snapshot = get('meal_user_states', owner)
  await assert.rejects(userData._test.saveState(owner, { generationPreferences: { ...saved.generationPreferences, servings: 0 } }, 6, cacheNamespace), error => error.code === 'MEAL_CONDITIONS_INVALID')
  assert.deepStrictEqual(get('meal_user_states', owner), snapshot)
  await assert.rejects(userData._test.saveState(owner, { generationPreferences: conditions }, 6, rotatedCacheNamespace), error => error.code === 'STALE_DATA_GENERATION')
  assert.deepStrictEqual(get('meal_user_states', owner), snapshot)
  assert.deepStrictEqual(changed.planHistory, upgraded.planHistory)
}

;(async () => {
  await testCookingConditionsAndPantryTransactions()
  await testSingleMealConfirmation()
  await testStructuredMealShoppingSave()
  await testBootstrapAndSave()
  await testDurationPersistenceBoundaries()
  await testPlanActions()
  await testDiscardDraftFailsClosedWithoutExactDraftId()
  await testMigrations()
  await testCacheNamespaceGenerationGuard()
  testHistoryCapacityErrorIsActionable()
  testStateWritesUseTopLevelAtomicReplacement()
  console.log('userData future nested field transaction tests passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
