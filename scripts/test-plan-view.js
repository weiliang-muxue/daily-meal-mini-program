const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildPlanView, selectDay } = require('../miniprogram/services/plan-view')

function meal(type, scenario, id) {
  return { type, scenario, id, title: `${type}-${scenario}`, ingredients: 'one', method: 'cook' }
}

function makePlan(days, meals = [meal('snack', 'default', 'snack-1')], source = 'ai') {
  return {
    id: 'ai-plan-1', source, title: `${days.length} day plan`, durationDays: days.length, planVersion: 2,
    days: days.map((day, index) => ({ id: `day-${index + 1}`, date: `2026-08-${String(index + 1).padStart(2, '0')}`, name: `Day ${index + 1}`, meals: typeof meals === 'function' ? meals(index) : meals })),
    shoppingGroups: [{ id: 'produce', name: 'Produce', items: [{ id: 'apple', name: 'Apple', amount: '2' }, { id: 'old', name: 'Old', amount: '1' }] }],
  }
}

function ingredient(name, quantity, unit, category) {
  return { name, quantity, unit, category }
}

function structuredMeal(type, scenario, id, ingredients) {
  return { type, scenario, id, title: id, ingredients, method: 'cook' }
}

function dinnerShoppingPlan() {
  const tofu = (quantity) => ingredient('豆腐', quantity, 'g', '豆制品')
  return {
    id: 'dinner-shopping-plan', source: 'ai', title: 'Dinner shopping', durationDays: 2, planVersion: 1,
    days: [
      {
        id: 'dinner-day-1', date: '2026-08-01', name: 'Day 1',
        exercise: { dayIndex: 0, planned: false, type: '', durationMinutes: 0 },
        meals: [
          structuredMeal('breakfast', 'default', 'day-1-breakfast', [tofu(20), ingredient('大米', 50, 'g', '谷薯')]),
          structuredMeal('dinner', 'rest', 'day-1-rest', [tofu(100), ingredient('西兰花', 100, 'g', '蔬菜')]),
          structuredMeal('dinner', 'workout', 'day-1-workout', [tofu(200), ingredient('牛肉', 200, 'g', '肉类')]),
        ],
      },
      {
        id: 'dinner-day-2', date: '2026-08-02', name: 'Day 2',
        exercise: { dayIndex: 1, planned: false, type: '', durationMinutes: 0 },
        meals: [
          structuredMeal('breakfast', 'default', 'day-2-breakfast', [tofu(20), ingredient('大米', 50, 'g', '谷薯')]),
          structuredMeal('dinner', 'rest', 'day-2-rest', [tofu(300), ingredient('菌菇', 100, 'g', '蔬菜')]),
          structuredMeal('dinner', 'workout', 'day-2-workout', [tofu(400), ingredient('鸡肉', 200, 'g', '肉类')]),
        ],
      },
    ],
    shoppingGroups: [
      { id: 'soy', name: '豆制品', items: [{ id: 'tofu', name: '豆腐', amount: '1040 g' }] },
      { id: 'vegetables', name: '蔬菜', items: [
        { id: 'broccoli', name: '西兰花', amount: '100 g' },
        { id: 'mushroom', name: '菌菇', amount: '100 g' },
      ] },
      { id: 'staple', name: '谷薯', items: [{ id: 'rice', name: '大米', amount: '100 g' }] },
      { id: 'meat', name: '肉类', items: [
        { id: 'beef', name: '牛肉', amount: '200 g' },
        { id: 'chicken', name: '鸡肉', amount: '200 g' },
      ] },
    ],
  }
}

// A plan with only snacks is still a valid dynamic plan.
let view = buildPlanView(makePlan([{ id: 'day-1' }]))
assert.strictEqual(view.hasPlan, true)
assert.strictEqual(view.mealSummary.total, 1)
assert.strictEqual(view.mealSummary.counts.snack, 1)
assert.strictEqual(view.canSwitchDay, false)

