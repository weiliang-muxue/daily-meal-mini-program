'use strict'

const fs = require('fs')
const path = require('path')

const SNAPSHOT_SCHEMA_VERSION = 1
const AI_STORAGE_READY = 'AI_STORAGE_READY'
const AI_STORAGE_NOT_READY = 'AI_STORAGE_NOT_READY'
const AI_STORAGE_SNAPSHOT_INVALID = 'AI_STORAGE_SNAPSHOT_INVALID'
const AI_STORAGE_INDEX_MANIFEST_INVALID = 'AI_STORAGE_INDEX_MANIFEST_INVALID'

const AI_COLLECTIONS = Object.freeze([
  'meal_ai_tasks',
  'meal_ai_shards',
  'meal_ai_controls',
])

const AI_INDEX_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: 'meal_ai_tasks__owner_asc__status_asc__createdAt_desc',
    collectionName: 'meal_ai_tasks',
    fields: Object.freeze([
      Object.freeze({ fieldPath: 'owner', order: 'ASCENDING' }),
      Object.freeze({ fieldPath: 'status', order: 'ASCENDING' }),
      Object.freeze({ fieldPath: 'createdAt', order: 'DESCENDING' }),
    ]),
  }),
  Object.freeze({
    id: 'meal_ai_tasks__status_asc__expiresAt_asc',
    collectionName: 'meal_ai_tasks',
    fields: Object.freeze([
      Object.freeze({ fieldPath: 'status', order: 'ASCENDING' }),
      Object.freeze({ fieldPath: 'expiresAt', order: 'ASCENDING' }),
    ]),
  }),
  Object.freeze({
    id: 'meal_ai_shards__owner_asc__taskId_asc',
    collectionName: 'meal_ai_shards',
    fields: Object.freeze([
      Object.freeze({ fieldPath: 'owner', order: 'ASCENDING' }),
      Object.freeze({ fieldPath: 'taskId', order: 'ASCENDING' }),
    ]),
  }),
  Object.freeze({
    id: 'meal_ai_tasks__shardCleanupPending_asc__shardCleanupUpdatedAtMs_asc',
    collectionName: 'meal_ai_tasks',
    fields: Object.freeze([
      Object.freeze({ fieldPath: 'shardCleanupPending', order: 'ASCENDING' }),
      Object.freeze({ fieldPath: 'shardCleanupUpdatedAtMs', order: 'ASCENDING' }),
    ]),
  }),
])

const AI_INDEX_IDS = Object.freeze(AI_INDEX_REQUIREMENTS.map((requirement) => requirement.id))
const SNAPSHOT_KEYS = Object.freeze(['schemaVersion', 'collections', 'indexes'])
const READINESS_KEYS = Object.freeze([
  'schemaVersion', 'ready', 'code', 'collections', 'indexes', 'missingCollections', 'missingIndexes',
])

class AiStorageReadinessError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AiStorageReadinessError'
    this.code = code
  }
}

function fail(code) {
  throw new AiStorageReadinessError(code)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function exactBooleanMap(value, expectedKeys) {
  if (!hasExactKeys(value, expectedKeys)) fail(AI_STORAGE_SNAPSHOT_INVALID)
  const result = {}
  expectedKeys.forEach((key) => {
    if (typeof value[key] !== 'boolean') fail(AI_STORAGE_SNAPSHOT_INVALID)
    result[key] = value[key]
  })
  return Object.freeze(result)
}

function buildAiStorageReadiness(snapshot) {
  if (!hasExactKeys(snapshot, SNAPSHOT_KEYS)) fail(AI_STORAGE_SNAPSHOT_INVALID)
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail(AI_STORAGE_SNAPSHOT_INVALID)

  const collections = exactBooleanMap(snapshot.collections, AI_COLLECTIONS)
  const indexes = exactBooleanMap(snapshot.indexes, AI_INDEX_IDS)
  const missingCollections = Object.freeze(AI_COLLECTIONS.filter((name) => !collections[name]))
  const missingIndexes = Object.freeze(AI_INDEX_IDS.filter((id) => !indexes[id]))
  const ready = missingCollections.length === 0 && missingIndexes.length === 0

  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ready,
    code: ready ? AI_STORAGE_READY : AI_STORAGE_NOT_READY,
    collections,
    indexes,
    missingCollections,
    missingIndexes,
  })
}

