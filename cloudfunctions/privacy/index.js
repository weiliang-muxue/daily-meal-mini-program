'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  AI_PRIVATE_COLLECTIONS, deletionMembershipState, validateDeletionControl, uniqueById,
  privateFileIds, privateUploadCleanupPlan, runDeletionSequence,
} = require('./core')
const {
  CONTROL_ID, assertOperationalControl, reviseOperationalControl, releaseInvite, removeMember,
} = require('./membership-core')
const { notFound } = require('./not-found')
const {
  storageDeleteNeedsIndividualRetry, storageDeleteSucceeded, storageFileMissing,
} = require('./storage-delete')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const CACHE_NAMESPACE_PATTERN = /^[a-f0-9]{32}$/

function staleDataGenerationError() {
  const error = new Error('账号数据版本已变化，请刷新后重试')
  error.code = 'STALE_DATA_GENERATION'
  return error
}

function assertExpectedCacheNamespace(member, expectedCacheNamespace) {
  if (!CACHE_NAMESPACE_PATTERN.test(expectedCacheNamespace || '')
    || !CACHE_NAMESPACE_PATTERN.test(member && member.cacheNamespace || '')
    || member.cacheNamespace !== expectedCacheNamespace) {
    throw staleDataGenerationError()
  }
  return member
}

function assertDeletingGeneration(member, expectedCacheNamespace) {
  assertExpectedCacheNamespace(member, expectedCacheNamespace)
  if (member.status !== 'deleting') membershipInvariant('成员清理状态异常，无法安全删除私人数据')
  return member
}

