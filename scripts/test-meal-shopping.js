'use strict'

// Fictional fixtures only. No cloud calls, identities or real meal records.
const assert = require('assert')
const path = require('path')
const { defaults, migrate, sanitizeState, restoreHistory } = require('../shared/user-state')
const shopping = require('../shared/meal-shopping')
const editor = require('../miniprogram/services/meal-editor')
const { shoppingView } = require('../miniprogram/services/plan-view')
const clone = value => JSON.parse(JSON.stringify(value))
const ingredient = (name, quantity, unit = 'g', category = '其他') => ({ name, quantity, unit, category })
const oats = quantity => ingredient('燕麦', quantity)
const eggs = quantity => ingredient('鸡蛋', quantity, '个')
function plan(id = 'fictional') {
  return {
    id, planVersion: 1, contractVersion: 1, source: 'ai', title: '虚构测试餐单', durationDays: 1,
    startDate: '2026-10-09', generatedAt: '2026-10-09T00:00:00.000Z',
    generationBasis: { mealTypes: ['breakfast', 'dinner'], doubleDinner: true }, rationale: ['测试'],
    days: [{ id: `${id}-day`, date: '2026-10-09', name: '第一天', short: '1', theme: '测试',
      exercise: { dayIndex: 0, planned: false }, meals: [
        { id: `${id}-breakfast`, type: 'breakfast', scenario: 'default', title: '早餐', ingredients: [oats(40), eggs(1)], method: '煮熟', tag: '' },
        { id: `${id}-rest`, type: 'dinner', scenario: 'rest', title: '晚餐', ingredients: [oats(60)], method: '煮熟', tag: '' },
        { id: `${id}-workout`, type: 'dinner', scenario: 'workout', title: '运动晚餐', ingredients: [oats(100)], method: '煮熟', tag: '' },
      ] }],
    shoppingGroups: [{ id: `${id}-group`, name: '其他', items: [
      { id: `${id}-oats`, name: '燕麦', amount: '200 g' }, { id: `${id}-eggs`, name: '鸡蛋', amount: '1 个' },
    ] }],
  }
}
function state() {
  const activePlan = plan()
  return migrate({ ...defaults(), activePlan, activePlanId: activePlan.id, checkedShoppingIds: ['fictional-oats', 'fictional-eggs'] })
}
function override(items, title = '自选早餐') {
  return { title, ingredients: editor.rowsText(items), ingredientItems: items, method: '煮熟', tag: '', updatedAt: '2026-10-09T00:00:00.000Z' }
}
function apply(base, value) {
  const mealOverrides = { ...base.mealOverrides }
  if (value === null) delete mealOverrides['fictional-breakfast']; else mealOverrides['fictional-breakfast'] = value
  return sanitizeState(shopping.reconcileChecks(base, { ...base, mealOverrides }))
}
const items = value => shoppingView(value.activePlan, value).groups.flatMap(group => group.items)

