'use strict'

// Fictional, network-free worker roundtrip. Stored shards are revalidated, not rescaled.
const assert = require('assert')
const ai = require('../cloudfunctions/aiPlanner/lib')
const state = require('../shared/user-state')
const { shoppingView } = require('../miniprogram/services/plan-view')
const form = require('../miniprogram/utils/cooking-form')
const clone = value => JSON.parse(JSON.stringify(value))
const request = (patch = {}) => ai.normalizeRequest({ contractVersion: ai.CONTRACT_VERSION,
  durationDays: 1, startDate: '2026-10-10', mealTypes: ['breakfast'], doubleDinner: false,
  goals: ['均衡饮食'], styles: [], customGoal: '', restrictions: '', healthNotes: '',
  exerciseIntent: 'none', exerciseByDay: [], exerciseNotes: '',
  servings: 1, maxCookingMinutes: 30, pantryItems: [], ...patch })
const outline = { title: '虚构测试餐单', rationale: ['按本次确认条件搭配'] }
const options = { planId: 'cooking-fixture', generatedAt: '2026-10-09T08:00:00.000Z' }

function rawChunk(input, chunk) {
  return { days: chunk.targets.map(target => ({ dayIndex: target.dayIndex,
    ...(target.themeRequired ? { theme: '虚构均衡搭配' } : {}),
    meals: target.mealKeys.map(key => {
      const index = target.dayIndex * 5 + ai.expectedMealKeys(input).indexOf(key)
      const [type, scenario] = key.split(':')
      return { type, scenario, title: `蔬菜搭配${String.fromCodePoint(0x3400 + index)}`,
        quantityBasis: 'per-person', servings: 1, estimatedCookingMinutes: input.maxCookingMinutes,
        ingredients: [{ name: '番茄', quantity: 100.125, unit: 'g', category: '蔬菜' }],
        method: '清洗后煮熟，按食材表总用量分装', tag: '虚构测试' }
    }),
  })) }
}
function assemble(input) {
  const chunks = ai.buildChunkLayout(input).map(chunk => {
    const clean = { days: ai.normalizeDetailChunk(rawChunk(input, chunk), input, outline, chunk) }
    const again = { days: ai.normalizeDetailChunk(clone(clean), input, outline, chunk) }
    assert.deepStrictEqual(again, clean, '读取保存分片不得重复放大数量')
    again.days.forEach(day => day.meals.forEach(meal => {
      assert.strictEqual(meal.ingredients[0].quantity, 100.125)
      assert.strictEqual(meal.quantityBasis, 'per-person')
    }))
    return again
  })
  return ai.assembleRawPlan(input, outline, chunks)
}
let cases = 0
for (const durationDays of [1, 7, 14]) for (const servings of [1, 3, 12]) {
  for (const mealTypes of [['breakfast'], ['breakfast', 'lunch', 'dinner', 'snack']]) {
    const input = request({ durationDays, servings, mealTypes, doubleDinner: mealTypes.includes('dinner'), dislikes: '不喜欢苦瓜', restrictions: '花生过敏',
      pantryItems: [{ name: '番茄', quantity: 125, unit: 'g' }, { name: '菠菜', quantity: 10, unit: 'g' }] })
    const assembled = assemble(input)
    const plan = ai.normalizePlan(assembled, input, options)
    const saved = state.sanitizeState({ ...state.defaults(), draftPlan: plan, generationPreferences: input })
    const confirmed = state.confirmDraft(saved, saved.stateRevision)
    assert.deepStrictEqual(confirmed.activePlan.generationBasis.pantryItems, input.pantryItems)
    assert.strictEqual(confirmed.activePlan.generationBasis.dislikes, input.dislikes)
    assert.strictEqual(confirmed.activePlan.generationBasis.restrictions, input.restrictions)
    for (const day of plan.days) for (const meal of day.meals) {
      assert.strictEqual(meal.servings, servings)
      assert.strictEqual(meal.ingredients[0].quantity, 100.125 * servings)
      assert.strictEqual(meal.estimatedCookingMinutes, 30, '总耗时不能按人数放大')
      assert.strictEqual(meal.quantityBasis, 'total')
    }
    assert.throws(() => ai.normalizePlan(plan, input, options), /单人份|放大/, '不能把已保存的总份量当作模型输出再乘人数')
    const shopping = shoppingView(confirmed.activePlan, confirmed)
    const net = shopping.groups.flatMap(group => group.items).reduce((sum, item) => sum + item.quantity, 0)
    const gross = durationDays * mealTypes.length * servings * 100.125
    assert.strictEqual(net, Math.max(0, gross - 125), '只计算选中晚餐，整期只扣一次库存')
    assert.deepStrictEqual(shopping.unusedPantry.find(item => item.name === '菠菜'), input.pantryItems[1])
    assert.strictEqual(shopping.coveredGroups.length > 0, gross <= 125)
    const prompts = [ai.buildPrompt(input), ai.buildOutlinePrompt(input), ai.buildDetailPrompt(input, outline, ai.buildChunkLayout(input)[0])]
    prompts.forEach(prompt => {
      assert(prompt.includes('USER_DATA') && prompt.includes('"pantryItems"') && prompt.includes('"servings"') && prompt.includes('"maxCookingMinutes"'))
      assert(!prompt.includes('openid') && !prompt.includes('cacheNamespace'))
    })
    const badStored = clone(plan)
    badStored.days[0].meals[0].servings = servings === 1 ? 2 : 1
    assert.throws(() => state.sanitizePlan(badStored), /conditions|条件|份量|servings/)
    cases += 1
  }
}
const input = request()
for (const field of ['servings', 'maxCookingMinutes', 'pantryItems']) {
  const missing = clone(input); delete missing[field]
  assert.throws(() => ai.normalizeRequest(missing), /重新确认/)
}
for (const patch of [{ servings: 0 }, { servings: 13 }, { servings: '2' }, { maxCookingMinutes: 4 },
  { maxCookingMinutes: 181 }, { pantryItems: [{ name: '番茄', quantity: 0, unit: 'g' }] }]) {
  assert.throws(() => request(patch))
}
for (const patch of [{ servings: 2 }, { maxCookingMinutes: 45 }, { pantryItems: [{ name: '番茄', quantity: 100, unit: 'g' }] }]) {
  assert.notStrictEqual(ai.preferencesHash(input), ai.preferencesHash(request(patch)))
}
const raw = assemble(input)
for (const patch of [{ quantityBasis: 'total' }, { quantityBasis: undefined }, { servings: 2 },
  { estimatedCookingMinutes: 31 }, { estimatedCookingMinutes: 0 }, { estimatedCookingMinutes: 1.5 }]) {
  const invalid = clone(raw); Object.assign(invalid.days[0].meals[0], patch)
  assert.throws(() => ai.normalizePlan(invalid, input, options))
}
for (const quantity of [0, '100', 0.0001, 1.1234]) {
  const invalid = clone(raw); invalid.days[0].meals[0].ingredients[0].quantity = quantity
  assert.throws(() => ai.normalizePlan(invalid, input, options))
}
for (const invalid of ['', '0', '13', '-1', '1.1', '1e1']) {
  const draft = form.fromPreferences(input); draft.servings = invalid
  assert(form.validate(draft).errors.servings)
}
for (const invalid of ['', '4', '181', '5.1', 'NaN']) {
  const draft = form.fromPreferences(input); draft.maxCookingMinutes = invalid
  assert(form.validate(draft).errors.maxCookingMinutes)
}
assert.deepStrictEqual(form.validate(form.fromPreferences(input)).value, { servings: 1, maxCookingMinutes: 30, pantryItems: [] })
console.log(`cooking pipeline: ${cases} fictional 1/7/14-day multimeal roundtrips, strict conditions and draft tests passed`)
