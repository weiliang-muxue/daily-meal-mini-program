'use strict'

const assert = require('assert')
const {
  storageDeleteNeedsIndividualRetry, storageDeleteSucceeded, storageFileMissing,
} = require('./storage-delete')

for (const missing of [
  'STORAGE_FILE_NONEXIST',
  'storage file not exist',
  { code: 'STORAGE_FILE_NONEXIST' },
  { code: 'TCB_STORAGE_FILE_NOT_EXISTS', message: 'storage file not exists' },
  { errCode: -503003, errMsg: 'deleteFile:fail -503003 storage file not exists. storage file not exist' },
  { status: -503003, errMsg: 'storage file not exists' },
  { errCode: 'STORAGE_FILE_NONEXIST', errMsg: 'storage file not exist' },
  { status: -1, errMsg: 'deleteFile:fail storage file does not exist' },
  { status: -1, message: 'cloud.deleteFile:fail storage file not exist' },
]) assert.strictEqual(storageFileMissing(missing), true)

for (const failure of [
  null,
  '',
  { status: -1 },
  { code: 'PERMISSION_DENIED', errMsg: 'storage file not exist' },
  { code: 'STORAGE_FILE_NONEXIST', errMsg: 'permission denied' },
  { status: -503002, errMsg: 'storage file not exists' },
  { code: 'STORAGE_REQUEST_FAIL', message: 'storage request fail' },
  { errMsg: 'file not found' },
  { errMsg: 'document does not exist' },
]) assert.strictEqual(storageFileMissing(failure), false)

const files = ['cloud://env/a', 'cloud://env/b']
assert.strictEqual(storageDeleteSucceeded({ fileList: [
  { fileID: files[0], status: 0, errMsg: 'ok' },
  { fileID: files[1], status: -503003, errMsg: 'storage file not exists' },
] }, files), true)
assert.strictEqual(storageDeleteSucceeded({ fileList: [
  { fileID: files[0], status: 0, errMsg: 'ok' },
] }, files), false, '批量响应缺项不能误报删除完成')
assert.strictEqual(storageDeleteSucceeded({ fileList: [
  { fileID: files[0], status: 0, errMsg: 'ok' },
  { fileID: 'cloud://env/other', status: 0, errMsg: 'ok' },
] }, files), false, '批量响应文件不匹配不能误报删除完成')
assert.strictEqual(storageDeleteSucceeded({
  code: 'STORAGE_FILE_NONEXIST', message: 'storage file not exist',
}, [files[0]]), true)
assert.strictEqual(storageDeleteSucceeded({
  code: 'STORAGE_FILE_NONEXIST', message: 'storage file not exist',
}, files), false, '多文件请求的顶层缺失不能证明每个文件均已删除')
assert.strictEqual(storageDeleteNeedsIndividualRetry({
  code: 'STORAGE_FILE_NONEXIST', message: 'storage file not exist',
}, files), true, '多文件顶层缺失必须逐文件确认')
assert.strictEqual(storageDeleteNeedsIndividualRetry({ fileList: [
  { fileID: files[0], status: 0, errMsg: 'ok' },
] }, files), true, '多文件缺项响应必须逐文件确认')
assert.strictEqual(storageDeleteNeedsIndividualRetry({
  code: 'STORAGE_REQUEST_FAIL', message: 'storage request fail',
}, files), false, '明确的顶层真实失败不得伪装成可降级歧义响应')
assert.strictEqual(storageDeleteNeedsIndividualRetry({ fileList: [
  { fileID: files[0], status: 0, errMsg: 'ok' },
  { fileID: files[1], status: 0, errMsg: 'ok' },
] }, files), false, '完整成功响应不需要重复删除')

console.log('privacy storage deletion classification tests passed')
