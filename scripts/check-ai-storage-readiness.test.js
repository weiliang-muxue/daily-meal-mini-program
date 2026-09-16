'use strict'

const assert = require('assert')
const {
  SNAPSHOT_SCHEMA_VERSION,
  AI_STORAGE_READY,
  AI_STORAGE_NOT_READY,
  AI_STORAGE_SNAPSHOT_INVALID,
  AI_STORAGE_INDEX_MANIFEST_INVALID,
  AI_COLLECTIONS,
  AI_INDEX_REQUIREMENTS,
  AI_INDEX_IDS,
  AiStorageReadinessError,
  buildAiStorageReadiness,
  validateAiIndexManifest,
  buildManualRepairPlan,
  readManifest,
  runCli,
} = require('./check-ai-storage-readiness')

function booleanMap(keys, value = true) {
  return Object.fromEntries(keys.map((key) => [key, value]))
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    collections: booleanMap(AI_COLLECTIONS),
    indexes: booleanMap(AI_INDEX_IDS),
    ...overrides,
  }
}

function rejectsCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof AiStorageReadinessError
    && error.code === code
    && error.message === code
  ))
}

const manifestResult = validateAiIndexManifest(readManifest())
assert.deepStrictEqual(manifestResult, {
  valid: true,
  collectionCount: 3,
  compositeIndexCount: 4,
})
assert.deepStrictEqual(runCli(['--check-manifest']), manifestResult)

const ready = buildAiStorageReadiness(snapshot())
assert.strictEqual(ready.ready, true)
assert.strictEqual(ready.code, AI_STORAGE_READY)
assert.deepStrictEqual(ready.missingCollections, [])
assert.deepStrictEqual(ready.missingIndexes, [])
assert.deepStrictEqual(buildManualRepairPlan(ready), {
  required: false,
  createCollections: [],
  createIndexes: [],
  requiresLiveMetadataRecheck: true,
  permitsDocumentReads: false,
  permitsDocumentWrites: false,
})

const missingCollection = AI_COLLECTIONS[0]
const missingIndex = AI_INDEX_IDS[2]
const collections = booleanMap(AI_COLLECTIONS)
const indexes = booleanMap(AI_INDEX_IDS)
collections[missingCollection] = false
indexes[missingIndex] = false
const notReady = buildAiStorageReadiness(snapshot({ collections, indexes }))
assert.strictEqual(notReady.ready, false)
assert.strictEqual(notReady.code, AI_STORAGE_NOT_READY)
assert.deepStrictEqual(notReady.missingCollections, [missingCollection])
assert.deepStrictEqual(notReady.missingIndexes, [missingIndex])
assert.deepStrictEqual(buildManualRepairPlan(notReady), {
  required: true,
  createCollections: [missingCollection],
  createIndexes: [{
    id: missingIndex,
    collectionName: 'meal_ai_shards',
    fields: [
      { fieldPath: 'owner', order: 'ASCENDING' },
      { fieldPath: 'taskId', order: 'ASCENDING' },
    ],
  }],
  requiresLiveMetadataRecheck: true,
  permitsDocumentReads: false,
  permitsDocumentWrites: false,
})

rejectsCode(() => buildAiStorageReadiness(null), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildAiStorageReadiness({}), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildAiStorageReadiness({ ...snapshot(), schemaVersion: 2 }), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildAiStorageReadiness({ ...snapshot(), unexpected: true }), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildAiStorageReadiness(snapshot({ collections: { ...collections, unknown: true } })),
  AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildAiStorageReadiness(snapshot({ indexes: { ...indexes, [missingIndex]: 'ready' } })),
  AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildManualRepairPlan({ ...ready, ready: false }), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildManualRepairPlan({ ...ready, code: AI_STORAGE_NOT_READY }), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildManualRepairPlan({ ...notReady, missingCollections: [] }), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => buildManualRepairPlan({ ...notReady, unexpected: true }), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => runCli([]), AI_STORAGE_SNAPSHOT_INVALID)
rejectsCode(() => runCli(['--snapshot', 'private.json']), AI_STORAGE_SNAPSHOT_INVALID)

const validManifest = readManifest()
const reverseDirection = JSON.parse(JSON.stringify(validManifest))
reverseDirection.indexes.find((index) => index.collectionName === 'meal_ai_tasks').fields[2].order = 'ASCENDING'
rejectsCode(() => validateAiIndexManifest(reverseDirection), AI_STORAGE_INDEX_MANIFEST_INVALID)

const missingManifestIndex = JSON.parse(JSON.stringify(validManifest))
missingManifestIndex.indexes = missingManifestIndex.indexes.filter((index) => !(
  index.collectionName === 'meal_ai_shards'
  && index.fields.some((field) => field.fieldPath === 'taskId')
))
rejectsCode(() => validateAiIndexManifest(missingManifestIndex), AI_STORAGE_INDEX_MANIFEST_INVALID)

const extraAiIndex = JSON.parse(JSON.stringify(validManifest))
extraAiIndex.indexes.push({
  collectionName: 'meal_ai_controls',
  fields: [{ fieldPath: 'owner', order: 'ASCENDING' }],
})
rejectsCode(() => validateAiIndexManifest(extraAiIndex), AI_STORAGE_INDEX_MANIFEST_INVALID)

const malformedField = JSON.parse(JSON.stringify(validManifest))
malformedField.indexes.find((index) => index.collectionName === 'meal_ai_tasks').fields[0].extra = true
rejectsCode(() => validateAiIndexManifest(malformedField), AI_STORAGE_INDEX_MANIFEST_INVALID)

assert.strictEqual(AI_INDEX_REQUIREMENTS.length, 4)
assert(AI_INDEX_REQUIREMENTS.every((requirement) => AI_COLLECTIONS.includes(requirement.collectionName)))
assert(AI_INDEX_REQUIREMENTS.every((requirement) => Object.isFrozen(requirement.fields)))

console.log('AI storage readiness gate tests passed')
