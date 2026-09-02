'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const storageData = new Map()

global.wx = {
  getStorageSync(key) { return storageData.get(key) },
  setStorageSync(key, value) { storageData.set(key, value) },
  removeStorageSync(key) { storageData.delete(key) },
}

const {
  AiPlannerService,
  CONTRACT_VERSION,
  PLANNER_VERSION,
  AI_DATA_CONSENT_VERSION,
  PROVIDER_CONTRACT_REVISION,
} = require('../miniprogram/services/ai-planner')
const { UserStore } = require('../miniprogram/services/user-store')
const {
  normalizeRequest,
  expectedMealKeys,
  extractModelText,
  parseModelJson,
  normalizePlan,
} = require('../cloudfunctions/aiPlanner/lib')
const {
  CURRENT_SCHEMA,
  defaults,
  migrate,
  sanitizeState,
  confirmDraft,
  restoreHistory,
} = require('../shared/user-state')

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']
const DURATIONS = [1, 10, 14]
const namespace = 'a'.repeat(32)
const providerRevision = PROVIDER_CONTRACT_REVISION
const generatedAt = '2026-08-31T08:00:00.000Z'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function memberStore() {
  const listeners = new Set()
  return {
    cacheNamespace: namespace,
    onCacheNamespaceChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function symbol(index) {
  return String.fromCodePoint(0x3400 + index)
}

function rawAiPlan(input) {
  const keys = expectedMealKeys(input)
  return {
    title: '虚构测试餐单',
    rationale: ['根据用户主动选择的餐次、饮食意图和运动安排生成'],
    days: Array.from({ length: input.durationDays }, (_, dayIndex) => ({
      theme: `均衡搭配${symbol(dayIndex)}`,
      meals: keys.map((key, mealIndex) => {
        const [type, scenario] = key.split(':')
        return {
          type,
          scenario,
          title: `时蔬谷物餐${symbol(dayIndex * 5 + mealIndex)}`,
          ingredients: [{ name: '时令蔬菜', quantity: 100 + mealIndex, unit: 'g', category: '蔬菜' }],
          method: '清洗后煮熟，按一人份装盘',
          tag: '测试数据',
        }
      }),
    })),
  }
}

function intentFor(index) {
  if (index % 3 === 0) return { goals: ['高碳水'], styles: [], customGoal: '' }
  if (index % 3 === 1) return { goals: [], styles: ['清淡低油'], customGoal: '' }
  return { goals: [], styles: [], customGoal: '优先使用当季食材' }
}

function preferencesFor({ durationDays, mealTypes, doubleDinner, caseIndex }) {
  const exerciseIntent = caseIndex % 2 === 0 ? 'none' : 'daily'
  const exerciseByDay = exerciseIntent === 'daily'
    ? [{ dayIndex: durationDays - 1, planned: true, type: '快走', durationMinutes: 30, intensity: 'medium' }]
    : []
  return {
    contractVersion: CONTRACT_VERSION,
    durationDays,
    startDate: '2026-09-01',
    mealTypes,
    doubleDinner,
    ...intentFor(caseIndex),
    restrictions: '',
    healthNotes: '',
    exerciseIntent,
    exerciseNotes: exerciseIntent === 'daily' ? '按计划完成' : '',
    exerciseByDay,
  }
}

function completedTask(taskId, resultStateRevision) {
  return {
    taskId,
    contractVersion: CONTRACT_VERSION,
    plannerVersion: PLANNER_VERSION,
    status: 'succeeded',
    phase: 'done',
    taskRevision: 1,
    completedSteps: 1,
    totalSteps: 1,
    progressPercent: 100,
    resultStateRevision,
  }
}

async function runPipeline(options) {
  const requestId = `request_pipeline_${String(options.caseIndex).padStart(4, '0')}`
  const taskId = `task_pipeline_${String(options.caseIndex).padStart(4, '0')}`
  const planId = `plan_${options.durationDays}_${options.caseIndex}_${options.doubleDinner ? 1 : 0}`
  const preferences = preferencesFor(options)
  const calls = []
  const taskStorage = {
    getStorageSync(key) { return storageData.get(key) },
    setStorageSync(key, value) { storageData.set(key, value) },
    removeStorageSync(key) { storageData.delete(key) },
  }
  const members = memberStore()
  const caller = async (name, action, payload) => {
    calls.push({ name, action, payload: clone(payload) })
    assert.strictEqual(name, 'aiPlanner')
    assert.strictEqual(action, 'start')

    const normalized = normalizeRequest(payload.preferences)
    const providerResponse = {
      status: 'completed',
      output: [{
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(rawAiPlan(normalized)) }],
      }],
    }
    const modelJson = parseModelJson(extractModelText(providerResponse, 'responses'))
    const draftPlan = normalizePlan(modelJson, normalized, { planId, generatedAt })
    return {
      task: completedTask(taskId, 1),
      result: { draftPlan, generationPreferences: normalized, stateRevision: 1, updatedAt: generatedAt },
    }
  }

  const planner = new AiPlannerService(members, caller, taskStorage)
  const response = await planner.start(
    preferences, 0, requestId, AI_DATA_CONSENT_VERSION, providerRevision,
  )
  assert.strictEqual(calls.length, 1)
  assert.deepStrictEqual(calls[0].payload.preferences, preferences)
  assert.strictEqual(calls[0].payload.expectedStateRevision, 0)
  assert.strictEqual(calls[0].payload.clientRequestId, requestId)
  assert.deepStrictEqual(calls[0].payload.aiDataConsent, {
    accepted: true, version: AI_DATA_CONSENT_VERSION, providerRevision,
  })
  assert.strictEqual(calls[0].payload.expectedCacheNamespace, namespace)

  const normalized = normalizeRequest(preferences)
  const expectedKeys = expectedMealKeys(normalized)
  assert.strictEqual(response.draftPlan.durationDays, options.durationDays)
  assert.deepStrictEqual(response.draftPlan.generationBasis.mealTypes, normalized.mealTypes)
  assert.strictEqual(response.draftPlan.generationBasis.doubleDinner, options.doubleDinner)
  assert.strictEqual(response.draftPlan.generationBasis.exerciseIntent, normalized.exerciseIntent)
  assert(response.draftPlan.days.every((day) => (
    day.meals.map((meal) => `${meal.type}:${meal.scenario}`).join('|') === expectedKeys.join('|')
  )))
  assert(response.draftPlan.shoppingGroups.some((group) => group.items.length > 0))

  const stateFromCloud = sanitizeState({
    ...defaults(),
    stateRevision: response.stateRevision,
    draftPlan: response.draftPlan,
    generationPreferences: response.generationPreferences,
  })
  const firstStore = new UserStore(members)
  firstStore.bindNamespace({ loadCache: false })
  firstStore.replaceFromCloud(stateFromCloud, namespace)

  const reloadedStore = new UserStore(members)
  reloadedStore.bindNamespace()
  assert.strictEqual(reloadedStore.data.draftPlan.id, planId)
  assert.deepStrictEqual(reloadedStore.data.generationPreferences, normalized)

  const confirmed = confirmDraft(reloadedStore.data, response.stateRevision)
  reloadedStore.replaceFromCloud(confirmed, namespace)
  const confirmedReload = new UserStore(members)
  confirmedReload.bindNamespace()
  assert.strictEqual(confirmedReload.data.activePlan.id, planId)
  assert.strictEqual(confirmedReload.data.activePlan.durationDays, options.durationDays)
  assert.deepStrictEqual(confirmedReload.data.activePlan.generationBasis, response.draftPlan.generationBasis)
  assert.deepStrictEqual(confirmedReload.data.generationPreferences, normalized)
  return confirmedReload.data.activePlan
}

