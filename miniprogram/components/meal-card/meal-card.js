Component({
  properties: {
    meal: { type: Object, value: {} },
    tone: { type: String, value: 'breakfast' },
    editable: { type: Boolean, value: false },
  },
  methods: { edit() { this.triggerEvent('edit') } },
})