async function getDocument(collection, id, transaction) {
  const source = transaction ? transaction.collection(collection) : db.collection(collection)
  try { return (await source.doc(id).get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

async function queryAll(collection, criteria) {
  const records = []
  while (true) {
    const result = await db.collection(collection).where(criteria).skip(records.length).limit(100).get()
    records.push(...result.data)
    if (result.data.length < 100) return records
  }
}

async function listActiveMembers() {
  return queryAll('meal_members', { status: 'active' })
}

async function listRelatedInvites(openid) {
  const [created, used] = await Promise.all([
    queryAll('meal_invites', { createdBy: openid }),
    queryAll('meal_invites', { usedBy: openid }),
  ])
  return uniqueById([...created, ...used])
}

async function readDeletionMember(openid, expectedCacheNamespace, requireDeleting = false) {
  return db.runTransaction(async (transaction) => {
    const member = await getDocument('meal_members', openid, transaction)
    if (!requireDeleting) return assertExpectedCacheNamespace(member, expectedCacheNamespace)
    const deleting = assertDeletingGeneration(member, expectedCacheNamespace)
    assertOperationalControl(await getDocument('meal_members', CONTROL_ID, transaction))
    return deleting
  })
}

function privateDocumentTargets(openid, data) {
  const {
    health, avatarTickets, photoTickets, aiTasks, aiShards, aiControls,
  } = data
  const targets = [
    { collection: 'meal_users', id: openid },
    { collection: 'meal_user_states', id: openid },
  ]
  ;[
    ['health_daily', health],
    ['meal_avatar_uploads', avatarTickets],
    ['health_photo_uploads', photoTickets],
    [AI_PRIVATE_COLLECTIONS[0], aiTasks],
    [AI_PRIVATE_COLLECTIONS[1], aiShards],
    [AI_PRIVATE_COLLECTIONS[2], aiControls],
  ].forEach(([collection, records]) => {
    uniqueById(records).forEach((record) => targets.push({ collection, id: record._id }))
  })
  const seen = new Set()
  return targets.filter((target) => {
    const key = `${target.collection}:${target.id}`
    if (!target.id || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function removePrivateDocuments(openid, data, expectedCacheNamespace) {
  const targets = privateDocumentTargets(openid, data)
  for (let index = 0; index < targets.length; index += 15) {
    const batch = targets.slice(index, index + 15)
    await db.runTransaction(async (transaction) => {
      const member = await getDocument('meal_members', openid, transaction)
      assertDeletingGeneration(member, expectedCacheNamespace)
      for (const target of batch) {
        try { await transaction.collection(target.collection).doc(target.id).remove() }
        catch (error) { if (!notFound(error)) throw error }
      }
    })
  }
}

async function deleteSingleFile(fileID, assertCurrentGeneration) {
  await assertCurrentGeneration()
  let result
  let deleteError = null
  try { result = await cloud.deleteFile({ fileList: [fileID] }) }
  catch (error) { deleteError = error }
  await assertCurrentGeneration()
  if (deleteError) {
    if (storageFileMissing(deleteError)) return
    throw deleteError
  }
  if (!storageDeleteSucceeded(result, [fileID])) throw fileDeleteFailed()
}

async function deleteFiles(values, assertCurrentGeneration) {
  const files = [...new Set(values.filter((value) => typeof value === 'string' && value.startsWith('cloud://')))]
  for (let index = 0; index < files.length; index += 50) {
    const batch = files.slice(index, index + 50)
    await assertCurrentGeneration()
    let result
    let deleteError = null
    try { result = await cloud.deleteFile({ fileList: batch }) }
    catch (error) { deleteError = error }
    await assertCurrentGeneration()
    if (!deleteError && storageDeleteSucceeded(result, batch)) continue
    const retryIndividually = batch.length > 1 && (
      (deleteError && storageFileMissing(deleteError))
      || (!deleteError && storageDeleteNeedsIndividualRetry(result, batch))
    )
    if (retryIndividually) {
      await assertCurrentGeneration()
      for (const fileID of batch) await deleteSingleFile(fileID, assertCurrentGeneration)
      await assertCurrentGeneration()
      continue
    }
    if (deleteError) throw deleteError
    throw fileDeleteFailed()
  }
}

function fileDeleteFailed() {
  const error = new Error('部分私人云文件删除失败，请重试')
  error.code = 'FILE_DELETE_FAILED'
  return error
}

async function deleteUploadedPlaceholder(fileID) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) throw fileDeleteFailed()
  let result
  try { result = await cloud.deleteFile({ fileList: [fileID] }) }
  catch (error) {
    if (storageFileMissing(error)) return
    throw fileDeleteFailed()
  }
  if (!storageDeleteSucceeded(result, [fileID])) throw fileDeleteFailed()
}

async function reclaimOrphanPaths(paths, assertCurrentGeneration) {
  for (const path of [...new Set(paths)]) {
    await assertCurrentGeneration()
    const placeholder = await cloud.uploadFile({ cloudPath: path, fileContent: Buffer.from([0]) })
    let generationError = null
    try { await assertCurrentGeneration() } catch (error) { generationError = error }

    // Once uploadFile succeeds, this request owns the placeholder it created.
    // Compensate it even if the identity generation changed while uploadFile
    // was pending; otherwise a stale request can leave a new private object.
    await deleteUploadedPlaceholder(placeholder && placeholder.fileID)
    if (generationError) throw generationError
    await assertCurrentGeneration()
  }
}

function assertMembershipSnapshot(records, openid) {
  const active = records.filter((item) => item && item.status === 'active')
  const deleting = active.find((item) => item._id === openid)
  if (!deleting) return
  const owners = active.filter((item) => item.role === 'owner')
  if (owners.length !== 1) {
    const error = new Error('成员管理员状态异常，无法安全删除账号')
    error.code = 'MEMBERSHIP_INVARIANT_FAILED'
    throw error
  }
}

async function prepareMembershipDeletion(openid, expectedCacheNamespace) {
  const current = await readDeletionMember(openid, expectedCacheNamespace)
  if (current.status === 'deleting') return
  if (current.status !== 'active') {
    return db.runTransaction(async (transaction) => {
      const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
      const memberReference = transaction.collection('meal_members').doc(openid)
      const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
      const fresh = await getDocument('meal_members', openid, transaction)
      assertExpectedCacheNamespace(fresh, expectedCacheNamespace)
      if (fresh.status === 'deleting') return
      if (fresh.status === 'active') {
        const error = new Error('成员状态已变化，请重试删除')
        error.code = 'MEMBERSHIP_INVARIANT_FAILED'
        throw error
      }
      const nextControl = reviseOperationalControl(rawControl)
      await memberReference.update({ data: {
        status: 'deleting', role: 'member', preserveOwnerAfterClear: false, updatedAt: db.serverDate(),
      } })
      await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    })
  }

  const snapshot = await listActiveMembers()
  assertMembershipSnapshot(snapshot, openid)
  const deletionState = deletionMembershipState(snapshot, openid)
  if (deletionState.transferRequired) {
    const error = new Error('请先将管理员身份明确转移给另一名成员，再删除账号')
    error.code = 'OWNER_TRANSFER_REQUIRED'
    throw error
  }
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const memberReference = transaction.collection('meal_members').doc(openid)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
    const freshCurrent = await getDocument('meal_members', openid, transaction)
    assertExpectedCacheNamespace(freshCurrent, expectedCacheNamespace)
    if (freshCurrent.status === 'deleting') return
    if (freshCurrent.status !== 'active') throw new Error('成员状态已变化，请重试删除')

    const freshRecords = [{ ...freshCurrent, _id: openid }]
    for (const record of snapshot) {
      if (record._id === openid) continue
      const fresh = await getDocument('meal_members', record._id, transaction)
      if (fresh) freshRecords.push({ ...fresh, _id: record._id })
    }
    assertMembershipSnapshot(freshRecords, openid)

    const freshDeletionState = deletionMembershipState(freshRecords, openid)
    if (freshDeletionState.transferRequired) {
      const error = new Error('请先将管理员身份明确转移给另一名成员，再删除账号')
      error.code = 'OWNER_TRANSFER_REQUIRED'
      throw error
    }
    validateDeletionControl(freshRecords, openid, rawControl)
    const preserveOwner = freshDeletionState.deletingIsOwner
    const nextControl = preserveOwner
      ? reviseOperationalControl(rawControl)
      : removeMember(rawControl, openid)
    await memberReference.update({ data: {
      status: 'deleting', role: preserveOwner ? 'owner' : 'member',
      preserveOwnerAfterClear: preserveOwner,
      deletionRequestedAt: db.serverDate(), updatedAt: db.serverDate(),
    } })
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
  })
}

async function preflightMembershipDeletion(openid, expectedCacheNamespace) {
  const current = await readDeletionMember(openid, expectedCacheNamespace)
  if (current.status === 'deleting' || current.status !== 'active') return
  const snapshot = await listActiveMembers()
  const fresh = await readDeletionMember(openid, expectedCacheNamespace)
  if (fresh.status === 'deleting' || fresh.status !== 'active') return
  assertMembershipSnapshot(snapshot, openid)
  if (deletionMembershipState(snapshot, openid).transferRequired) {
    const error = new Error('请先将管理员身份明确转移给另一名成员，再删除账号')
    error.code = 'OWNER_TRANSFER_REQUIRED'
    throw error
  }
}

async function deactivateOwnedInvite(inviteId, openid, expectedCacheNamespace) {
  return db.runTransaction(async (transaction) => {
    const inviteReference = transaction.collection('meal_invites').doc(inviteId)
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
    assertExpectedCacheNamespace(
      await getDocument('meal_members', openid, transaction), expectedCacheNamespace,
    )
    const invite = await getDocument('meal_invites', inviteId, transaction)
    if (!invite || invite.createdBy !== openid || invite.active !== true) return false
    const nextControl = releaseInvite(rawControl)
    await inviteReference.update({ data: { active: false, revokedAt: db.serverDate(), updatedAt: db.serverDate() } })
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    return true
  })
}

async function removeRelatedInvite(inviteId, openid, expectedCacheNamespace) {
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const inviteReference = transaction.collection('meal_invites').doc(inviteId)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
    assertDeletingGeneration(
      await getDocument('meal_members', openid, transaction), expectedCacheNamespace,
    )
    const invite = await getDocument('meal_invites', inviteId, transaction)
    if (!invite || (invite.createdBy !== openid && invite.usedBy !== openid)) return false
    const nextControl = invite.active === true
      ? releaseInvite(rawControl)
      : reviseOperationalControl(rawControl)
    await inviteReference.remove()
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    return true
  })
}

function randomIdentityReference() {
  return crypto.randomBytes(16).toString('hex')
}

function membershipInvariant(message) {
  const error = new Error(message)
  error.code = 'MEMBERSHIP_INVARIANT_FAILED'
  throw error
}

async function finalizeMembershipDeletion(openid, expectedCacheNamespace) {
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const memberReference = transaction.collection('meal_members').doc(openid)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    const control = assertOperationalControl(rawControl)
    const member = await getDocument('meal_members', openid, transaction)
    if (!member && control.ownerOpenid === openid) {
      membershipInvariant('管理员成员记录缺失，无法安全完成清理')
    }
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    if (member.status === 'active') {
      membershipInvariant('成员仍处于活跃状态，无法完成删除')
    }
    if (member.status !== 'deleting') membershipInvariant('成员清理状态异常，无法安全完成删除')

    const memberIsOwner = member.role === 'owner'
    const markedForOwnerRecovery = member.preserveOwnerAfterClear === true
    const validOrdinaryMarker = member.preserveOwnerAfterClear === false
      || member.preserveOwnerAfterClear === undefined
    const controlNamesOwner = control.ownerOpenid === openid
    if (memberIsOwner || markedForOwnerRecovery || controlNamesOwner) {
      if (!memberIsOwner || !markedForOwnerRecovery || !controlNamesOwner
        || control.activeMemberCount !== 1 || control.reservedInviteCount !== 0) {
        membershipInvariant('管理员清理状态异常，无法安全恢复权限')
      }
      const now = db.serverDate()
      const nextControl = reviseOperationalControl(control)
      await memberReference.set({ data: {
        status: 'active', role: 'owner',
        memberRef: randomIdentityReference(), cacheNamespace: randomIdentityReference(),
        joinedAt: now, resetAt: now, updatedAt: now,
      } })
      await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
      return { membershipDeleted: false, ownerAccessRetained: true }
    }
    if (!validOrdinaryMarker || member.role !== 'member'
      || !control.ownerOpenid || control.activeMemberCount < 1) {
      membershipInvariant('成员清理状态异常，无法安全完成删除')
    }
    const nextControl = reviseOperationalControl(control)
    await memberReference.remove()
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    return { membershipDeleted: true, ownerAccessRetained: false }
  })
}

