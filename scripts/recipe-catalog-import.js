'use strict'

// Offline, build-only preparation. This file cannot deploy or write a runtime catalog.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { TextDecoder } = require('node:util')
const source = require('./recipe-catalog-source')
const IMPORTER_VERSION = '1'
const IMPORTED_AT = '2026-10-09T00:00:00.000Z'
const ID_PATTERN = /^[a-z0-9][a-z0-9_（）-]{0,119}$/
const INDEX_KEYS = 'id title category markdown_path json_path cover_image overview_image difficulty duration_min calories tags'.split(' ')
const RECIPE_KEYS = 'id title category markdown_path status summary difficulty duration_min calories tags ingredients tools servings steps tips cover_image overview_image'.split(' ')
const TRANSFORMATIONS = Object.freeze([
  'Retain text quantities verbatim; never parse, execute formulas, scale or calculate shopping.',
  'Remove every image, summary, calorie estimate, tag, difficulty and serving formula.',
  'Keep ingredient buying_tip as an explicit source note, not a purchasing recommendation.',
  'Remove step produces; preserve instruction, time and tips without medical interpretation.',
  'Normalize optional null step tips to an empty list; omit null tip entries.',
  'Trim outer text whitespace and normalize Unicode NFC; preserve ingredient order.',
  'Quarantine schema, source, duplicate-path and unsafe text failures; require separate content review.',
])