async function main() {
  const original = state(), snapshot = clone(original)
  assert.strictEqual(items(original)[0].quantity, 100, 'only selected rest dinner is counted')
  const changed = apply(original, override([oats(80), eggs(1)]))
  assert.strictEqual(items(changed)[0].quantity, 140)
  assert.deepStrictEqual(changed.checkedShoppingIds, ['fictional-eggs'])
  assert.deepStrictEqual(original, snapshot, 'projection must not mutate source state')
  assert.deepStrictEqual(changed.activePlan, original.activePlan, 'personal edits do not rewrite the base recipe')
  assert.strictEqual(items({ ...changed, dinnerModeByDay: { 'fictional-day': 'workout' } })[0].quantity, 180)

  const added = apply(original, override([oats(40), eggs(1), ingredient('西兰花', 150, 'g', '蔬菜')]))
  const addedItem = items(added).find(item => item.name === '西兰花')
  assert(addedItem.id.startsWith('personal-item-'))
  assert.deepStrictEqual(added.checkedShoppingIds, original.checkedShoppingIds)
  assert.strictEqual(items(migrate(added)).find(item => item.name === '西兰花').id, addedItem.id)
  const checked = sanitizeState({ ...added, checkedShoppingIds: [...added.checkedShoppingIds, addedItem.id] })
  assert(checked.checkedShoppingIds.includes(addedItem.id), 'new IDs survive cloud normalization')
  const restored = apply(checked, null)
  assert.deepStrictEqual(restored.checkedShoppingIds, original.checkedShoppingIds)
  assert(!items(restored).some(item => item.name === '西兰花'))
  const removed = apply(original, override([oats(40)]))
  assert.deepStrictEqual(removed.checkedShoppingIds, ['fictional-oats'])
  assert(!items(removed).some(item => item.name === '鸡蛋'))

  const renamed = apply(original, override([ingredient('小米', 40), eggs(1)]))
  assert.strictEqual(items(renamed).find(item => item.name === '燕麦').quantity, 60)
  assert.strictEqual(items(renamed).find(item => item.name === '小米').quantity, 40)
  assert.deepStrictEqual(renamed.checkedShoppingIds, ['fictional-eggs'])
  const differentUnits = apply(original, override([oats(40), ingredient('燕麦', 1, '袋'), eggs(1)]))
  assert.strictEqual(items(differentUnits).filter(item => item.name === '燕麦').length, 2, 'no unsafe unit conversion')
  const textOnly = { title: '只改名称', ingredients: '原文字说明', method: '煮熟', tag: '', updatedAt: '2026-10-09T00:00:00.000Z' }
  assert.deepStrictEqual(apply(original, textOnly).checkedShoppingIds, original.checkedShoppingIds)
  const sameTotals = apply(original, override([oats(20), oats(20), eggs(1)]))
  assert.deepStrictEqual(sameTotals.checkedShoppingIds, original.checkedShoppingIds)
  const alternate = shopping.reconcileChecks(original, { ...original, mealOverrides: { 'fictional-workout': override([oats(200)]) } })
  assert.deepStrictEqual(alternate.checkedShoppingIds, original.checkedShoppingIds, 'an unselected dinner must not reset current shopping marks')
  assert.strictEqual(items(alternate)[0].quantity, 100)
  assert.strictEqual(items({ ...alternate, dinnerModeByDay: { 'fictional-day': 'workout' } })[0].quantity, 240)
  for (const durationDays of [7, 14]) {
    const period = clone(original.activePlan)
    period.durationDays = durationDays
    period.days = Array.from({ length: durationDays }, (_, index) => ({ ...clone(period.days[0]),
      id: `fictional-day-${index}`, date: `2026-10-${String(9 + index).padStart(2, '0')}`,
      exercise: { dayIndex: index, planned: false }, meals: period.days[0].meals.map(meal => ({ ...clone(meal), id: index ? `${meal.id}-${index}` : meal.id })),
    }))
    const periodState = migrate({ ...original, activePlan: period })
    const edited = apply(periodState, override([oats(80), eggs(1)]))
    assert.strictEqual(items(edited)[0].quantity, durationDays * 100 + 40, `${durationDays}-day fixture aggregates only the changed meal`)
    assert.deepStrictEqual(edited.checkedShoppingIds, ['fictional-eggs'])
    assert.deepStrictEqual(edited.activePlan, periodState.activePlan)
  }

  const preview = editor.previewChange(original, 'fictional-breakfast', override([oats(80), eggs(1)]))
  assert.deepStrictEqual(preview.changes, [{ id: 'fictional-oats', name: '燕麦', before: '100 g', after: '140 g' }])
  assert.strictEqual(preview.checkedReset, 1)
  assert.deepStrictEqual(original, snapshot, 'preview is read-only')
  for (const quantity of [0, -1, 'bad', '1e3', '0.0001', '100001', '']) assert.throws(() => editor.cleanRows([oats(quantity)]))
  assert.throws(() => editor.cleanRows([]))
  assert.throws(() => sanitizeState({ ...original, mealOverrides: { 'fictional-breakfast': override([oats(0)]) } }))
  const rows = [oats(40), eggs(1)]
  const base = { title: '早餐', ingredients: editor.rowsText(rows), method: '煮熟', tag: '' }
  assert.strictEqual(editor.draftOverride(base, base, rows, rows, null, true), null)
  assert(!editor.draftOverride({ ...base, title: '新名称' }, base, rows, rows, textOnly, false).ingredientItems,
    'legacy text-only edits must not be silently replaced with guessed structured ingredients')

  const oldV8 = { ...checked, schemaVersion: 8, waterReminder: { ...defaults().waterReminder, enabled: true, cadence: 'weekdays', scheduleVersion: 3 }, customReminders: [{ id: 'fictional-reminder', text: '虚构提醒', done: true }] }
  const migrated = migrate(oldV8)
  assert.strictEqual(migrated.schemaVersion, 9)
  assert.deepStrictEqual(migrated.waterReminder, oldV8.waterReminder)
  assert.deepStrictEqual(migrated.customReminders, oldV8.customReminders)
  assert.deepStrictEqual(migrate(migrated), migrated, 'v8 to v9 migration is idempotent')
  const archived = sanitizeState({ ...checked, activePlan: plan('new'), activePlanId: 'new', planHistory: [checked.activePlan],
    checkedShoppingIds: [], planUiStateByPlan: { ...checked.planUiStateByPlan, fictional: { ...checked.planUiStateByPlan.fictional, checkedShoppingIds: checked.checkedShoppingIds } } })
  const reactivated = restoreHistory(archived, 'fictional', archived.stateRevision)
  assert(reactivated.checkedShoppingIds.includes(addedItem.id), 'history restoration retains new IDs and personal ingredient edits')
  assert.strictEqual(items(reactivated).find(item => item.name === '西兰花').quantity, 150)

  // Page interactions use mocked native APIs, not a claim of device testing.
  let definition, writes = 0, identityListener, initHook
  const member = { cacheNamespace: 'a'.repeat(32), init: async () => ({ status: 'active' }),
    onCacheNamespaceChange(callback) { identityListener = callback; return () => {} } }
  const store = { data: state(), state: 'ready', async init() { if (initHook) await initHook() },
    async setMealOverride(_id, value) { writes++; this.data = apply(this.data, value) } }
  for (const [name, value] of [['membership-store', { membershipStore: member }], ['user-store', { userStore: store }]]) {
    const filename = path.resolve(__dirname, `../miniprogram/services/${name}.js`)
    require.cache[filename] = { id: filename, filename, loaded: true, exports: value }
  }
  global.Page = page => { definition = page }
  global.wx = { showToast() {}, showModal(options) { return options.success({ confirm: true }) },
    switchTab() {}, reLaunch() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {} }
  require('../miniprogram/pages/meal-edit/meal-edit')
  const page = { ...definition, data: clone(definition.data), setData(patch, callback) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {})
      target[parts[parts.length - 1]] = value
    }
    if (callback) callback()
  } }
  await page.onLoad({ mealId: 'fictional-breakfast' })
  page.inputIngredient({ currentTarget: { dataset: { index: 0, field: 'quantity' } }, detail: { value: '80' } })
  await page.save()
  assert.strictEqual(writes, 0)
  assert.strictEqual(page.data.previewing, true)
  assert.strictEqual(page.data.previewResetCount, 1)
  page.cancelPreview()
  assert.strictEqual(writes, 0)
  await page.save()
  store.data.stateRevision++
  await page.confirmSave()
  assert.strictEqual(writes, 0, 'stale preview must be reconfirmed')
  await page.save()
  await page.confirmSave()
  assert.strictEqual(writes, 1)
  assert.strictEqual(items(store.data)[0].quantity, 140)
  page.onUnload()

  const stalePage = { ...page, data: clone(definition.data) }
  initHook = () => { member.cacheNamespace = 'b'.repeat(32); identityListener() }
  await stalePage.onLoad({ mealId: 'fictional-breakfast' })
  assert(stalePage.data.error.includes('账号已变化'))
  assert.deepStrictEqual(stalePage.data.ingredientRows, [])
  stalePage.onUnload()
  const firstPage = { ...page, data: clone(definition.data) }
  member.cacheNamespace = ''
  member.init = async () => { member.cacheNamespace = 'c'.repeat(32); identityListener(); return { status: 'active' } }
  initHook = null
  await firstPage.onLoad({ mealId: 'fictional-breakfast' })
  assert.strictEqual(firstPage.data.error, '', 'initial verified namespace binding is not an account switch')
  assert.strictEqual(firstPage.data.canSyncIngredients, true)
  firstPage.onUnload()
  console.log('meal ingredient/shopping projection, schema migration, history and page confirmation tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
