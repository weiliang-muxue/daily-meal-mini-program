'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const importer = require('./recipe-catalog-import')
const pinned = require('./recipe-catalog-source')
const builder = require('./build-recipe-catalog')
const catalog = require('../miniprogram/services/recipe-catalog')
const records = require('../miniprogram/data/recipe-catalog')
const meta = require('../miniprogram/data/recipe-catalog-meta')
const review = require('../docs/recipe-catalog-review.json')
const provenance = require('../docs/recipe-catalog-provenance.json')
const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
const copy = value => JSON.parse(JSON.stringify(value))
const data = catalog.load()

test('catalog, editorial decisions, fixed provenance and complete licenses agree', () => {
  assert.equal(meta.count, records.length); assert.equal(meta.count, review.approved.length)
  assert.equal(meta.dataSha256, importer.recordHash(records)); assert.equal(meta.reviewSha256, importer.recordHash(review))
  assert.equal(meta.datasetCommit, pinned.DATASET_COMMIT); assert.equal(meta.sourceCommit, 'unknown')
  assert.equal(meta.sourceVerificationCommit, pinned.SOURCE_VERIFICATION_COMMIT)
  assert.equal(meta.reviewedCount, review.approved.length + review.deferred.length)
  assert.equal(meta.pendingCount + meta.reviewedCount, meta.candidateCount)
  assert.equal(meta.candidateCount + meta.quarantinedCount, 364)
  for (const record of records) {
    const accepted = review.approved.find(item => item.id === record.id)
    const source = provenance.records.find(item => item.dataset_record_path.endsWith('#id=' + record.id))
    assert(accepted); assert(source); assert.equal(accepted.recordHash, importer.recordHash(record))
    assert.equal(source.source_record_sha256, accepted.sourceHash)
    assert.equal(source.source_path, accepted.sourcePath); assert.equal(source.source_verification_blob, accepted.sourceBlob)
    assert.equal(source.source_path_verified, true)
    assert.equal(source.review_status.content, 'assistant-editorial-reference-review')
    assert.equal(source.review_status.health, 'not-clinically-validated')
    assert(!review.deferred.some(item => item.id === record.id))
    assert.equal(catalog.sourceFor(meta, record.id).path, accepted.sourcePath)
  }
  for (const filename of ['howtocook', 'vibe-cook-dataset']) {
    const license = read('docs/licenses/' + filename + '.LICENSE.txt')
    assert.equal(importer.sha256(Buffer.from(license)), pinned.LICENSE_SHA256)
    assert.equal(meta.licenseText, license)
  }
  const notice = read('NOTICE')
  for (const expected of [pinned.DATASET_COMMIT, pinned.SOURCE_VERIFICATION_COMMIT, 'unknown', 'The Unlicense', 'No BUSL', 'No personal']) assert(notice.includes(expected))
})