class CatalogError extends Error {
  constructor(code) { super(code); this.name = 'CatalogError'; this.code = code }
}
function fail(code) { throw new CatalogError(code) }
function requireValue(value, code) { if (!value) fail(code) }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function recordHash(value) { return sha256(canonical(value)) }
function exactObject(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_OBJECT')
  requireValue(Object.keys(value).sort().join('|') === keys.slice().sort().join('|'), 'UNEXPECTED_FIELDS')
}
function string(value, max, empty = false) {
  requireValue(typeof value === 'string' && value.length <= max, 'INVALID_TEXT')
  requireValue(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value), 'UNSAFE_TEXT')
  requireValue(!/(?:https?:|ftp:|javascript\s*:|data\s*:|www\.|<\s*[!/?a-z])/i.test(value), 'UNSAFE_TEXT')
  const result = value.normalize('NFC').trim()
  requireValue(empty || result.length > 0, 'EMPTY_TEXT')
  return result
}
function number(value, min, max) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'INVALID_NUMBER')
  return value
}
function boolean(value) { requireValue(typeof value === 'boolean', 'INVALID_BOOLEAN'); return value }
function array(value, min, max) {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max, 'INVALID_LIST')
  return value
}
function texts(value, maxItems, maxLength) { return array(value, 0, maxItems).map(item => string(item, maxLength)) }
function relativePath(value, prefix, extension) {
  const result = string(value, 240)
  requireValue(result === value && result.startsWith(prefix) && result.endsWith(extension)
    && !/[\\%?#:]/.test(result), 'INVALID_SOURCE_PATH')
  requireValue(result.split('/').every(part => part && part !== '.' && part !== '..'
    && part === part.trim() && !part.endsWith('.')), 'INVALID_SOURCE_PATH')
  return result
}
function validateMetadata(row) {
  requireValue(ID_PATTERN.test(row.id) && typeof row.id === 'string', 'INVALID_ID')
  string(row.title, 80); string(row.category, 40)
  relativePath(row.markdown_path, 'dishes/', '.md')
  number(row.difficulty, 1, 5); number(row.duration_min, 1, 4320); number(row.calories, 0, 100000)
  texts(row.tags, 20, 80)
  relativePath(row.cover_image, 'ai-generated/', '.jpg')
  relativePath(row.overview_image, 'overview/', '.jpg')
}
function convertRecord(raw, index) {
  exactObject(raw, RECIPE_KEYS); exactObject(index, INDEX_KEYS)
  validateMetadata(raw); validateMetadata(index)
  requireValue(['id', 'title', 'category', 'markdown_path', 'duration_min', 'difficulty', 'calories']
    .every(key => raw[key] === index[key]), 'SOURCE_MAPPING_MISMATCH')
  requireValue(index.json_path === `json/recipes/${raw.id}.json`, 'INVALID_RECORD_PATH')
  requireValue(raw.status === 'published', 'UNPUBLISHED_SOURCE')
  // Do not pass through arbitrary URLs, hidden instructions or claims even in omitted fields.
  string(raw.summary, 1200, true)
  exactObject(raw.servings, ['base', 'formula'])
  const servings = number(raw.servings.base, 1, 100)
  array(raw.servings.formula, 0, 60).forEach(item => {
    exactObject(item, ['name', 'expr']); string(item.name, 80); string(item.expr, 240)
  })
  const ingredients = array(raw.ingredients, 1, 60).map(item => {
    exactObject(item, ['name', 'amount', 'buying_tip', 'optional', 'per_serving'])
    return { name: string(item.name, 80), amount: string(item.amount, 120),
      note: string(item.buying_tip, 240, true), optional: boolean(item.optional), perServing: boolean(item.per_serving) }
  })
  const steps = array(raw.steps, 1, 50).map((item, position) => {
    exactObject(item, ['index', 'title', 'instruction', 'duration_sec', 'tips', 'produces', 'image'])
    requireValue(item.index === position + 1, 'INVALID_STEP_SEQUENCE')
    relativePath(item.image, 'steps/', '.jpg')
    if (item.produces !== null) string(item.produces, 160, true)
    const tips = item.tips === null ? [] : array(item.tips, 0, 20).filter(tip => tip !== null)
    return { title: string(item.title, 80), instruction: string(item.instruction, 1600),
      durationSeconds: number(item.duration_sec, 0, 2592000), tips: texts(tips, 20, 400) }
  })
  return { id: raw.id, title: string(raw.title, 80), category: string(raw.category, 40),
    durationMinutes: raw.duration_min, servings, ingredients, tools: texts(raw.tools, 30, 160), steps,
    tips: texts(raw.tips, 30, 800) }
}
function contentFlags(raw) {
  const text = canonical(raw)
  const flags = []
  if (/(生食|生吃|溏心|温泉蛋|无菌鸡蛋|刺身|醉虾|醉蟹)/.test(text)) flags.push('RAW_OR_UNDERCOOKED')
  if (/(治[疗愈]|抗癌|排毒|降血糖|降血压|减肥|孕妇|婴儿)/.test(text)) flags.push('HEALTH_CLAIM_OR_SPECIAL_POPULATION')
  if (/(参考[资来视]|改编|转载|版权|教程|教学|推介|品牌)/.test(text)) flags.push('THIRD_PARTY_OR_BRAND_REFERENCE')
  if (raw.duration_min > 180 || raw.steps.some(item => item.duration_sec > 10800)) flags.push('LONG_PREPARATION')
  if (raw.steps.some(item => item.duration_sec > raw.duration_min * 60)) flags.push('DURATION_BASIS_REVIEW')
  if (raw.servings && raw.servings.base > 12) flags.push('LARGE_BATCH')
  return flags
}
function analyze(index, records) {
  array(index, 1, 1000); array(records, 1, 1000)
  requireValue(index.length === records.length, 'COUNT_MISMATCH')
  const indexes = new Map(); const ids = new Set(); const paths = new Map()
  index.forEach(row => {
    requireValue(row && typeof row.id === 'string' && ID_PATTERN.test(row.id), 'INVALID_INDEX_ID')
    requireValue(!indexes.has(row.id), 'DUPLICATE_INDEX_ID')
    indexes.set(row.id, row)
  })
  records.forEach(row => {
    requireValue(row && typeof row.id === 'string' && ID_PATTERN.test(row.id), 'INVALID_ID')
    requireValue(!ids.has(row.id), 'DUPLICATE_RECORD_ID'); ids.add(row.id)
    requireValue(indexes.has(row.id), 'MISSING_SOURCE_INDEX')
    if (typeof row.markdown_path === 'string') {
      // Case/Unicode variants of a Windows-visible path cannot silently create duplicate recipes.
      const key = row.markdown_path.normalize('NFC').toLowerCase()
      paths.set(key, (paths.get(key) || 0) + 1)
    }
  })
  const candidates = []; const quarantined = []
  records.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).forEach(raw => {
    const sourceHash = recordHash(raw)
    try {
      const indexRow = indexes.get(raw.id)
      const record = convertRecord(raw, indexRow)
      requireValue(paths.get(raw.markdown_path.normalize('NFC').toLowerCase()) === 1, 'DUPLICATE_SOURCE_PATH')
      candidates.push({ record, provenance: {
        source_project: 'HowToCook', source_repository: 'https://github.com/Anduin2017/HowToCook',
        source_commit: 'unknown', source_verification_commit: source.SOURCE_VERIFICATION_COMMIT,
        source_path: raw.markdown_path, source_path_verified: false,
        dataset_project: 'zkeq/vibe-cook-backend', dataset_repository: 'https://github.com/zkeq/vibe-cook-backend',
        dataset_branch: 'dataset', dataset_commit: source.DATASET_COMMIT,
        dataset_index_path: 'json/index.json', dataset_record_path: `json/recipes.json#id=${raw.id}`,
        dataset_individual_path: indexRow.json_path, license_name: 'The Unlicense',
        license_file_url: `https://github.com/zkeq/vibe-cook-backend/blob/${source.DATASET_COMMIT}/LICENSE`,
        license_text_sha256: source.LICENSE_SHA256, source_index_sha256: recordHash(indexRow),
        source_record_sha256: sourceHash, imported_record_sha256: recordHash(record),
        importer_version: IMPORTER_VERSION, imported_at: IMPORTED_AT,
        transformations: TRANSFORMATIONS.slice(), image_policy: 'excluded',
        review_status: { license: 'pending-input-integrity', structure: 'passed',
          content: 'pending', health: 'pending-not-medical-advice' },
        review_flags: contentFlags(raw),
      } })
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error
      // Never log source text, filenames taken from the source, or untrusted exception messages.
      quarantined.push({ id: raw.id, source_record_sha256: sourceHash, reason: error.code })
    }
  })
  return { importerVersion: IMPORTER_VERSION, datasetCommit: source.DATASET_COMMIT,
    importedAt: IMPORTED_AT, inputCount: records.length, candidates, quarantined,
    inputIntegrityVerified: false, releaseReady: false, runtimeCatalogWritten: false }
}
function verifyBytes(name, buffer) {
  const spec = source.INPUTS.find(item => item.name === name)
  requireValue(spec && Buffer.isBuffer(buffer) && buffer.length === spec.bytes
    && sha256(buffer) === spec.sha256, 'INPUT_INTEGRITY_FAILED')
  return spec
}
function safeDirectory(root, segments) {
  // Root is the checkout, never an arbitrary user-provided cleanup/write path.
  const absoluteRoot = fs.realpathSync(root)
  let current = absoluteRoot
  segments.forEach(segment => {
    requireValue(/^[a-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..', 'INVALID_DIRECTORY')
    current = path.join(current, segment)
    if (!fs.existsSync(current)) fs.mkdirSync(current)
    requireValue(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink(), 'UNSAFE_DIRECTORY')
    const relative = path.relative(absoluteRoot, fs.realpathSync(current))
    requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'UNSAFE_DIRECTORY')
  })
  return current
}
function readInputs(directory) {
  const actual = fs.readdirSync(directory).sort()
  requireValue(canonical(actual) === canonical(source.INPUTS.map(item => item.name).sort()), 'UNEXPECTED_INPUT_FILES')
  const buffers = {}
  source.INPUTS.forEach(spec => {
    const filename = path.join(directory, spec.name)
    const stat = fs.lstatSync(filename)
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size === spec.bytes, 'UNSAFE_INPUT_FILE')
    const bytes = fs.readFileSync(filename)
    verifyBytes(spec.name, bytes); buffers[spec.name] = bytes
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return { index: JSON.parse(decoder.decode(buffers['index.json'])), records: JSON.parse(decoder.decode(buffers['recipes.json'])) }
}
function writeIfSameOrMissing(filename, text) {
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename)
    requireValue(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_OUTPUT_FILE')
    requireValue(fs.readFileSync(filename, 'utf8') === text, 'OUTPUT_CONFLICT')
    return
  }
  fs.writeFileSync(filename, text, { flag: 'wx', encoding: 'utf8' })
}
function main() {
  requireValue(process.argv.length === 2, 'NO_CUSTOM_PATHS_OR_NETWORK_OPTIONS')
  const root = path.resolve(__dirname, '..')
  const directory = safeDirectory(root, ['.local', 'recipe-catalog', source.DATASET_COMMIT, 'inputs'])
  const { index, records } = readInputs(directory)
  const result = analyze(index, records)
  result.inputIntegrityVerified = true
  result.candidates.forEach(item => { item.provenance.review_status.license = 'verified-fixed-snapshot' })
  const output = safeDirectory(root, ['.local', 'recipe-catalog', source.DATASET_COMMIT,
    `review-v${IMPORTER_VERSION}-${recordHash(result).slice(0, 12)}`])
  const report = { importerVersion: result.importerVersion, datasetCommit: result.datasetCommit,
    importedAt: result.importedAt, inputCount: result.inputCount, candidateCount: result.candidates.length,
    quarantined: result.quarantined, inputIntegrityVerified: true, releaseReady: false, runtimeCatalogWritten: false,
    reviewFlags: result.candidates.filter(item => item.provenance.review_flags.length).map(item => ({
      id: item.record.id, flags: item.provenance.review_flags,
    })) }
  writeIfSameOrMissing(path.join(output, 'candidates.json'), JSON.stringify(result.candidates, null, 2) + '\n')
  writeIfSameOrMissing(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ inputCount: report.inputCount, candidateCount: report.candidateCount,
    quarantineCount: report.quarantined.length, flaggedCount: report.reviewFlags.length,
    releaseReady: false, runtimeCatalogWritten: false }))
}
if (require.main === module) {
  try { main() } catch (error) {
    console.error(error instanceof CatalogError ? error.code : 'CATALOG_PREPARATION_FAILED')
    process.exitCode = 1
  }
}
module.exports = { IMPORTER_VERSION, IMPORTED_AT, CatalogError, canonical, sha256, recordHash,
  convertRecord, analyze, verifyBytes, safeDirectory, readInputs, writeIfSameOrMissing }