async function collectPrivateData(openid, expectedCacheNamespace) {
  await readDeletionMember(openid, expectedCacheNamespace, true)
  const [user, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls] = await Promise.all([
    getDocument('meal_users', openid),
    queryAll('health_daily', { owner: openid }),
    queryAll('meal_avatar_uploads', { owner: openid }),
    queryAll('health_photo_uploads', { owner: openid }),
    listRelatedInvites(openid),
    queryAll(AI_PRIVATE_COLLECTIONS[0], { owner: openid }),
    queryAll(AI_PRIVATE_COLLECTIONS[1], { owner: openid }),
    queryAll(AI_PRIVATE_COLLECTIONS[2], { owner: openid }),
  ])
  await readDeletionMember(openid, expectedCacheNamespace, true)
  return { user, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls }
}

async function listActiveOwnedInvites(openid, expectedCacheNamespace) {
  await readDeletionMember(openid, expectedCacheNamespace)
  const invites = (await listRelatedInvites(openid)).filter((item) => (
    item && item.createdBy === openid && item.active === true
  ))
  await readDeletionMember(openid, expectedCacheNamespace)
  return invites
}

async function verifyCleared(openid, expectedCacheNamespace) {
  await readDeletionMember(openid, expectedCacheNamespace, true)
  const [user, state, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls] = await Promise.all([
    getDocument('meal_users', openid),
    getDocument('meal_user_states', openid),
    queryAll('health_daily', { owner: openid }),
    queryAll('meal_avatar_uploads', { owner: openid }),
    queryAll('health_photo_uploads', { owner: openid }),
    listRelatedInvites(openid),
    queryAll(AI_PRIVATE_COLLECTIONS[0], { owner: openid }),
    queryAll(AI_PRIVATE_COLLECTIONS[1], { owner: openid }),
    queryAll(AI_PRIVATE_COLLECTIONS[2], { owner: openid }),
  ])
  if (user || state || health.length || avatarTickets.length || photoTickets.length || invites.length
    || aiTasks.length || aiShards.length || aiControls.length) {
    const error = new Error('仍有私人数据未删除，请重试')
    error.code = 'DELETE_INCOMPLETE'
    throw error
  }
  await readDeletionMember(openid, expectedCacheNamespace, true)
}

