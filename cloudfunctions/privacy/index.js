'use strict'

const cloud = require('wx-server-sdk')
const {
  AI_PRIVATE_COLLECTIONS, deletionMembershipState, validateDeletionControl, uniqueById,
  privateFileIds, privateOrphanPaths, runDeletionSequence,
} = require('./core')
const {
  CONTROL_ID, assertOperationalControl, reviseOperationalControl, releaseInvite, removeMember,
} = require('./membership-core')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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

async function removeDocument(collection, id) {
  try { await db.collection(collection).doc(id).remove() }
  catch (error) { if (!notFound(error)) throw error }
}

async function removeDocuments(collection, records) {
  const list = uniqueById(records)
  for (let index = 0; index < list.length; index += 20) {
    await Promise.all(list.slice(index, index + 20).map((item) => removeDocument(collection, item._id)))
  }
}

async function deleteFiles(values) {
  const files = [...new Set(values.filter((value) => typeof value === 'string' && value.startsWith('cloud://')))]
  for (let index = 0; index < files.length; index += 50) {
    let result
    try { result = await cloud.deleteFile({ fileList: files.slice(index, index + 50) }) }
    catch (error) { if (notFound(error)) continue; throw error }
    const failed = (result && Array.isArray(result.fileList) ? result.fileList : []).filter((item) => (
      Number(item.status) !== 0 && !notFound({ message: item.errMsg })
    ))
    if (failed.length) {
      const error = new Error('部分私人云文件删除失败，请重试')
      error.code = 'FILE_DELETE_FAILED'
      throw error
    }
  }
}

async function reclaimOrphanPaths(paths) {
  for (const path of [...new Set(paths)]) {
    const placeholder = await cloud.uploadFile({ cloudPath: path, fileContent: Buffer.from([0]) })
    await deleteFiles([placeholder.fileID])
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

async function prepareMembershipDeletion(openid) {
  const current = await getDocument('meal_members', openid)
  if (!current || current.status === 'deleting') return
  if (current.status !== 'active') {
    await db.runTransaction(async (transaction) => {
      const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
      const memberReference = transaction.collection('meal_members').doc(openid)
      const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
      const fresh = await getDocument('meal_members', openid, transaction)
      if (!fresh || fresh.status === 'deleting') return
      if (fresh.status === 'active') {
        const error = new Error('成员状态已变化，请重试删除')
        error.code = 'MEMBERSHIP_INVARIANT_FAILED'
        throw error
      }
      const nextControl = reviseOperationalControl(rawControl)
      await memberReference.update({ data: { status: 'deleting', updatedAt: db.serverDate() } })
      await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    })
    return
  }

  const snapshot = await listActiveMembers()
  assertMembershipSnapshot(snapshot, openid)
  const deletionState = deletionMembershipState(snapshot, openid)
  if (deletionState.transferRequired) {
    const error = new Error('请先将管理员身份明确转移给另一名成员，再删除账号')
    error.code = 'OWNER_TRANSFER_REQUIRED'
    throw error
  }
  await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
    const freshRecords = []
    for (const record of snapshot) {
      const fresh = await getDocument('meal_members', record._id, transaction)
      if (fresh) freshRecords.push({ ...fresh, _id: record._id })
    }
    const freshCurrent = freshRecords.find((item) => item._id === openid)
    if (!freshCurrent || freshCurrent.status === 'deleting') return
    if (freshCurrent.status !== 'active') throw new Error('成员状态已变化，请重试删除')
    assertMembershipSnapshot(freshRecords, openid)

    const freshDeletionState = deletionMembershipState(freshRecords, openid)
    if (freshDeletionState.transferRequired) {
      const error = new Error('请先将管理员身份明确转移给另一名成员，再删除账号')
      error.code = 'OWNER_TRANSFER_REQUIRED'
      throw error
    }
    validateDeletionControl(freshRecords, openid, rawControl)
    const nextControl = removeMember(rawControl, openid)
    await transaction.collection('meal_members').doc(openid).update({ data: {
      status: 'deleting', role: 'member', deletionRequestedAt: db.serverDate(), updatedAt: db.serverDate(),
    } })
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
  })
}

async function preflightMembershipDeletion(openid) {
  const current = await getDocument('meal_members', openid)
  if (!current || current.status === 'deleting' || current.status !== 'active') return
  const snapshot = await listActiveMembers()
  assertMembershipSnapshot(snapshot, openid)
  if (deletionMembershipState(snapshot, openid).transferRequired) {
    const error = new Error('请先将管理员身份明确转移给另一名成员，再删除账号')
    error.code = 'OWNER_TRANSFER_REQUIRED'
    throw error
  }
}

async function deactivateOwnedInvite(inviteId, openid) {
  return db.runTransaction(async (transaction) => {
    const inviteReference = transaction.collection('meal_invites').doc(inviteId)
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
    const invite = await getDocument('meal_invites', inviteId, transaction)
    if (!invite || invite.createdBy !== openid || invite.active !== true) return false
    const nextControl = releaseInvite(rawControl)
    await inviteReference.update({ data: { active: false, revokedAt: db.serverDate(), updatedAt: db.serverDate() } })
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    return true
  })
}

