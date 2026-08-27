const assert = require('assert')
const { buildPlanView, selectDay } = require('../miniprogram/services/plan-view')

function meal(type, scenario, id) {
  return { type, scenario, id, title: `${type}-${scenario}`, ingredients: 'one', method: 'cook' }
}

function makePlan(days, meals = [meal('snack', 'default', 'snack-1')]) {
  return {
    id: 'ai-plan-1', title: `${days.length} day plan`, durationDays: days.length, planVersion: 2,
    days: days.map((day, index) => ({ id: `day-${index + 1}`, date: `2026-08-${String(index + 1).padStart(2, '0')}`, name: `Day ${index + 1}`, meals: typeof meals === 'function' ? meals(index) : meals })),
    shoppingGroups: [{ id: 'produce', name: 'Produce', items: [{ id: 'apple', name: 'Apple', amount: '2' }, { id: 'old', name: 'Old', amount: '1' }] }],
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
view = buildPlanView(doubleDinner, { defaultDinnerMode: 'workout' })
assert.deepStrictEqual(view.selectedDay.meals.map((item) => item.id), ['b', 'dw', 'dd', 's'])
assert.strictEqual(view.selectedDay.hasDinnerAlternatives, true)
view = buildPlanView(doubleDinner, { defaultDinnerMode: 'rest', dinnerModeByDay: { 'day-1': 'workout' } })
assert.strictEqual(view.selectedDay.meals.find((item) => item.type === 'dinner' && item.scenario !== 'default').id, 'dw')

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

console.log('plan-view tests passed')