async function deletePrivateData(openid, data, expectedCacheNamespace) {
  const {
    user, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls,
  } = data
  const assertCurrentGeneration = () => readDeletionMember(openid, expectedCacheNamespace, true)
  await assertCurrentGeneration()
  const uploadCleanup = privateUploadCleanupPlan(data, openid, Date.now())
  await deleteFiles(privateFileIds(data), assertCurrentGeneration)
  await reclaimOrphanPaths(uploadCleanup.orphanPaths, assertCurrentGeneration)
  await assertCurrentGeneration()
  await removePrivateDocuments(openid, data, expectedCacheNamespace)
  for (const invite of uniqueById(invites)) {
    await removeRelatedInvite(invite._id, openid, expectedCacheNamespace)
  }
  return {
    cleared: true,
    healthRecordCount: health.length,
    inviteRecordCount: invites.length,
    aiTaskRecordCount: aiTasks.length,
    aiShardRecordCount: aiShards.length,
    aiControlRecordCount: aiControls.length,
  }
}

async function clearMyData(openid, expectedCacheNamespace) {
  return runDeletionSequence({
    preflight: () => preflightMembershipDeletion(openid, expectedCacheNamespace),
    listActiveOwnedInvites: () => listActiveOwnedInvites(openid, expectedCacheNamespace),
    deactivateInvite: (invite) => deactivateOwnedInvite(invite._id, openid, expectedCacheNamespace),
    markMembershipDeleting: () => prepareMembershipDeletion(openid, expectedCacheNamespace),
    collectPrivateData: () => collectPrivateData(openid, expectedCacheNamespace),
    deletePrivateData: (data) => deletePrivateData(openid, data, expectedCacheNamespace),
    verifyCleared: () => verifyCleared(openid, expectedCacheNamespace),
    finalizeMembership: () => finalizeMembershipDeletion(openid, expectedCacheNamespace),
  })
}

