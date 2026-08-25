const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireMember(openid) {
  try {
    const member = (await db.collection('meal_members').doc(openid).get()).data
    if (member && member.status === 'active') return member
  } catch (_) {}
  throw new Error('需要有效邀请才能使用')
}

async function getDocument(collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data || null }
  catch (_) { return null }
}

async function removeDocuments(collection, records) {
  const list = records || []
  for (let index = 0; index < list.length; index += 20) {
    await Promise.all(list.slice(index, index + 20).map((item) => db.collection(collection).doc(item._id).remove().catch(() => {})))
  }
}

async function listOwned(collection, openid) {
  const records = []
  while (true) {
    const result = await db.collection(collection).where({ owner: openid }).skip(records.length).limit(100).get()
    records.push(...result.data)
    if (result.data.length < 100) break
  }
  return records
}

async function clearMyData(openid) {
  const [user, health, avatarTickets, photoTickets] = await Promise.all([
    getDocument('meal_users', openid),
    listOwned('health_daily', openid),
    listOwned('meal_avatar_uploads', openid),
    listOwned('health_photo_uploads', openid),
  ])
  const fileList = [user && user.avatarFileId, ...health.map((item) => item.photoFileId)].filter((value) => typeof value === 'string' && value.startsWith('cloud://'))
  if (fileList.length) {
    for (let index = 0; index < fileList.length; index += 50) await cloud.deleteFile({ fileList: fileList.slice(index, index + 50) }).catch(() => {})
  }
  await Promise.all([
    db.collection('meal_users').doc(openid).remove().catch(() => {}),
    db.collection('meal_user_states').doc(openid).remove().catch(() => {}),
    removeDocuments('health_daily', health),
    removeDocuments('meal_avatar_uploads', avatarTickets),
    removeDocuments('health_photo_uploads', photoTickets),
  ])
  return { cleared: true, healthRecordCount: health.length }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, message: '无法识别微信身份' }
  try {
    await requireMember(OPENID)
    if (event.action === 'clearMyData') return { success: true, data: await clearMyData(OPENID) }
    return { success: false, message: '不支持的隐私操作' }
  } catch (error) {
    console.error('privacy failed', error)
    return { success: false, message: error.message || '隐私服务暂时不可用' }
  }
}
