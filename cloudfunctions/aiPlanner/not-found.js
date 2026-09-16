'use strict'

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value)
}

function notFoundIdentifiers(error) {
  if (typeof error === 'string') return [error]
  if (!error || typeof error !== 'object') return []
  return ['code', 'errCode', 'message', 'errMsg']
    .map((field) => stringValue(error[field]))
    .filter(Boolean)
}

function notFoundIdentifier(error) {
  return notFoundIdentifiers(error)[0] || ''
}

function documentMissingMessage(identifier) {
  return identifier === 'DATABASE_DOCUMENT_NOT_FOUND'
    || /^(?:document\.get:fail )?document with _id .+ does not exist$/i.test(identifier)
    || /^(?:document\.get:fail )?document does not exist$/i.test(identifier)
}

function notFound(error) {
  if (typeof error === 'string') return error === 'DATABASE_DOCUMENT_NOT_FOUND' || documentMissingMessage(error)
  if (!error || typeof error !== 'object') return false
  const codes = ['code', 'errCode'].map((field) => stringValue(error[field])).filter(Boolean)
  if (codes.some((code) => code !== '-1' && code !== 'DATABASE_DOCUMENT_NOT_FOUND')) return false
  if (codes.includes('DATABASE_DOCUMENT_NOT_FOUND')) return true
  return ['message', 'errMsg']
    .map((field) => stringValue(error[field]))
    .some(documentMissingMessage)
}

module.exports = { notFound, notFoundIdentifier, notFoundIdentifiers }
