'use strict'

const DATA_FIELDS = Object.freeze(['title', 'firstMeal', 'ingredients', 'method'])
const RENDER_FIELDS = Object.freeze(['title', 'firstMeal', 'ingredients', 'method'])
const VIEW_STATES = new Set(['ready', 'offline'])

function booleanFields(value, names) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries(names.map((name) => [name, source[name] === true]))
}

function classifyPreviewDataSummary(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  if (source.ownerMatched !== true) return 'PLAN_PREVIEW_OWNERSHIP_MISMATCH'
  if (source.routeMatched !== true || !VIEW_STATES.has(source.viewState)) return 'PLAN_PREVIEW_STATE_INVALID'
  if (source.draftMatched !== true) return 'PLAN_PREVIEW_DRAFT_MISMATCH'
  const fields = booleanFields(source.fields, DATA_FIELDS)
  return DATA_FIELDS.every((name) => fields[name]) ? 'OK' : 'PLAN_PREVIEW_DATA_INVALID'
}

function classifyRenderedSummary(value) {
  const fields = booleanFields(value, RENDER_FIELDS)
  return RENDER_FIELDS.every((name) => fields[name]) ? 'OK' : 'PLAN_PREVIEW_RENDER_INVALID'
}

function safeEvidenceReport(value = {}) {
  const data = value.data && typeof value.data === 'object' ? value.data : {}
  const screenshots = value.screenshots && typeof value.screenshots === 'object' ? value.screenshots : {}
  const durationDays = Number.isSafeInteger(value.durationDays)
    && value.durationDays >= 1 && value.durationDays <= 14 ? value.durationDays : 0
  return {
    passed: value.passed === true,
    durationDays,
    viewState: VIEW_STATES.has(data.viewState) ? data.viewState : 'invalid',
    draftMatched: data.draftMatched === true,
    dataFields: booleanFields(data.fields, DATA_FIELDS),
    renderedFields: booleanFields(value.rendered, RENDER_FIELDS),
    screenshots: {
      top: screenshots.top === true,
      bottom: screenshots.bottom === true,
    },
    failureCode: typeof value.failureCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.failureCode)
      ? value.failureCode : '',
  }
}

module.exports = {
  DATA_FIELDS,
  RENDER_FIELDS,
  classifyPreviewDataSummary,
  classifyRenderedSummary,
  safeEvidenceReport,
}
