'use strict'

// Public, bundled reference data only. No user state, storage, AI or HTTP access.
const PAGE_SIZE = 12
function normalize(value) {
  let text = typeof value === 'string' ? value.slice(0, 50) : ''
  if (typeof text.normalize === 'function') text = text.normalize('NFKC')
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}
function searchable(value) {
  const text = String(value)
  return (typeof text.normalize === 'function' ? text.normalize('NFKC') : text).toLowerCase()
}
function createIndex(records) {
  if (!Array.isArray(records)) throw new Error('CATALOG_UNAVAILABLE')
  const ids = new Set()
  return records.map(record => {
    if (!record || typeof record.id !== 'string' || !/^[a-z0-9_-]+$/.test(record.id) || ids.has(record.id)
      || typeof record.title !== 'string' || !Array.isArray(record.ingredients)) throw new Error('CATALOG_UNAVAILABLE')
    ids.add(record.id)
    return { record, text: searchable([record.title, ...record.ingredients.map(item => item.name)].join(' ')) }
  })
}
function categories(index) {
  return ['全部分类', ...Array.from(new Set(index.map(item => item.record.category)))]
}
function search(index, query, category, limit = PAGE_SIZE) {
  const terms = normalize(query).split(' ').filter(Boolean)
  const matches = index.filter(item => (!category || item.record.category === category)
    && terms.every(term => item.text.includes(term)))
  const end = Math.max(PAGE_SIZE, Math.min(index.length || PAGE_SIZE, Number.isInteger(limit) ? limit : PAGE_SIZE))
  return { total: matches.length, hasMore: matches.length > end,
    rows: matches.slice(0, end).map(({ record }) => ({ id: record.id, title: record.title, category: record.category,
      ingredientsText: record.ingredients.slice(0, 4).map(item => item.name).join('、') + (record.ingredients.length > 4 ? '等' : '') })) }
}
function find(index, id) { return typeof id === 'string' ? (index.find(item => item.record.id === id) || {}).record || null : null }
function load() {
  const records = require('../data/recipe-catalog')
  const meta = require('../data/recipe-catalog-meta')
  if (records.length !== meta.count) throw new Error('CATALOG_UNAVAILABLE')
  return { index: createIndex(records), meta }
}
function sourceFor(meta, id) {
  const record = meta.records.find(item => item.id === id)
  if (!record) return null
  return { path: record.path, url: meta.sourceRepository + '/blob/' + meta.sourceVerificationCommit + '/'
    + record.path.split('/').map(encodeURIComponent).join('/') }
}
module.exports = { PAGE_SIZE, normalize, createIndex, categories, search, find, load, sourceFor }