// Any selected combination of breakfast/lunch/dinner is rendered.
view = buildPlanView(makePlan([{ id: 'day-1' }], [meal('breakfast', 'default', 'b'), meal('lunch', 'default', 'l'), meal('dinner', 'default', 'd')]))
assert.deepStrictEqual(view.selectedDay.meals.map((item) => item.type), ['breakfast', 'lunch', 'dinner'])
assert.strictEqual(view.mealSummary.total, 3)

// Rest/workout dinner alternatives collapse to one selected scenario.
const doubleDinner = makePlan([{ id: 'day-1' }], [
  meal('breakfast', 'default', 'b'), meal('dinner', 'rest', 'dr'), meal('dinner', 'workout', 'dw'), meal('dinner', 'default', 'dd'), meal('snack', 'default', 's'),
])
doubleDinner.days[0].exercise = { dayIndex: 0, planned: false, type: '', durationMinutes: 0 }
view = buildPlanView(doubleDinner, { defaultDinnerMode: 'workout' })
assert.deepStrictEqual(view.selectedDay.meals.map((item) => item.id), ['b', 'dr', 'dd', 's'])
assert.strictEqual(view.selectedDay.hasDinnerAlternatives, true)
view = buildPlanView(doubleDinner, { defaultDinnerMode: 'rest', dinnerModeByDay: { 'day-1': 'workout' } })
assert.strictEqual(view.selectedDay.meals.find((item) => item.type === 'dinner' && item.scenario !== 'default').id, 'dw')

// Shopping derives from each day's selected dinner, while retaining stable full-plan item IDs.
const dinnerPlan = dinnerShoppingPlan()
view = buildPlanView(dinnerPlan, {
  dinnerModeByDay: { 'dinner-day-1': 'rest', 'dinner-day-2': 'workout' },
  checkedShoppingIds: ['tofu', 'broccoli', 'mushroom', 'chicken', 'not-current'],
})
let shoppingItems = view.shopping.groups.flatMap((group) => group.items)
assert.deepStrictEqual(shoppingItems.map((item) => item.itemId), ['tofu', 'broccoli', 'rice', 'chicken'])
assert.strictEqual(shoppingItems.find((item) => item.itemId === 'tofu').quantity, 540)
assert.strictEqual(shoppingItems.find((item) => item.itemId === 'tofu').amount, '540 g')
assert.deepStrictEqual(view.shopping.checkedIds, ['tofu', 'broccoli', 'chicken'])

view = buildPlanView(dinnerPlan, {
  dinnerModeByDay: { 'dinner-day-1': 'workout', 'dinner-day-2': 'workout' },
  checkedShoppingIds: ['tofu', 'broccoli', 'chicken'],
})
shoppingItems = view.shopping.groups.flatMap((group) => group.items)
assert.deepStrictEqual(shoppingItems.map((item) => item.itemId), ['tofu', 'rice', 'beef', 'chicken'])
assert.strictEqual(shoppingItems.find((item) => item.itemId === 'tofu').quantity, 640)
assert.deepStrictEqual(view.shopping.checkedIds, ['tofu', 'chicken'])

// Per-day exercise metadata beats the stale global preference; a manual day choice beats both.
doubleDinner.days[0].exercise = { dayIndex: 0, planned: true, type: '快走', durationMinutes: 30 }
view = buildPlanView(doubleDinner, { defaultDinnerMode: 'rest' })
assert.strictEqual(view.selectedDay.dinnerMode, 'workout')
view = buildPlanView(doubleDinner, { defaultDinnerMode: 'rest', dinnerModeByDay: { 'day-1': 'rest' } })
assert.strictEqual(view.selectedDay.dinnerMode, 'rest')