function indexSignature(index) {
  if (!isPlainObject(index) || typeof index.collectionName !== 'string' || !Array.isArray(index.fields)) {
    fail(AI_STORAGE_INDEX_MANIFEST_INVALID)
  }
  const fields = index.fields.map((field) => {
    if (!hasExactKeys(field, ['fieldPath', 'order'])) fail(AI_STORAGE_INDEX_MANIFEST_INVALID)
    if (typeof field.fieldPath !== 'string' || !['ASCENDING', 'DESCENDING'].includes(field.order)) {
      fail(AI_STORAGE_INDEX_MANIFEST_INVALID)
    }
    return `${field.fieldPath}:${field.order}`
  })
  return `${index.collectionName}|${fields.join('|')}`
}

function validateAiIndexManifest(manifest) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.indexes)) {
    fail(AI_STORAGE_INDEX_MANIFEST_INVALID)
  }
  const expected = AI_INDEX_REQUIREMENTS.map(indexSignature).sort()
  const actual = manifest.indexes
    .filter((index) => isPlainObject(index) && AI_COLLECTIONS.includes(index.collectionName))
    .map(indexSignature)
    .sort()
  if (actual.length !== expected.length || actual.some((signature, index) => signature !== expected[index])) {
    fail(AI_STORAGE_INDEX_MANIFEST_INVALID)
  }
  return Object.freeze({
    valid: true,
    collectionCount: AI_COLLECTIONS.length,
    compositeIndexCount: AI_INDEX_REQUIREMENTS.length,
  })
}

function buildManualRepairPlan(readiness) {
  if (!hasExactKeys(readiness, READINESS_KEYS)
    || !Array.isArray(readiness.missingCollections)
    || !Array.isArray(readiness.missingIndexes)) {
    fail(AI_STORAGE_SNAPSHOT_INVALID)
  }
  const verified = buildAiStorageReadiness({
    schemaVersion: readiness.schemaVersion,
    collections: readiness.collections,
    indexes: readiness.indexes,
  })
  if (readiness.ready !== verified.ready
    || readiness.code !== verified.code
    || JSON.stringify(readiness.missingCollections) !== JSON.stringify(verified.missingCollections)
    || JSON.stringify(readiness.missingIndexes) !== JSON.stringify(verified.missingIndexes)) {
    fail(AI_STORAGE_SNAPSHOT_INVALID)
  }
  const { missingCollections, missingIndexes } = verified
  const createCollections = Object.freeze(AI_COLLECTIONS.filter((name) => missingCollections.includes(name)))
  const createIndexes = Object.freeze(AI_INDEX_REQUIREMENTS
    .filter((requirement) => missingIndexes.includes(requirement.id))
    .map((requirement) => Object.freeze({
      id: requirement.id,
      collectionName: requirement.collectionName,
      fields: requirement.fields,
    })))

  return Object.freeze({
    required: createCollections.length > 0 || createIndexes.length > 0,
    createCollections,
    createIndexes,
    requiresLiveMetadataRecheck: true,
    permitsDocumentReads: false,
    permitsDocumentWrites: false,
  })
}

function readManifest(root = path.resolve(__dirname, '..')) {
  return JSON.parse(fs.readFileSync(path.join(root, 'database.indexes.json'), 'utf8'))
}

function runCli(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--check-manifest') fail(AI_STORAGE_SNAPSHOT_INVALID)
  return validateAiIndexManifest(readManifest())
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(runCli())}\n`)
  } catch (error) {
    const code = error instanceof AiStorageReadinessError
      ? error.code : AI_STORAGE_INDEX_MANIFEST_INVALID
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}

module.exports = {
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
}
