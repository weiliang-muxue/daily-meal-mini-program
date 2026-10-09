'use strict'

// Fictional, offline Page/Component interactions. Never connects to WeChat or AI.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const replacement = require('../shared/meal-replacement')
const view = require('../miniprogram/services/meal-replacement-view')
const schema = require('../shared/user-state')
const realAi = require('../miniprogram/services/ai-planner')
const clone = value => JSON.parse(JSON.stringify(value))
function fixture(days = 7) {
  const activePlan = {
    id: 'test-plan', source: 'ai', title: '虚构餐单', planVersion: 1, contractVersion: 2,
    durationDays: days, startDate: '2026-10-09', generatedAt: '2026-10-09T00:00:00.000Z',
    generationBasis: { mealTypes: ['breakfast', 'dinner'], doubleDinner: true },
    days: Array.from({ length: days }, (_, index) => ({
      id: `day-${index}`, date: `2026-10-${String(index + 9).padStart(2, '0')}`,
      exercise: { planned: true, type: '虚构步行', durationMinutes: 30, intensity: 'low' },
      meals: ['breakfast', 'rest', 'workout'].map(kind => ({
        id: `${index}-${kind}`, title: `虚构${kind}`, type: kind === 'breakfast' ? kind : 'dinner',
        scenario: kind === 'breakfast' ? 'default' : kind, method: '煮熟', tag: '测试',
        ingredients: [{ name: kind === 'breakfast' ? '鸡蛋' : '燕麦', quantity: kind === 'breakfast' ? 1 : kind === 'rest' ? 60 : 100,
          unit: kind === 'breakfast' ? '个' : 'g', category: '其他' }],
      })),
    })),
    shoppingGroups: [{ id: 'group', name: '其他', items: [
      { id: 'eggs', name: '鸡蛋', amount: `${days} 个` }, { id: 'oats', name: '燕麦', amount: `${days * 100} g` },
    ] }],
  }
  return schema.sanitizeState({ ...schema.defaults(), activePlan, stateRevision: 7, checkedShoppingIds: ['eggs', 'oats'],
    generationPreferences: { durationDays: 14, startDate: '2026-10-12', mealTypes: ['breakfast', 'lunch', 'dinner'],
      doubleDinner: true, goals: ['均衡饮食'], styles: ['清淡低油'], restrictions: '虚构忌口' },
  })
}
function draft(state, mealId = '0-rest', dinnerMode = 'rest') {
  const target = replacement.createTarget(state, mealId, { dinnerMode })
  const result = clone(fixture(1).activePlan)
  result.id = 'candidate'
  result.replacementTarget = target
  result.days[0].exercise.planned = (dinnerMode || target.originalDinnerMode) === 'workout'
  const source = state.activePlan.days[0].meals.find(meal => meal.id === mealId)
  result.days[0].meals = [{ ...clone(source), id: 'new-meal', scenario: 'default', title: '虚构新餐',
    ingredients: [{ name: '燕麦', quantity: 80, unit: 'g', category: '其他' }] }]
  result.generationBasis = { mealTypes: [source.type], doubleDinner: false }
  return result
}