function publicError(error) {
  const messages = Object.freeze({
    OWNER_TRANSFER_REQUIRED: '请先将管理员身份明确转移给另一名成员，再删除账号',
    MEMBERSHIP_INVARIANT_FAILED: '成员数据状态异常，无法安全删除账号',
    MEMBERSHIP_NOT_INITIALIZED: '成员服务尚未初始化，请联系管理员',
    MEMBERSHIP_BOOTSTRAP_IN_PROGRESS: '管理员初始化正在进行，请稍后重试',
    FILE_DELETE_FAILED: '部分私人云文件删除失败，请重试',
    PRIVATE_UPLOAD_IN_PROGRESS: '私人图片仍在处理中，请稍后重试',
    PRIVATE_UPLOAD_STATE_INVALID: '私人图片清理状态异常，请稍后重试',
    DELETE_INCOMPLETE: '仍有私人数据未删除，请重试',
    STALE_DATA_GENERATION: '账号数据版本已变化，请刷新后重试',
  })
  const requestedCode = error && error.code
  const known = typeof requestedCode === 'string'
    && Object.prototype.hasOwnProperty.call(messages, requestedCode)
  return known
    ? {
      code: requestedCode, message: messages[requestedCode],
      ...(requestedCode === 'PRIVATE_UPLOAD_IN_PROGRESS' ? { retryable: true } : {}),
    }
    : { code: 'PRIVACY_DELETE_FAILED', message: '数据删除未完成，请重试' }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, code: 'IDENTITY_REQUIRED', message: '无法识别微信身份' }
  if (event.action !== 'clearMyData') return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的隐私操作' }
  try {
    // Deletion remains callable after membership has been revoked so a partial failure
    // can be retried without restoring access to the account.
    return { success: true, data: await clearMyData(OPENID, event.expectedCacheNamespace) }
  } catch (error) {
    console.error('privacy deletion failed', { code: error && error.code, name: error && error.name })
    return { success: false, ...publicError(error) }
  }
}

exports._test = {
  assertExpectedCacheNamespace, clearMyData, collectPrivateData, deletePrivateData,
  deleteFiles, deleteUploadedPlaceholder, reclaimOrphanPaths,
  preflightMembershipDeletion, prepareMembershipDeletion, deactivateOwnedInvite,
  removePrivateDocuments, removeRelatedInvite, finalizeMembershipDeletion,
  listActiveOwnedInvites, verifyCleared, publicError,
}