// Only a migrated legacy plan without real exercise metadata uses the global fallback.
const legacyDoubleDinner = makePlan([{ id: 'day-1' }], doubleDinner.days[0].meals, 'legacy')
legacyDoubleDinner.days[0].exercise = { dayIndex: 0, planned: false, type: '', durationMinutes: 0 }
legacyDoubleDinner.generationBasis = { exerciseByDay: [] }
view = buildPlanView(legacyDoubleDinner, { defaultDinnerMode: 'workout' })
assert.strictEqual(view.selectedDay.dinnerMode, 'workout')
legacyDoubleDinner.generationBasis.exerciseByDay = [{ dayIndex: 0, planned: false }]
view = buildPlanView(legacyDoubleDinner, { defaultDinnerMode: 'workout' })
assert.strictEqual(view.selectedDay.dinnerMode, 'rest')

// Day selection uses stable IDs, including a 14-day plan.
view = buildPlanView(makePlan(Array.from({ length: 14 }, () => ({})), (index) => [meal('lunch', 'default', `l-${index + 1}`)]), { selectedDay: 0 }, { dayId: 'day-14' })
assert.strictEqual(view.durationDays, 14)
assert.strictEqual(view.selectedDayId, 'day-14')
assert.strictEqual(view.selectedDayIndex, 13)
assert.strictEqual(view.canSwitch, true)
assert.strictEqual(view.dateRange.endDate, '2026-08-14')
assert.strictEqual(view.mealSummary.total, 14)
assert.strictEqual(selectDay(view.plan, {}, 'day-2').selectedDayId, 'day-2')

// Stable fallback IDs are deterministic, and selected shopping IDs intersect the current plan only.
const noMealIdPlan = makePlan([{ id: 'day-1' }], [{ type: 'snack', title: 'x', ingredients: 'y', method: 'z' }])
const first = buildPlanView(noMealIdPlan, { checkedShoppingIds: ['apple', 'old', 'not-current'] })
const second = buildPlanView(noMealIdPlan, { checkedShoppingIds: ['apple'] })
assert.strictEqual(first.selectedDay.meals[0].mealId, second.selectedDay.meals[0].mealId)
assert.strictEqual(first.shopping.checkedCount, 2)
assert.strictEqual(first.shopping.totalCount, 2)
assert.deepStrictEqual(first.shopping.checkedIds, ['apple', 'old'])
assert.strictEqual(first.shopping.groups[0].checkedCount, 2)
assert.strictEqual(second.shopping.checkedCount, 1)

// Personal edits are a display-only layer. Structured source ingredients and shopping stay unchanged.
view = buildPlanView(makePlan([{ id: 'day-1' }], [{
  id: 'lunch-1', type: 'lunch', scenario: 'default', title: 'Source title',
  ingredients: [{ name: 'Rice', quantity: 100, unit: 'g', category: 'staple' }],
  method: 'Source method', tag: 'Source tag',
}]), {
  mealOverrides: {
    'lunch-1': { title: 'My title', ingredients: 'My display note', method: 'My method', tag: 'My tag' },
  },
})
assert.strictEqual(view.selectedDay.meals[0].title, 'My title')
assert.strictEqual(view.selectedDay.meals[0].ingredients, 'My display note')
assert.strictEqual(view.selectedDay.meals[0].ingredientItems[0].name, 'Rice')
assert.strictEqual(view.selectedDay.meals[0].personalized, true)
assert.strictEqual(view.shopping.groups[0].items[0].name, 'Apple')

// History is summarized and a missing plan stays empty instead of falling back to static content.
view = buildPlanView(null, { planHistory: [{ id: 'old-plan', title: 'Old', durationDays: 7, planVersion: 1, source: 'ai', generatedAt: '2026-01-01' }] })
assert.strictEqual(view.hasPlan, false)
assert.deepStrictEqual(view.days, [])
assert.strictEqual(view.history[0].id, 'old-plan')
assert.strictEqual(view.shopping.totalCount, 0)

