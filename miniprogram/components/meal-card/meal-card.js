Component({
  properties: {
    meal: { type: Object, value: {} },
    tone: { type: String, value: 'breakfast' },
    editable: { type: Boolean, value: false },
  },
  methods: {
    edit() {
      const meal = this.properties.meal || {}
      const mealId = typeof meal.mealId === 'string' && meal.mealId
        ? meal.mealId
        : typeof meal.id === 'string' ? meal.id : ''
      this.triggerEvent('edit', { mealId })
    },
  },
})