async function testAllMealCombinations() {
  const coverage = new Map(DURATIONS.map((durationDays) => [durationDays, {
    exercise: new Set(), diet: new Set(), masks: new Set(),
  }]))
  const generatedPlans = []
  let caseIndex = 0

  for (const durationDays of DURATIONS) {
    for (let mask = 1; mask < (1 << MEAL_TYPES.length); mask += 1) {
      const mealTypes = MEAL_TYPES.filter((_, index) => mask & (1 << index))
      const dinnerModes = mealTypes.includes('dinner') ? [false, true] : [false]
      for (const doubleDinner of dinnerModes) {
        const options = { durationDays, mealTypes, doubleDinner, caseIndex }
        const plan = await runPipeline(options)
        generatedPlans.push(plan)
        const preferences = preferencesFor(options)
        const intent = preferences.goals.length ? 'goals'
          : preferences.styles.length ? 'styles' : 'customGoal'
        const durationCoverage = coverage.get(durationDays)
        durationCoverage.exercise.add(preferences.exerciseIntent)
        durationCoverage.diet.add(intent)
        durationCoverage.masks.add(mask)
        caseIndex += 1
      }
    }
  }

  assert.strictEqual(caseIndex, 69, '15 个餐次组合及合法双晚餐分支在 1/10/14 天下应形成 69 条闭环')
  coverage.forEach((value, durationDays) => {
    assert.strictEqual(value.masks.size, 15, `${durationDays} 天必须覆盖 15 种非空餐次组合`)
    assert.deepStrictEqual([...value.exercise].sort(), ['daily', 'none'])
    assert.deepStrictEqual([...value.diet].sort(), ['customGoal', 'goals', 'styles'])
  })
  return generatedPlans
}