async function testPlanPageRecovery() {
  const root = path.resolve(__dirname, '..')
  const pagePath = path.join(root, 'miniprogram', 'pages', 'plan', 'plan.js')
  const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
  const authStorePath = path.join(root, 'miniprogram', 'services', 'auth-store.js')
  const membershipStorePath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
  const formatPath = path.join(root, 'miniprogram', 'utils', 'date.js')
  const mealCardPath = path.join(root, 'miniprogram', 'components', 'meal-card', 'meal-card.js')
  const namespace = 'a'.repeat(32)
  const eventOrder = []
  const navigationUrls = []
  const patchCalls = []
  const restoredPlan = makePlan(Array.from({ length: 14 }, () => ({})), (index) => [meal('lunch', 'default', `meal-${index}`)])
  const membershipStore = {
    cacheNamespace: '',
    async init() {
      eventOrder.push('membership')
      this.cacheNamespace = namespace
      return { status: 'active', cacheNamespace: namespace }
    },
  }
  const authStore = {
    async init() {
      eventOrder.push('auth')
      throw new Error('auth.login unavailable')
    },
  }
  const userStore = {
    state: 'offline', error: 'cloud unavailable',
    data: { activePlan: restoredPlan, selectedDay: 10, selectedDayId: 'day-11', draftPlan: null, updatedAt: null },
    async init() {
      assert.strictEqual(membershipStore.cacheNamespace, namespace, 'user cache must load only after membership establishes its namespace')
      eventOrder.push('userData')
      return this.data
    },
    patch(partial) { patchCalls.push(partial); this.data = { ...this.data, ...partial }; return Promise.resolve(this.data) },
    flush() { return Promise.resolve(this.data) },
  }

  require.cache[userStorePath] = { id: userStorePath, filename: userStorePath, loaded: true, exports: { userStore } }
  require.cache[authStorePath] = { id: authStorePath, filename: authStorePath, loaded: true, exports: { authStore } }
  require.cache[membershipStorePath] = { id: membershipStorePath, filename: membershipStorePath, loaded: true, exports: { membershipStore } }
  delete require.cache[formatPath]
  let definition
  global.Page = (value) => { definition = value }
  global.wx = {
    reLaunch() {},
    stopPullDownRefresh() {},
    navigateTo({ url }) { navigationUrls.push(url) },
  }
  delete require.cache[pagePath]
  require(pagePath)
  const page = Object.create(definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = (partial) => Object.assign(page.data, partial)
  await page.loadData()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepStrictEqual(eventOrder.slice(0, 1), ['membership'])
  assert(eventOrder.includes('auth'), 'profile refresh should still be attempted in the background')
  assert(eventOrder.includes('userData'), 'auth.login failure must not block namespaced plan-cache recovery')
  assert.strictEqual(page.data.hasPlan, true)
  assert.strictEqual(page.data.offline, true)
  assert.strictEqual(page.data.selectedDayIndex, 10)
  assert.strictEqual(page.data.weeks.length, 2)
  assert.strictEqual(page.data.selectedWeekIndex, 1)
  assert.strictEqual(page.data.selectedWeekLabel, '第2周')
  assert.strictEqual(page.data.displayedDays.length, 7)
  assert.strictEqual(page.data.displayedDays[0].originalIndex, 7)
  assert.strictEqual(page.data.displayedDays[3].selected, true)
  assert.strictEqual(page.data.error, '')
  assert.strictEqual(page.data.syncState, 'offline')
  assert.strictEqual(page.data.syncText, '尚未同步，修改已安全保存')
  const oneWeek = page.buildWeeks(page.data.days.slice(0, 7))
  assert.strictEqual(oneWeek.length, 1)
  assert.strictEqual(oneWeek[0].label, '第1周')
  assert.strictEqual(oneWeek[0].days.length, 7)

  page.selectWeek({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(userStore.data.selectedDay, 0)
  assert.strictEqual(userStore.data.selectedDayId, 'day-1')
  assert.strictEqual(page.data.selectedWeekIndex, 0)
  assert.strictEqual(page.data.displayedDays[0].name, 'Day 1')

  page.selectDay({ currentTarget: { dataset: { index: 4 } } })
  page.selectWeek({ currentTarget: { dataset: { index: 1 } } })
  page.selectWeek({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(userStore.data.selectedDay, 4, 'returning to a week restores its last selected day')
  assert.strictEqual(userStore.data.selectedDayId, 'day-5')

  userStore.state = 'saving'
  page.render()
  assert.strictEqual(page.data.syncState, 'saving')
  assert.strictEqual(page.data.syncText, '正在保存你的选择…')
  userStore.state = 'ready'
  userStore.data.updatedAt = '2026-08-28T12:00:00.000Z'
  page.render()
  assert.strictEqual(page.data.syncState, 'ready')
  assert(page.data.syncText.startsWith('更新于 '))

  const switchingPlan = dinnerShoppingPlan()
  userStore.data = {
    ...userStore.data,
    activePlan: switchingPlan,
    activePlanId: switchingPlan.id,
    selectedDay: 0,
    selectedDayId: 'dinner-day-1',
    dinnerModeByDay: { 'dinner-day-1': 'rest', 'dinner-day-2': 'workout' },
    checkedShoppingIds: ['tofu', 'broccoli', 'chicken'],
  }
  page.render()
  patchCalls.length = 0
  page.selectDinnerMode({ currentTarget: { dataset: { mode: 'workout' } } })
  assert.strictEqual(patchCalls.length, 1, '晚餐模式和采购勾选必须在同一次状态更新中保存')
  assert.deepStrictEqual(patchCalls[0], {
    dinnerModeByDay: { 'dinner-day-1': 'workout', 'dinner-day-2': 'workout' },
    checkedShoppingIds: ['tofu', 'chicken'],
  })

  userStore.state = 'offline'
  userStore.error = 'network unavailable'
  userStore.patch = (partial) => {
    patchCalls.push(partial)
    userStore.data = { ...userStore.data, ...partial }
    return Promise.reject(new Error('network unavailable'))
  }
  page.selectDinnerMode({ currentTarget: { dataset: { mode: 'rest' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(page.data.selectedDay.dinnerMode, 'rest', '同步失败后仍须显示用户刚选择的晚餐')
  assert.strictEqual(userStore.data.dinnerModeByDay['dinner-day-1'], 'rest', '同步失败后本机状态不得回滚')
  assert.strictEqual(page.data.syncText, '已保存在本机，联网后重试')
  assert.strictEqual(page.data.syncState, 'offline')

  userStore.state = 'ready'
  userStore.error = ''
  userStore.patch = (partial) => {
    patchCalls.push(partial)
    userStore.data = { ...userStore.data, ...partial }
    return Promise.resolve(userStore.data)
  }
  page.selectDinnerMode({ currentTarget: { dataset: { mode: 'workout' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(page.data.localSaveNotice, '', '后续云同步成功必须清除本机提示')
  assert.notStrictEqual(page.data.syncText, '已保存在本机，联网后重试')

  let componentDefinition
  global.Component = (value) => { componentDefinition = value }
  delete require.cache[mealCardPath]
  require(mealCardPath)
  assert(componentDefinition, 'meal-card.js must register Component')
  const emitMealEdit = (meal) => {
    let emitted
    componentDefinition.methods.edit.call({
      properties: { meal },
      triggerEvent(name, detail) { emitted = { name, detail } },
    })
    return emitted
  }

  const detailMealId = 'detail meal/id ?&中文'
  const detailEvent = emitMealEdit({ mealId: detailMealId, id: 'legacy-id' })
  assert.deepStrictEqual(detailEvent, { name: 'edit', detail: { mealId: detailMealId } },
    'meal-card must emit the canonical mealId in edit event detail')
  page.editMeal({ detail: detailEvent.detail, currentTarget: { dataset: { id: 'stale-dataset-id' } } })
  assert.strictEqual(navigationUrls.at(-1), `/pages/meal-edit/meal-edit?mealId=${encodeURIComponent(detailMealId)}`,
    'plan page must prefer and URL-encode the mealId from event detail')

  const legacyMealId = 'legacy meal/id ?&中文'
  assert.deepStrictEqual(emitMealEdit({ id: legacyMealId }), { name: 'edit', detail: { mealId: legacyMealId } },
    'meal-card must support legacy meals that only expose id')
  assert.deepStrictEqual(emitMealEdit({ mealId: 42, id: legacyMealId }), { name: 'edit', detail: { mealId: legacyMealId } },
    'a non-string mealId must not hide a valid legacy id')

  const datasetMealId = 'dataset meal/id ?&中文'
  page.editMeal({ detail: {}, currentTarget: { dataset: { id: datasetMealId } } })
  assert.strictEqual(navigationUrls.at(-1), `/pages/meal-edit/meal-edit?mealId=${encodeURIComponent(datasetMealId)}`,
    'plan page must retain and URL-encode the dataset fallback for legacy component events')

  const markup = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'plan', 'plan.wxml'), 'utf8')
  const previewMarkup = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'plan-preview', 'plan-preview.wxml'), 'utf8')
  const previewSource = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'plan-preview', 'plan-preview.js'), 'utf8')
  const styles = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'plan', 'plan.wxss'), 'utf8')
  assert(!markup.includes('scroll-into-view='), 'selected dates must not scroll Monday out of view')
  assert(markup.includes('wx:for="{{weeks}}"'))
  assert(markup.includes('wx:for="{{displayedDays}}"'))
  assert(/<meal-card[^>]+bind:edit="editMeal"[^>]+data-id="{{item\.mealId}}"/.test(markup),
    'meal-card binding must keep both the edit event and dataset fallback')
  assert(markup.includes('<text class="day-short">{{item.name || item.short}}</text>'),
    '日期按钮必须优先显示完整星期名，避免顶部缩写与下方标题不一致')
  assert(/class="day-button[^>]+aria-role="button"[^>]+aria-pressed="\{\{item\.selected\}\}"/.test(markup),
    '日期按钮必须与周、晚餐切换统一使用 aria-pressed')
  assert(!markup.includes('aria-selected="{{item.selected}}"'), '日期按钮不能混用 aria-selected')
  assert(markup.includes('选择今天的晚餐方案'))
  assert(markup.includes('仅切换今天的晚餐，不会记录运动'))
  assert(markup.includes('<text>日常晚餐</text>'))
  assert(markup.includes('<text>运动日晚餐</text>'))
  assert(!markup.includes('今晚的运动安排'))
  assert(markup.includes('AI 生成') && !markup.includes('AI生成'),
    '主餐单的 AI 来源标识必须保留中英文空格')
  assert(markup.includes('查看餐单历史') && markup.includes('餐单版本 {{planVersion}}'),
    '主餐单底部操作和版本必须统一使用餐单术语')
  assert(!markup.includes('候选计划'), '主餐单不能混用候选计划旧称呼')
  assert(!markup.includes('静态预设'), '餐单空态不能暴露内部回退实现')
  assert(markup.includes('生成失败不会替换已经确认的餐单'))
  assert(previewMarkup.includes('确认并使用餐单') && previewMarkup.includes('丢弃候选餐单'),
    '候选预览必须统一使用餐单术语')
  assert(previewMarkup.includes('不能替代医生或注册营养师建议'),
    '最终确认操作前必须显示简短的非医疗建议提醒')
  assert(!previewMarkup.includes('契约 v') && !previewSource.includes('契约 v'),
    '候选预览不能展示内部契约版本')
  assert(previewSource.includes('userStore.confirmDraft(expectedDraftPlanId)')
    && previewSource.includes('userStore.discardDraft(expectedDraftPlanId)'),
  '确认和丢弃必须绑定用户当时看到的候选餐单标识')
  assert(!previewMarkup.includes('本机快照'), '候选预览离线提示不能使用内部快照术语')
  assert(!previewMarkup.includes('AI生成') && previewMarkup.includes('AI 生成'),
    '候选预览的 AI 来源标识必须保留中英文空格')
  assert(!styles.includes('.segment-button.active.workout'), 'both dinner choices must use one selected style')
  assert(!markup.includes('segment-button workout'), 'both dinner choices must share the exact same visual class')
  assert(/\.segment-button\s*\{[^}]*border:\s*1rpx solid var\(--line\);[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--muted-strong\);/.test(styles),
    '未选晚餐方案也必须清楚呈现为可点击控件，不能像禁用状态')
  assert(previewMarkup.includes('选择餐次、目标和运动安排后，即可生成餐单。'),
    '候选餐单空态必须使用适合窄屏的简短说明')
  assert(/\.day-list\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);[^}]*gap:\s*8px;/.test(styles),
    '手机日期必须默认使用 4+3 网格和 8px 间距')
  assert(/@media \(min-width: 600px\)[\s\S]*?\.day-list\s*\{\s*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\);\s*\}/.test(styles),
    '仅 600px 以上宽屏恢复七列日期')
  assert(/@media \(max-width: 400px\)[\s\S]*?\.day-button, \.segment-button\s*\{\s*min-height:\s*48px;\s*\}/.test(styles),
    '窄屏日期与晚餐按钮触控高度至少 48px')
}

async function testPreviewDiscardDraftCas() {
  const root = path.resolve(__dirname, '..')
  const previewPath = path.join(root, 'miniprogram', 'pages', 'plan-preview', 'plan-preview.js')
  const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
  const membershipStorePath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
  const draftA = { ...makePlan([{ id: 'day-a' }]), id: 'draft-a', title: 'Draft A' }
  const draftB = { ...makePlan([{ id: 'day-b' }]), id: 'draft-b', title: 'Draft B' }
  const discardCalls = []
  const initCalls = []
  const membershipStore = { async init() { return { status: 'active' } } }
  const userStore = {
    state: 'ready',
    error: '',
    data: { draftPlan: draftA },
    async discardDraft(expectedDraftPlanId) {
      discardCalls.push(expectedDraftPlanId)
      const error = new Error('candidate changed on another device')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    },
    async init(options) {
      initCalls.push(options)
      return this.data
    },
  }

  require.cache[userStorePath] = {
    id: userStorePath, filename: userStorePath, loaded: true, exports: { userStore },
  }
  require.cache[membershipStorePath] = {
    id: membershipStorePath, filename: membershipStorePath, loaded: true, exports: { membershipStore },
  }

  let definition
  let page
  const modalTitles = []
  global.Page = (value) => { definition = value }
  global.wx = {
    showModal(options) {
      modalTitles.push(options.title)
      if (options.title === '丢弃这份候选餐单？') {
        userStore.data.draftPlan = draftB
        page.render()
        options.success({ confirm: true })
      } else if (options.title === '再次确认丢弃') {
        assert.strictEqual(page.data.plan.id, 'draft-b',
          'the page candidate must be allowed to change between confirmations')
        options.success({ confirm: true })
      }
    },
    showToast() {},
    stopPullDownRefresh() {},
  }
  delete require.cache[previewPath]
  require(previewPath)
  assert(definition, 'plan-preview.js must register Page')
  page = Object.create(definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = (partial) => Object.assign(page.data, partial)
  page.render()
  assert.strictEqual(page.data.plan.id, 'draft-a')

  await page.discardPlan()

  assert.deepStrictEqual(discardCalls, ['draft-a'],
    'discard must use only the candidate ID captured before either confirmation')
  assert.deepStrictEqual(initCalls, [{ force: true }],
    'a discard CAS conflict must force exactly one refresh')
  assert.strictEqual(page.data.plan.id, 'draft-b')
  assert.deepStrictEqual(modalTitles, [
    '丢弃这份候选餐单？', '再次确认丢弃', '候选餐单已变化',
  ])
}

testPlanPageRecovery().then(testPreviewDiscardDraftCas).then(() => {
  console.log('plan-view and plan-page tests passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