async function removeRelatedInvite(inviteId, openid) {
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const inviteReference = transaction.collection('meal_invites').doc(inviteId)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
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

async function removeMembershipDocument(openid) {
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const memberReference = transaction.collection('meal_members').doc(openid)
    const rawControl = await getDocument('meal_members', CONTROL_ID, transaction)
    assertOperationalControl(rawControl)
    const member = await getDocument('meal_members', openid, transaction)
    if (!member) return false
    if (member.status === 'active') {
      const error = new Error('成员仍处于活跃状态，无法完成删除')
      error.code = 'MEMBERSHIP_INVARIANT_FAILED'
      throw error
    }
    const nextControl = reviseOperationalControl(rawControl)
    await memberReference.remove()
    await controlReference.update({ data: { ...nextControl, updatedAt: db.serverDate() } })
    return true
  })
}

async function collectPrivateData(openid) {
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
  return { user, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls }
}

async function verifyCleared(openid) {
  const [user, state, member, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls] = await Promise.all([
    getDocument('meal_users', openid),
    getDocument('meal_user_states', openid),
    getDocument('meal_members', openid),
    queryAll('health_daily', { owner: openid }),
    queryAll('meal_avatar_uploads', { owner: openid }),
    queryAll('health_photo_uploads', { owner: openid }),
    listRelatedInvites(openid),
    queryAll(AI_PRIVATE_COLLECTIONS[0], { owner: openid }),
    queryAll(AI_PRIVATE_COLLECTIONS[1], { owner: openid }),
    queryAll(AI_PRIVATE_COLLECTIONS[2], { owner: openid }),
  ])
  if (user || state || member || health.length || avatarTickets.length || photoTickets.length || invites.length
    || aiTasks.length || aiShards.length || aiControls.length) {
    const error = new Error('仍有私人数据未删除，请重试')
    error.code = 'DELETE_INCOMPLETE'
    throw error
  }
}

async function deletePrivateData(openid, data) {
  const {
    user, health, avatarTickets, photoTickets, invites, aiTasks, aiShards, aiControls,
  } = data
  await deleteFiles(privateFileIds(data))
  await reclaimOrphanPaths(privateOrphanPaths(data, openid))
  await Promise.all([
    removeDocument('meal_users', openid),
    // The schema v5 state is one user-owned document containing activePlan, draftPlan,
    // planHistory, generationPreferences and every other meal preference.
    removeDocument('meal_user_states', openid),
    removeDocuments('health_daily', health),
    removeDocuments('meal_avatar_uploads', avatarTickets),
    removeDocuments('health_photo_uploads', photoTickets),
    removeDocuments(AI_PRIVATE_COLLECTIONS[0], aiTasks),
    removeDocuments(AI_PRIVATE_COLLECTIONS[1], aiShards),
    removeDocuments(AI_PRIVATE_COLLECTIONS[2], aiControls),
  ])
  for (const invite of uniqueById(invites)) await removeRelatedInvite(invite._id, openid)
  await removeMembershipDocument(openid)
  return {
    cleared: true,
    healthRecordCount: health.length,
    inviteRecordCount: invites.length,
    aiTaskRecordCount: aiTasks.length,
    aiShardRecordCount: aiShards.length,
    aiControlRecordCount: aiControls.length,
    membershipDeleted: true,
  }
}

async function clearMyData(openid) {
  return runDeletionSequence({
    preflight: () => preflightMembershipDeletion(openid),
    listActiveOwnedInvites: async () => (await listRelatedInvites(openid)).filter((item) => (
      item && item.createdBy === openid && item.active === true
    )),
    deactivateInvite: (invite) => deactivateOwnedInvite(invite._id, openid),
    markMembershipDeleting: () => prepareMembershipDeletion(openid),
    collectPrivateData: () => collectPrivateData(openid),
    deletePrivateData: (data) => deletePrivateData(openid, data),
    verifyCleared: () => verifyCleared(openid),
  })
}

function publicError(error) {
  const messages = Object.freeze({
    OWNER_TRANSFER_REQUIRED: '请先将管理员身份明确转移给另一名成员，再删除账号',
    MEMBERSHIP_INVARIANT_FAILED: '成员数据状态异常，无法安全删除账号',
    MEMBERSHIP_NOT_INITIALIZED: '成员服务尚未初始化，请联系管理员',
    MEMBERSHIP_BOOTSTRAP_IN_PROGRESS: '管理员初始化正在进行，请稍后重试',
    FILE_DELETE_FAILED: '部分私人云文件删除失败，请重试',
    DELETE_INCOMPLETE: '仍有私人数据未删除，请重试',
  })
  const requestedCode = error && error.code
  const known = typeof requestedCode === 'string'
    && Object.prototype.hasOwnProperty.call(messages, requestedCode)
  return known
    ? { code: requestedCode, message: messages[requestedCode] }
    : { code: 'PRIVACY_DELETE_FAILED', message: '数据删除未完成，请重试' }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, code: 'IDENTITY_REQUIRED', message: '无法识别微信身份' }
  if (event.action !== 'clearMyData') return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的隐私操作' }
  try {
    // Deletion remains callable after membership has been revoked so a partial failure
    // can be retried without restoring access to the account.
    return { success: true, data: await clearMyData(OPENID) }
  } catch (error) {
    console.error('privacy deletion failed', { code: error && error.code, name: error && error.name })
    return { success: false, ...publicError(error) }
  }
}

exports._test = {
  clearMyData, collectPrivateData, deletePrivateData,
  preflightMembershipDeletion, prepareMembershipDeletion, deactivateOwnedInvite,
  removeRelatedInvite, removeMembershipDocument, verifyCleared, publicError,
}
