'use strict'

const assert = require('assert')
const cooking = require('./meal-conditions')
const shopping = require('./meal-shopping')
const clone = value => JSON.parse(JSON.stringify(value))
const ingredient = (name, quantity, unit = 'g', category = '蔬菜') => ({ name, quantity, unit, category })
const pantry = (name, quantity, unit = 'g') => ({ name, quantity, unit })
const conditions = (servings = 2, pantryItems = []) => ({ servings, maxCookingMinutes: 30, pantryItems })
const meal = (quantity = 75.125) => ({ id: 'fictional-meal', type: 'lunch', scenario: 'default', title: '虚构测试餐',
  quantityBasis: 'per-person', estimatedCookingMinutes: 25, method: '按食材总量烹饪', ingredients: [ingredient('番茄', quantity)] })
const reject = callback => assert.throws(callback, error => error.code === 'MEAL_CONDITIONS_INVALID')

assert.deepStrictEqual(cooking.normalizeConditions({}), { servings: 1, maxCookingMinutes: 30, pantryItems: [] })
reject(() => cooking.normalizeConditions({}, { required: true }))
for (const servings of [0, -1, 1.1, 13, NaN, Infinity, null, '2']) reject(() => cooking.normalizeConditions({ servings }))
for (const maxCookingMinutes of [0, 4, 181, 20.1, null, '30']) reject(() => cooking.normalizeConditions({ maxCookingMinutes }))
for (const value of [null, [], '', 1]) reject(() => cooking.normalizeConditions(value))
for (const count of [1, 2, 12]) {
  for (const duration of [5, 30, 180]) assert.strictEqual(cooking.normalizeConditions({ servings: count, maxCookingMinutes: duration }).maxCookingMinutes, duration)
}
for (const quantity of [0, -1, 0.0001, 100001, Infinity, NaN, null, '1', 0.1234]) {
  reject(() => cooking.normalizePantry([pantry('番茄', quantity)]))
}
assert.strictEqual(cooking.normalizePantry([pantry('番茄', 0.1 + 0.2)])[0].quantity, 0.3)
reject(() => cooking.normalizePantry([pantry('番 茄', 100), pantry('番茄', 200)]))
reject(() => cooking.normalizePantry([pantry('Ａｐｐｌｅ', 1, '个'), pantry('apple', 1, '个')]))
reject(() => cooking.normalizePantry([{ ...pantry('番茄', 100), account: 'forbidden-field' }]))
reject(() => cooking.normalizePantry([pantry('番茄', 1, 'grams')]))
reject(() => cooking.normalizePantry([pantry('番茄\n', 1)]))
reject(() => cooking.normalizePantry(Array.from({ length: 31 }, (_, index) => pantry(`虚构${index}`, 1))))
assert.strictEqual(cooking.normalizePantry([pantry('番茄', 1, 'kg'), pantry('番茄', 100, 'g')]).length, 2)

for (const count of [1, 2, 12]) {
  const original = meal(), before = clone(original), scaled = cooking.scalePerPersonMeal(original, conditions(count))
  assert.strictEqual(scaled.ingredients[0].quantity, 75.125 * count)
  assert.strictEqual(scaled.servings, count)
  assert.strictEqual(scaled.quantityBasis, 'total')
  assert.strictEqual(scaled.estimatedCookingMinutes, 25, 'total estimated cooking time is not multiplied')
  assert.deepStrictEqual(original, before)
  reject(() => cooking.scalePerPersonMeal(scaled, conditions(count)))
}
reject(() => cooking.scalePerPersonMeal({ ...meal(), quantityBasis: undefined }, conditions()))
reject(() => cooking.scalePerPersonMeal({ ...meal(), servings: 2 }, conditions()))
reject(() => cooking.scalePerPersonMeal({ ...meal(), estimatedCookingMinutes: 31 }, conditions()))
reject(() => cooking.scalePerPersonMeal({ ...meal(), estimatedCookingMinutes: 0 }, conditions()))
reject(() => cooking.scalePerPersonMeal(meal(100000), conditions(12)))

function groups(items) { return [{ id: 'vegetables', name: '蔬菜', items }] }
const row = (id, name, quantity, unit = 'g') => ({ id, name, quantity, unit, amount: `${quantity} ${unit}` })
const flatten = groups => groups.flatMap(group => group.items)
const source = groups([row('tomato', '番茄', 400), row('eggs', '鸡蛋', 4, '个')])
const supplied = [pantry('番茄', 150), pantry('鸡蛋', 8, '个'), pantry('土豆', 300)]
const before = clone({ source, supplied }), result = cooking.applyPantry(source, supplied)
assert.deepStrictEqual(flatten(result.groups).map(i => [i.id, i.requiredQuantity, i.pantryQuantity, i.quantity]), [['tomato', 400, 150, 250]])
assert.deepStrictEqual(flatten(result.coveredGroups).map(i => [i.id, i.quantity]), [['eggs', 0]])
assert.deepStrictEqual(result.unusedPantry, [pantry('鸡蛋', 4, '个'), pantry('土豆', 300)])
assert.deepStrictEqual({ source, supplied }, before)
assert.strictEqual(cooking.applyPantry(groups([row('a', '番茄', 0.3)]), [pantry('番茄', 0.1)]).groups[0].items[0].quantity, 0.2)
const differentUnits = cooking.applyPantry(groups([row('a', '番茄', 500)]), [pantry('番茄', 2, 'kg')])
assert.strictEqual(differentUnits.groups[0].items[0].quantity, 500, 'never guesses unit conversion')
assert.strictEqual(differentUnits.unusedPantry[0].quantity, 2)

