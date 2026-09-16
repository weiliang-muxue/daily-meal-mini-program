'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  classifyPreviewDataSummary,
  classifyRenderedSummary,
  safeEvidenceReport,
} = require('./plan-preview-evidence')

function validData(overrides = {}) {
  return {
    ownerMatched: true,
    routeMatched: true,
    viewState: 'ready',
    draftMatched: true,
    fields: { title: true, firstMeal: true, ingredients: true, method: true },
    ...overrides,
  }
}

test('accepts only an owned ready or offline preview for the generated draft', () => {
  assert.equal(classifyPreviewDataSummary(validData()), 'OK')
  assert.equal(classifyPreviewDataSummary(validData({ viewState: 'offline' })), 'OK')
  assert.equal(classifyPreviewDataSummary(validData({ ownerMatched: false })), 'PLAN_PREVIEW_OWNERSHIP_MISMATCH')
  assert.equal(classifyPreviewDataSummary(validData({ routeMatched: false })), 'PLAN_PREVIEW_STATE_INVALID')
  assert.equal(classifyPreviewDataSummary(validData({ viewState: 'loading' })), 'PLAN_PREVIEW_STATE_INVALID')
  assert.equal(classifyPreviewDataSummary(validData({ viewState: 'no-draft' })), 'PLAN_PREVIEW_STATE_INVALID')
  assert.equal(classifyPreviewDataSummary(validData({ draftMatched: false })), 'PLAN_PREVIEW_DRAFT_MISMATCH')
})

test('fails closed when any required page-data or rendered field is absent', () => {
  for (const name of ['title', 'firstMeal', 'ingredients', 'method']) {
    const data = validData()
    data.fields = { ...data.fields, [name]: false }
    assert.equal(classifyPreviewDataSummary(data), 'PLAN_PREVIEW_DATA_INVALID')

    const rendered = { title: true, firstMeal: true, ingredients: true, method: true, [name]: false }
    assert.equal(classifyRenderedSummary(rendered), 'PLAN_PREVIEW_RENDER_INVALID')
  }
  assert.equal(classifyPreviewDataSummary(null), 'PLAN_PREVIEW_OWNERSHIP_MISMATCH')
  assert.equal(classifyRenderedSummary(null), 'PLAN_PREVIEW_RENDER_INVALID')
})

test('reports only fixed booleans and never carries plan contents or identifiers', () => {
  const report = safeEvidenceReport({
    passed: true,
    durationDays: 1,
    data: validData({
      planId: 'private-plan-id',
      title: 'private title',
      firstMealTitle: 'private meal',
    }),
    rendered: { title: true, firstMeal: true, ingredients: true, method: true, text: 'private text' },
    screenshots: { top: true, bottom: true, path: 'private-path' },
  })
  assert.deepEqual(report, {
    passed: true,
    durationDays: 1,
    viewState: 'ready',
    draftMatched: true,
    dataFields: { title: true, firstMeal: true, ingredients: true, method: true },
    renderedFields: { title: true, firstMeal: true, ingredients: true, method: true },
    screenshots: { top: true, bottom: true },
    failureCode: '',
  })
  const serialized = JSON.stringify(report)
  for (const forbidden of ['private-plan-id', 'private title', 'private meal', 'private text', 'private-path']) {
    assert.equal(serialized.includes(forbidden), false)
  }
})
