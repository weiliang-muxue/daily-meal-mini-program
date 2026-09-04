'use strict'

const STORAGE_FILE_NONEXIST = 'STORAGE_FILE_NONEXIST'
const STORAGE_FILE_NONEXIST_STATUS = '-503003'
const STORAGE_FILE_NONEXIST_CODES = new Set([
  STORAGE_FILE_NONEXIST, 'TCB_STORAGE_FILE_NOT_EXISTS', STORAGE_FILE_NONEXIST_STATUS,
])

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function missingMessage(value) {
  const message = stringValue(value)
  return /^(?:(?:cloud\.)?deleteFile:fail )?storage file (?:not exist|not exists|does not exist)$/i.test(message)
    || /^deleteFile:fail -503003 storage file not exists\. storage file (?:not exist|not exists)$/i.test(message)
}

function storageFileMissing(error) {
  if (typeof error === 'string') {
    const value = error.trim()
    return STORAGE_FILE_NONEXIST_CODES.has(value) || missingMessage(value)
  }
  if (!error || typeof error !== 'object') return false
  const status = stringValue(error.status)
  if (status === '0') return false
  const codes = ['code', 'errCode']
    .map((field) => stringValue(error[field]))
    .filter(Boolean)
  if (status && status !== '-1') codes.push(status)
  if (codes.some((code) => !STORAGE_FILE_NONEXIST_CODES.has(code))) return false
  const messages = ['message', 'errMsg']
    .map((field) => stringValue(error[field]))
    .filter(Boolean)
  if (messages.some((message) => !missingMessage(message))) return false
  return codes.some((code) => STORAGE_FILE_NONEXIST_CODES.has(code)) || messages.length > 0
}

function storageDeleteSucceeded(result, requestedFiles) {
  if (storageFileMissing(result)) return Array.isArray(requestedFiles) && requestedFiles.length === 1
  if (!result || !Array.isArray(result.fileList) || !Array.isArray(requestedFiles)
    || result.fileList.length !== requestedFiles.length) return false
  const requested = new Set(requestedFiles)
  const returned = new Set(result.fileList.map((item) => item && item.fileID))
  if (requested.size !== requestedFiles.length || returned.size !== requested.size
    || [...requested].some((fileID) => !returned.has(fileID))) return false
  return result.fileList.every((item) => Number(item.status) === 0 || storageFileMissing(item))
}

function explicitTopLevelFailure(result) {
  if (!result || typeof result !== 'object') return false
  const codes = ['code', 'errCode']
    .map((field) => stringValue(result[field]))
    .filter(Boolean)
  if (codes.some((code) => code !== '0')) return true
  const status = stringValue(result.status)
  return Boolean(status && status !== '0')
}

function storageDeleteNeedsIndividualRetry(result, requestedFiles) {
  if (!Array.isArray(requestedFiles) || requestedFiles.length < 2) return false
  if (storageFileMissing(result)) return true
  if (explicitTopLevelFailure(result)) return false
  if (!result || !Array.isArray(result.fileList)
    || result.fileList.length !== requestedFiles.length) return true
  const requested = new Set(requestedFiles)
  const returned = new Set(result.fileList.map((item) => item && item.fileID))
  return requested.size !== requestedFiles.length || returned.size !== requested.size
    || [...requested].some((fileID) => !returned.has(fileID))
}

module.exports = {
  storageDeleteNeedsIndividualRetry, storageDeleteSucceeded, storageFileMissing,
}