const calls = { start: [], patch: [], confirm: [], discard: [], navigate: [], toast: [], modal: [] }
let startImpl, flushImpl, requestIdImpl, confirmImpl, currentTask
const store = { state: 'ready', namespace: 'fictional-account', data: fixture(), error: '',
  async init() { return this.data },
  async patch(...args) { calls.patch.push(args); return this.data },
  async flush() { return flushImpl() },
  async confirmDraft(...args) { calls.confirm.push(['whole', ...args]) },
  async confirmMealReplacement(...args) { calls.confirm.push(['meal', ...args]); return confirmImpl(...args) },
  async discardDraft(...args) { calls.discard.push(args); this.data = { ...this.data, draftPlan: null } },
}
const ai = { ...realAi, createClientRequestId: () => requestIdImpl(), aiPlanner: {
  async status() { return { configured: true, storageReady: true, contractVersion: realAi.CONTRACT_VERSION,
    plannerVersion: realAi.PLANNER_VERSION, aiDataConsentVersion: realAi.AI_DATA_CONSENT_VERSION,
    providerContractRevision: realAi.PROVIDER_CONTRACT_REVISION, providerRevision: 1, providerDisplayName: '测试服务' } },
  loadCachedTask: () => null, clearCachedTask() {}, recentFailure: async () => null,
  currentTask: async () => currentTask,
  start: async (...args) => { calls.start.push(args); return startImpl(...args) },
} }
function mockService(name, exports) {
  const filename = path.join(root, 'miniprogram/services', name + '.js')
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}
mockService('membership-store', { membershipStore: { init: async () => ({ status: 'active' }) } })
mockService('user-store', { userStore: store })
mockService('auth-store', { authStore: { init: async () => ({}) } })
mockService('ai-planner', ai)
let modalResponse = true
global.wx = {
  navigateTo: value => calls.navigate.push(value), redirectTo: value => calls.navigate.push(value),
  switchTab: value => calls.navigate.push(value), reLaunch: value => calls.navigate.push(value),
  showToast: value => calls.toast.push(value),
  showModal: value => { calls.modal.push(value); if (value.success) value.success({ confirm: modalResponse }) },
  pageScrollTo() {}, stopPullDownRefresh() {},
}
function page(name) {
  let definition
  global.Page = value => { definition = value }
  const filename = path.join(root, `miniprogram/pages/${name}/${name}.js`)
  delete require.cache[filename]; require(filename)
  return { ...definition, data: clone(definition.data), pageActive: true, taskLoopToken: 0,
    setData(value) { Object.assign(this.data, value) } }
}
function reset() {
  Object.values(calls).forEach(list => { list.length = 0 })
  store.data = fixture(); store.state = 'ready'; store.namespace = 'fictional-account'
  flushImpl = async () => store.data; requestIdImpl = async () => 'request-test-single'
  startImpl = async () => { throw new Error('模拟断网') }
  confirmImpl = async (id, revision) => {
    assert.strictEqual(id, store.data.draftPlan.id)
    store.data = schema.confirmMealReplacement(store.data, revision)
    return store.data
  }
  currentTask = null; modalResponse = true
}
async function planner(scope = { planId: 'test-plan', mealId: '0-rest', dinnerMode: 'rest' }) {
  const result = page('planner'); result.replacementScope = scope
  await result.connect()
  return result
}
async function main() {
  // Route and view-model guardrails; 14-day plans must not collapse to a day.
  assert.strictEqual(view.routeScope({}), null)
  for (const options of [{ mealId: 'one' }, { planId: 'one' }, { planId: 'one', mealId: 'two', dinnerMode: 'other' }]) {
    assert.throws(() => view.routeScope(options))
  }
  for (const days of [1, 7, 14]) {
    const state = fixture(days); state.draftPlan = draft(state)
    const before = clone(state), result = view.preview(state, state.draftPlan)
    assert.deepStrictEqual(state, before, 'preview is read-only')
    assert.strictEqual(result.original.title, '虚构workout')
    assert.strictEqual(result.candidate.title, '虚构新餐')
    assert(result.targetMealTitle.includes('rest'))
    assert(result.modeNote.includes('不会改动运动打卡'))
    assert.strictEqual(result.checkedReset, 1)
    assert.deepStrictEqual(result.changes.map(i => [i.name, i.before, i.after]), [['燕麦', `${days * 100} g`, `${days * 100 - 20} g`]])
  }
  reset()
  const planPage = page('plan'); planPage.render()
  const untouched = clone(store.data)
  planPage.replaceMeal({ detail: { mealId: '0-workout' } })
  assert(calls.navigate.at(-1).url.includes('mealId=0-workout'))
  planPage.replaceRestDinner()
  assert(calls.navigate.at(-1).url.includes('mealId=0-rest&dinnerMode=rest'))
  assert.deepStrictEqual(store.data, untouched)
  store.data.draftPlan = draft(store.data); planPage.render()
  assert.strictEqual(planPage.data.hasMealDraft, true)
  planPage.replaceMeal({ detail: { mealId: '0-workout' } })
  assert.strictEqual(calls.navigate.at(-1).url, '/pages/plan-preview/plan-preview')

  // Single-meal conditions cannot broaden scope or autosave over global choices.
  reset()
  const single = await planner(), preferencesBefore = clone(store.data.generationPreferences)
  assert.strictEqual(single.data.currentStep, 2)
  assert.strictEqual(single.data.stepCount, 4)
  assert.strictEqual(single.data.stepNumber, 1)
  assert.strictEqual(single.data.aiDataConsentAccepted, false)
  single.goBack(); single.goToStep({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(single.data.currentStep, 2)
  single.updatePreferences({ durationDays: 14, mealTypes: ['lunch'], startDate: '2026-11-01', doubleDinner: true, customGoal: '虚构想吃的菜' })
  assert.strictEqual(single.data.preferences.durationDays, 1)
  assert.deepStrictEqual(single.data.preferences.mealTypes, ['dinner'])
  assert.strictEqual(single.data.preferences.startDate, '2026-10-09')
  assert.strictEqual(single.data.preferences.doubleDinner, false)
  single.onExerciseIntentChange({ detail: { value: 'daily' } })
  assert.strictEqual(single.data.preferences.exerciseIntent, 'none')
  single.updatePreferences({ exerciseNotes: '旧的训练说明不应发送' })
  assert.strictEqual(single.data.preferences.exerciseNotes, '', 'unshown exercise notes cannot contradict the rest-dinner request')
  await single.flushPreferenceDraft()
  assert.deepStrictEqual(calls.patch, [])
  assert.deepStrictEqual(store.data.generationPreferences, preferencesBefore)
  await single.generatePlan(); assert.strictEqual(calls.start.length, 0, 'explicit consent required')
  single.data.aiDataConsentAccepted = true
  await single.generatePlan()
  assert.strictEqual(calls.start.length, 1)
  assert.deepStrictEqual(calls.start[0][5], { planId: 'test-plan', mealId: '0-rest', dinnerMode: 'rest' })
  assert(!Object.prototype.hasOwnProperty.call(calls.start[0][0], 'replacementTarget'))
  await single.retryTask()
  assert.deepStrictEqual(calls.start[1], calls.start[0], 'ambiguous start retry keeps scope, consent and request ID')
  assert.deepStrictEqual(store.data.generationPreferences, preferencesBefore)
  single.editConditions(); assert.strictEqual(single.data.currentStep, 2)
  single.onHide()

  reset()
  const breakfast = await planner({ planId: 'test-plan', mealId: '0-breakfast' })
  breakfast.onExerciseIntentChange({ detail: { value: 'none' } })
  breakfast.onExerciseIntentChange({ detail: { value: 'daily' } })
  assert.strictEqual(breakfast.data.preferences.exerciseIntent, 'daily')
  breakfast.toggleExercise({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(breakfast.data.preferences.exerciseByDay[0].planned, true)
  breakfast.onHide()

  for (const effect of ['stale', 'identity', 'hidden', 'offline']) {
    reset(); const testPage = await planner(); testPage.data.aiDataConsentAccepted = true
    flushImpl = async () => {
      if (effect === 'stale') store.data.mealOverrides['0-rest'] = { title: '另一设备修改' }
      if (effect === 'identity') store.namespace = 'another-fictional-account'
      if (effect === 'hidden') testPage.onHide()
      if (effect === 'offline') store.state = 'offline'
      return store.data
    }
    await testPage.generatePlan()
    assert.strictEqual(calls.start.length, 0, `${effect} during flush blocks AI request`)
    testPage.onHide()
  }
  reset(); const switched = await planner(); switched.data.aiDataConsentAccepted = true
  requestIdImpl = async () => { store.namespace = 'different-test-user'; return 'unused' }
  await switched.generatePlan(); assert.strictEqual(calls.start.length, 0)
  switched.onHide()

  reset(); const invalid = await planner({ planId: 'old-plan', mealId: '0-rest' })
  assert(invalid.data.pageError); assert.strictEqual(invalid.data.aiStatus, 'error')
  await invalid.generatePlan(); assert.strictEqual(calls.start.length, 0)
  invalid.onHide()

  // Recovered single-meal tasks remain single-meal tasks even from the ordinary planner.
  reset()
  const recovered = await planner(null)
  const completed = { task: { taskId: 'recovered-single', taskRevision: 3, status: 'succeeded', purpose: 'meal',
    contractVersion: realAi.CONTRACT_VERSION, plannerVersion: realAi.PLANNER_VERSION,
    progressPercent: 100, phase: 'completed' }, draftPlan: draft(store.data) }
  store.data.draftPlan = completed.draftPlan
  await recovered.applyTaskResponse(completed)
  assert.strictEqual(calls.navigate.at(-1).url, '/pages/plan-preview/plan-preview')
  assert.strictEqual(calls.start.length, 0, 'recovery must not issue another AI request')
  recovered.renderTask({ ...completed.task, status: 'failed', errorCode: 'AI_TIMEOUT' })
  assert.strictEqual(recovered.data.taskCanEdit, false)
  assert.strictEqual(recovered.data.taskCanRetry, false)
  assert.strictEqual(recovered.data.taskCanReturn, true)
  await recovered.retryTask()
  assert.strictEqual(calls.navigate.at(-1).url, '/pages/plan/plan')
  recovered.onHide()

  reset(); store.data.draftPlan = draft(store.data)
  const existing = await planner(); await existing.generatePlan()
  assert.strictEqual(calls.start.length, 0)
  assert.strictEqual(calls.navigate.at(-1).url, '/pages/plan-preview/plan-preview'); existing.onHide()

  // Candidate confirmation uses the exact revision shown, not a whole-plan API.
  reset(); store.data.draftPlan = draft(store.data)
  let preview = page('plan-preview'); preview.render()
  assert(preview.data.plan.basisRows.some(row => row.label === '不喜欢 · 尽量少用' && row.value === '本餐单未记录此项'))
  store.data.draftPlan.generationBasis.dislikes = '不喜欢苦瓜'
  preview.render()
  assert(preview.data.plan.basisRows.some(row => row.label === '不喜欢 · 尽量少用' && row.value === '不喜欢苦瓜'))
  assert(preview.data.replacementPreview)
  assert(!preview.data.plan.replacementTarget, 'private source snapshot is not sent to WXML')
  const basePlan = clone(store.data.activePlan), originalPreferences = clone(store.data.generationPreferences)
  await Promise.all([preview.confirmPlan(), preview.confirmPlan()])
  assert.deepStrictEqual(calls.confirm, [['meal', 'candidate', 7]])
  assert.deepStrictEqual(store.data.activePlan, basePlan)
  assert.deepStrictEqual(store.data.generationPreferences, originalPreferences)
  assert.strictEqual(store.data.mealOverrides['0-rest'].title, '虚构新餐')
  preview.onHide()

  reset(); store.data.draftPlan = draft(store.data)
  preview = page('plan-preview'); preview.render()
  store.data.stateRevision += 1
  const staleBefore = clone(store.data)
  await preview.confirmPlan()
  assert.deepStrictEqual(store.data, staleBefore, 'stale preview must not overwrite newer state')
  assert(calls.modal.at(-1).content.includes('重新载入'))
  assert.strictEqual(calls.confirm.length, 1)
  preview.onHide()

  for (const effect of ['stale', 'identity', 'offline', 'saving', 'error']) {
    reset(); store.data.draftPlan = draft(store.data)
    preview = page('plan-preview')
    if (effect === 'stale') store.data.mealOverrides['0-rest'] = { title: '新的个人调整' }
    if (effect === 'offline') store.state = 'offline'
    if (['saving', 'error'].includes(effect)) store.state = effect
    preview.render()
    if (effect === 'identity') store.namespace = 'other-test-user'
    await preview.confirmPlan()
    assert.strictEqual(calls.confirm.length, 0, `${effect} blocks confirmation`)
    preview.onHide()
  }
  reset(); store.data.draftPlan = draft(store.data)
  preview = page('plan-preview'); preview.render()
  const beforeDiscard = clone(store.data.activePlan)
  modalResponse = false; await preview.discardPlan(); assert.strictEqual(calls.discard.length, 0)
  modalResponse = true; await Promise.all([preview.discardPlan(), preview.discardPlan()])
  assert.deepStrictEqual(calls.discard, [['candidate']])
  assert.deepStrictEqual(store.data.activePlan, beforeDiscard)
  assert.strictEqual(preview.data.viewState, 'no-draft'); preview.onHide()

  reset(); store.data.draftPlan = draft(store.data)
  preview = page('plan-preview'); preview.render()
  confirmImpl = async () => { store.namespace = 'other-test-user' }
  await preview.confirmPlan(); assert.strictEqual(calls.toast.length, 0); preview.onHide()

  // Existing whole-plan confirmation remains a separate path.
  reset(); store.data.draftPlan = fixture(1).activePlan
  preview = page('plan-preview'); preview.render(); await preview.confirmPlan()
  assert.strictEqual(calls.confirm[0][0], 'whole'); preview.onHide()

  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/plan-preview/plan-preview.wxml'), 'utf8')
  assert(markup.includes('确认，只替换这一餐') && markup.includes('采购会怎样变化'))
  assert(markup.includes('busyAction || offline || replacementError'))
  assert(!markup.includes('<web-view'))
  console.log('single-meal page tests passed: scope, preview, purchase, consent, failure, stale revision, identity, lifecycle and whole-plan regression')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