const duplicateCategories = [
  { id: 'first', name: '其他', items: [row('same-1', '番茄', 200)] },
  { id: 'second', name: '蔬菜', items: [row('same-2', '番 茄', 200)] },
]
const allocation = cooking.applyPantry(duplicateCategories, [pantry('番茄', 300)])
assert.strictEqual(flatten(allocation.groups).reduce((sum, item) => sum + item.quantity, 0), 100, 'stock must not be subtracted twice across categories')
const reversed = cooking.applyPantry(duplicateCategories.slice().reverse(), [pantry('番茄', 300)])
assert.deepStrictEqual(flatten(reversed.groups), flatten(allocation.groups), 'reordering cannot change allocation')
reject(() => cooking.applyPantry(groups([row('same', '番茄', 1), row('same', '土豆', 1)]), []))
reject(() => cooking.applyPantry([{ id: 'a', items: [] }, { id: 'a', items: [] }], []))
reject(() => cooking.applyPantry(Array.from({ length: 13 }, (_, i) => ({ id: `group-${i}`, items: [] })), []))
reject(() => cooking.applyPantry(groups(Array.from({ length: 41 }, (_, i) => row(`item-${i}`, `虚构食材${i}`, 1))), []))
reject(() => cooking.applyPantry(groups([{ id: 'legacy', name: '番茄', amount: '适量' }]), []))
assert.deepStrictEqual(cooking.applyPantry([], [pantry('土豆', 300)]), { groups: [], coveredGroups: [], unusedPantry: [pantry('土豆', 300)] })

// Compose with the existing shopping projection for fictional 1/7/14-day plans.
// Only selected dinners enter this calculation; the two alternatives are not added together.
for (const days of [1, 7, 14]) {
  const plan = { id: `fictional-${days}`, source: 'ai', shoppingGroups: groups([row('tomato', '番茄', 1)]),
    days: Array.from({ length: days }, (_, index) => ({ id: `day-${index}`, exercise: { planned: false }, meals: [
      { ...cooking.scalePerPersonMeal(meal(80), conditions(3)), id: `breakfast-${index}`, type: 'breakfast' },
      { ...cooking.scalePerPersonMeal(meal(100), conditions(3)), id: `rest-${index}`, type: 'dinner', scenario: 'rest' },
      { ...cooking.scalePerPersonMeal(meal(150), conditions(3)), id: `workout-${index}`, type: 'dinner', scenario: 'workout' },
    ] })),
  }
  const selected = plan.days.flatMap(day => day.meals.filter(item => item.scenario !== 'workout'))
  const all = shopping.inventory(plan, selected)
  const stock = [pantry('番茄', 200)]
  const preview = cooking.applyPantry(all, stock)
  assert.strictEqual(flatten(preview.groups)[0].quantity, days * 540 - 200)
  const overrides = { 'rest-0': { ingredientItems: [ingredient('番茄', 600)] } }
  const edited = cooking.applyPantry(shopping.inventory(plan, selected, overrides), stock)
  assert.strictEqual(flatten(edited.groups)[0].quantity, days * 540 + 300 - 200)
  assert.deepStrictEqual(cooking.applyPantry(all, stock), preview, 'repeated preview does not consume stock')
}
// Deterministic quantity-conservation coverage; no external fuzz runner or private fixtures.
for (let seed = 1; seed <= 150; seed += 1) {
  const demand = (seed * 113 % 1000 + 1) / 1000, stock = (seed * 317 % 1300 + 1) / 1000
  const projected = cooking.applyPantry(groups([row('test', '虚构食材', demand)]), [pantry('虚构食材', stock)])
  const item = flatten(projected.groups.concat(projected.coveredGroups))[0]
  assert.strictEqual(Math.round((item.pantryQuantity + item.quantity) * 1000), Math.round(demand * 1000))
  assert.strictEqual(Math.round((item.pantryQuantity + (projected.unusedPantry[0]?.quantity || 0)) * 1000), Math.round(stock * 1000))
  assert(item.quantity >= 0 && item.pantryQuantity >= 0)
}
console.log('cooking-condition rules passed: explicit limits, strict pantry, one-time scaling, shared stock, conservation and 1/7/14-day composition')
