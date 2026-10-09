Component({
  properties: {
    meal: { type: Object, value: {} },
    tone: { type: String, value: 'breakfast' },
    editable: { type: Boolean, value: false },
    replaceable: { type: Boolean, value: false },
    favoritable: { type: Boolean, value: false },
  },
  methods: {
    favorite() {
      const meal = this.properties.meal || {}
      this.triggerEvent('favorite', { mealId: meal.mealId || meal.id || '' })
    },
    replace() {
      const meal = this.properties.meal || {}
      this.triggerEvent('replace', { mealId: meal.mealId || meal.id || '' })
    },
    edit() {
      const meal = this.properties.meal || {}
      const mealId = typeof meal.mealId === 'string' && meal.mealId
        ? meal.mealId
        : typeof meal.id === 'string' ? meal.id : ''
      this.triggerEvent('edit', { mealId })
    },
  },
})