// Public checked-in inputs reconstruct build selection; the separate --check command
// re-imports the exact pinned raw data. These tests need no private cache or network.
function analysisFixture() {
  return { datasetCommit: pinned.DATASET_COMMIT, importerVersion: importer.IMPORTER_VERSION,
    candidates: records.map(record => ({ record: copy(record), provenance: copy(provenance.records.find(item => item.dataset_record_path.endsWith('#id=' + record.id))) }))
      .concat(review.deferred.map(item => ({ record: { id: item.id } })))
      .concat(Array.from({ length: meta.pendingCount }, (_, i) => ({ record: { id: 'unreviewed_' + i } }))),
    quarantined: Array.from({ length: meta.quarantinedCount }, () => ({})) }
}
test('build is deterministic and writes only the fixed public output set', () => {
  const a = builder.createCatalog(analysisFixture(), review), b = builder.createCatalog(analysisFixture(), copy(review))
  assert.deepEqual(a, b)
  const files = builder.buildFiles(a, Buffer.from(meta.licenseText))
  assert.deepEqual(Object.keys(files).sort(), ['miniprogram/data/recipe-catalog.js', 'miniprogram/data/recipe-catalog-meta.js',
    'docs/recipe-catalog-provenance.json', 'docs/licenses/vibe-cook-dataset.LICENSE.txt',
    'docs/licenses/howtocook.LICENSE.txt', 'NOTICE'].sort())
  for (const [filename, text] of Object.entries(files)) assert.equal(read(filename), text, filename + ' drift')
})
test('missing evidence, stale hashes, duplicate choices and unknown records fail closed', () => {
  const bad = [r => { r.datasetCommit = '0'.repeat(40) }, r => { r.importerVersion = 'wrong' },
    r => { r.approved = [] }, r => { r.approved[0].sourceHash = '0'.repeat(64) },
    r => { r.approved[0].recordHash = '0'.repeat(64) }, r => { r.approved[0].sourcePath = 'wrong.md' },
    r => { r.approved[0].sourceBlob = 'bad' }, r => { r.approved[0].reason = '' },
    r => { r.approved[0].id = 'unknown' }, r => { r.approved.push(r.approved[0]) },
    r => { r.deferred.push(r.deferred[0]) }, r => { r.deferred.push(r.approved[0]) },
    r => { r.deferred[0].reason = '' }, r => { r.reviewedAt = '' }, r => { r.reviewScope = '' },
    r => { r.sourceVerification = 'unproven' }]
  for (const change of bad) { const r = copy(review); change(r); assert.throws(() => builder.createCatalog(analysisFixture(), r), /CATALOG_/) }
  const a = analysisFixture(); a.candidates[0].record.title += 'changed'
  assert.throws(() => builder.createCatalog(a, review), /CATALOG_REVIEW_STALE/)
  assert.throws(() => builder.buildFiles(builder.createCatalog(analysisFixture(), review), Buffer.from('not a license')))
})
test('runtime record fields stay text-only and are not a nutrition or shopping schema', () => {
  const keys = ['id', 'title', 'category', 'durationMinutes', 'servings', 'ingredients', 'tools', 'steps', 'tips'].sort()
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), keys)
    assert(record.ingredients.every(item => typeof item.amount === 'string'))
    // WXML uses these explicit stable keys, not a nonexistent `index` field.
    for (const keys of [record.ingredients.map(x => x.name), record.steps.map(x => x.title),
      record.tools, record.tips, ...record.steps.map(x => x.tips)]) assert.equal(new Set(keys).size, keys.length)
    assert(!/https?:|<script|cover_image|overview_image|"formula"|"calories"/.test(JSON.stringify(record)))
  }
  assert.equal(meta.quantityPolicy, 'verbatim-no-conversion'); assert.equal(meta.personalized, false)
})
test('literal AND search, full ingredient indexing, normalization and category filters', () => {
  assert(catalog.search(data.index, '豆腐').total >= 1)
  const result = catalog.search(data.index, '豆腐 葱')
  assert(result.total > 0)
  for (const row of result.rows) {
    const item = data.index.find(x => x.record.id === row.id)
    assert(item.text.includes('豆腐') && item.text.includes('葱'))
  }
  assert.equal(catalog.search(data.index, '不在库里的测试食材').total, 0)
  assert.equal(catalog.search(data.index, '.*').total, 0, 'input is not a regex')
  assert.equal(catalog.normalize('  ＴＥＳＴ　Ａ  '), 'test a')
  assert(catalog.search(data.index, '', '早餐').rows.every(item => item.category === '早餐'))
  assert.equal(catalog.search(data.index, '', 'invalid').total, 0)
  assert.equal(catalog.find(data.index, '__proto__'), null)
  assert.equal(catalog.sourceFor(meta, 'missing'), null)
  assert.equal(catalog.normalize('x'.repeat(100)).length, 50)
})
test('batch rendering, no input mutation, duplicate IDs and malformed IDs rejected', () => {
  const fixture = Array.from({ length: 31 }, (_, i) => ({ ...copy(records[0]), id: 'fixture_' + i,
    title: '虚构批次 ' + i, ingredients: [...copy(records[0].ingredients), { name: '最后食材' }] }))
  const before = copy(fixture), index = catalog.createIndex(fixture)
  assert.equal(catalog.search(index, '').rows.length, 12)
  assert.equal(catalog.search(index, '', '', 24).rows.length, 24)
  assert.equal(catalog.search(index, '', '', 36).hasMore, false)
  assert.equal(catalog.search(index, '最后食材').total, 31)
  assert.deepEqual(fixture, before)
  assert.throws(() => catalog.createIndex([records[0], records[0]]))
  assert.throws(() => catalog.createIndex([{ ...records[0], id: '../bad' }]))
  assert.deepEqual(catalog.search([], ''), { total: 0, hasMore: false, rows: [] })
})
test('bundled data stays below an explicit initial-batch size cap', () => {
  const bytes = ['miniprogram/data/recipe-catalog.js', 'miniprogram/data/recipe-catalog-meta.js']
    .reduce((sum, file) => sum + Buffer.byteLength(read(file)), 0)
  assert(bytes < 150 * 1024, 'expand via deliberate package review, not unbounded data growth')
})
