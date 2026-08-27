'use strict'

const assert = require('assert')
const test = require('node:test')

const implementations = [
  ['auth', require('../auth/not-found')],
  ['health', require('../health/not-found')],
  ['privacy', require('../privacy/not-found')],
  ['userData', require('../userData/not-found')],
  ['membership', require('../membership/not-found')],
  ['aiPlanner', require('./not-found')],
  ['mealAiMaintenance', require('../mealAiMaintenance/not-found')],
]

for (const [name, { notFound, notFoundIdentifier, notFoundIdentifiers }] of implementations) {
  test(`${name}: recognizes supported document-not-found forms`, () => {
    assert.strictEqual(notFound('DATABASE_DOCUMENT_NOT_FOUND'), true)
    assert.strictEqual(notFound('document with _id user-1 does not exist'), true)
    assert.strictEqual(notFound(new Error('document does not exist')), true)
    assert.strictEqual(notFound(new Error('DATABASE_DOCUMENT_NOT_FOUND')), true)
    assert.strictEqual(notFound({ code: 'DATABASE_DOCUMENT_NOT_FOUND' }), true)
    assert.strictEqual(notFound({ errMsg: 'document with _id user-2 does not exist' }), true)
    assert.strictEqual(notFound({
      errCode: -1,
      message: 'document.get:fail document with _id user-3 does not exist',
      errMsg: 'document.get:fail document with _id user-3 does not exist',
    }), true)
    assert.strictEqual(notFound({
      code: -1,
      errMsg: 'document.get:fail document does not exist',
    }), true)
    assert.deepStrictEqual(notFoundIdentifiers({
      code: -1, errCode: -1, message: 'first', errMsg: 'second',
    }), ['-1', '-1', 'first', 'second'])
  })

  test(`${name}: keeps collection and unrelated failures visible`, () => {
    const collectionMissing = { code: -502005, message: 'collection does not exist' }
    assert.strictEqual(notFoundIdentifier(collectionMissing), '-502005')
    assert.strictEqual(notFound(collectionMissing), false)
    assert.strictEqual(notFound({
      code: '-502005',
      message: 'document.get:fail document with _id user-4 does not exist',
    }), false)
    assert.strictEqual(notFound({
      code: -1,
      errCode: '-502005',
      errMsg: 'document.get:fail document with _id user-5 does not exist',
    }), false)
    assert.strictEqual(notFound('collection does not exist'), false)
    assert.strictEqual(notFound('resource not found'), false)
    assert.strictEqual(notFound({ code: 'PERMISSION_DENIED', message: 'permission denied' }), false)
    assert.strictEqual(notFound({ errCode: -1, errMsg: 'network timeout' }), false)
    assert.strictEqual(notFound({ message: 'database.get:fail document with _id user-6 does not exist' }), false)
  })
}