async function testDurationExerciseAndDietIntentCrossProduct(startCaseIndex) {
  const dietIntents = ['goals', 'styles', 'customGoal']
  const exerciseIntents = ['none', 'daily']
  let caseIndex = startCaseIndex
  let executed = 0

  for (const durationDays of DURATIONS) {
    for (const exerciseIntent of exerciseIntents) {
      for (const dietIntent of dietIntents) {
        const requestedCaseIndex = caseIndex
        const options = {
          durationDays,
          mealTypes: ['breakfast', 'lunch', 'dinner'],
          doubleDinner: true,
          caseIndex: requestedCaseIndex,
        }
        while (preferencesFor(options).exerciseIntent !== exerciseIntent
          || !preferencesFor(options)[dietIntent].length) {
          options.caseIndex += 1
        }
        const plan = await runPipeline(options)
        assert.strictEqual(plan.durationDays, durationDays)
        assert.strictEqual(plan.generationBasis.exerciseIntent, exerciseIntent)
        assert(plan.generationBasis[dietIntent].length > 0)
        assert.deepStrictEqual(
          ['goals', 'styles', 'customGoal'].filter((key) => plan.generationBasis[key].length > 0),
          [dietIntent],
        )
        caseIndex = options.caseIndex + 1
        executed += 1
      }
    }
  }

  assert.strictEqual(executed, 18, '1/10/14 天必须完整组合 none/daily 与三类显式饮食意图')
  return caseIndex
}

function testMigrationAndLaterCyclePreservePersonalState(oldPlan, nextPlan) {
  const oldMealId = oldPlan.days[0].meals[0].id
  const oldShoppingId = oldPlan.shoppingGroups[0].items[0].id
  const legacy = {
    ...defaults(),
    schemaVersion: 4,
    stateRevision: 40,
    activePlan: oldPlan,
    activePlanId: oldPlan.id,
    draftPlan: nextPlan,
    selectedDayId: oldPlan.days[0].id,
    selectedDay: 0,
    defaultDinnerMode: 'rest',
    checkedShoppingIds: [oldShoppingId],
    mealOverrides: {
      [oldMealId]: {
        title: '个人调整餐', ingredients: '个人调整食材', method: '个人调整做法',
        tag: '个人方案', updatedAt: '2026-08-31T07:00:00.000Z',
      },
    },
    customReminders: [{ id: 'personal-reminder', text: '虚构补充提醒', done: false }],
    settings: { calciumAnchorReminder: true, vitaminDReminder: false },
    futureServerField: { retained: true },
  }
  const migrated = migrate(legacy, { preserveUnknownFrom: legacy })
  assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA)
  assert.deepStrictEqual(migrated.mealOverrides, legacy.mealOverrides)
  assert.deepStrictEqual(migrated.checkedShoppingIds, [oldShoppingId])
  assert.deepStrictEqual(migrated.customReminders, legacy.customReminders)
  assert.deepStrictEqual(migrated.futureServerField, { retained: true })

  const confirmed = confirmDraft(migrated, migrated.stateRevision)
  assert.strictEqual(confirmed.activePlan.id, nextPlan.id)
  assert.strictEqual(confirmed.planHistory[0].id, oldPlan.id)
  assert.deepStrictEqual(confirmed.mealOverrides, legacy.mealOverrides)
  assert.deepStrictEqual(confirmed.customReminders, legacy.customReminders)
  assert.deepStrictEqual(confirmed.settings, migrated.settings)
  assert.deepStrictEqual(confirmed.checkedShoppingIds, [], '新周期不得继承旧周期采购勾选')

  const restored = restoreHistory(confirmed, oldPlan.id, confirmed.stateRevision)
  assert.strictEqual(restored.activePlan.id, oldPlan.id)
  assert.deepStrictEqual(restored.mealOverrides, legacy.mealOverrides)
  assert.deepStrictEqual(restored.checkedShoppingIds, [oldShoppingId])
  assert.deepStrictEqual(restored.customReminders, legacy.customReminders)

  const plannerSource = fs.readFileSync(path.join(root, 'cloudfunctions', 'aiPlanner', 'index.js'), 'utf8')
  const userDataSource = fs.readFileSync(path.join(root, 'cloudfunctions', 'userData', 'index.js'), 'utf8')
  const healthSource = fs.readFileSync(path.join(root, 'cloudfunctions', 'health', 'index.js'), 'utf8')
  assert(healthSource.includes("collection('health_daily')"), '健康历史必须由独立集合持久化')
  assert(!plannerSource.includes('health_daily'), '生成后续周期不得读写健康历史集合')
  assert(!userDataSource.includes('health_daily'), '用户餐单 schema 迁移不得读写健康历史集合')
}

async function main() {
  const plans = await testAllMealCombinations()
  const finalCaseIndex = await testDurationExerciseAndDietIntentCrossProduct(69)
  assert(finalCaseIndex >= 87)
  const oldPlan = plans.find((plan) => plan.durationDays === 1)
  const nextPlan = [...plans].reverse().find((plan) => plan.durationDays === 14)
  assert(oldPlan && nextPlan)
  testMigrationAndLaterCyclePreservePersonalState(oldPlan, nextPlan)
  console.log('planner contract pipeline tests passed: 87 local end-to-end combinations')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
