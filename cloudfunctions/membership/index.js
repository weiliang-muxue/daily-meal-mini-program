const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const members = db.collection('meal_members')
const invites = db.collection('meal_invites')
const MAX_MEMBERS = Math.max(1, Math.min(20, Number(process.env.MAX_MEMBERS || 4)))

function clean(value, maxLength = 40) { return typeof value === 'string' ? value.trim().slice(0, maxLength) : '' }
function hash(value) { return crypto.createHash('sha256').update(clean(value).toUpperCase()).digest('hex') }
function safeMember(member) {
  return member ? { status: member.status === 'active' ? 'active' : 'disabled', role: member.role === 'owner' ? 'owner' : 'member', joinedAt: member.joinedAt || null, maxMembers: MAX_MEMBERS } : { status: 'invite_required', role: '', joinedAt: null, maxMembers: MAX_MEMBERS }
}
async function readMember(openid) {
  try { return (await members.doc(openid).get()).data || null }
  catch (error) {
    if (/not exist|does not exist|DATABASE_DOCUMENT_NOT_FOUND/i.test(error.message || error.errMsg || '')) return null
    throw error
  }
}
async function requireOwner(openid) {
  const member = await readMember(openid)
  if (!member || member.status !== 'active' || member.role !== 'owner') throw new Error('只有管理员可以管理邀请')
  return member
}
async function activeCount() { return (await members.where({ status: 'active' }).count()).total }
async function activeInviteCount() {
  const result = await invites.where({ active: true }).limit(MAX_MEMBERS).get()
  const now = Date.now()
  const expired = result.data.filter((item) => Number(item.expiresAt || 0) < now)
  if (expired.length) await Promise.all(expired.map((item) => invites.doc(item._id).update({ data: { active: false, expiredAt: db.serverDate() } }).catch(() => {})))
  return result.data.length - expired.length
}

async function activateOwner(openid, code) {
  const existing = await activeCount()
  if (existing > 0) throw new Error('管理员已激活，请使用成员邀请码')
  const expected = clean(process.env.OWNER_BOOTSTRAP_CODE_HASH, 128).toLowerCase()
  const actual = hash(code)
  if (!expected || expected.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new Error('部署口令无效')
  const data = { status: 'active', role: 'owner', joinedAt: db.serverDate(), updatedAt: db.serverDate() }
  await members.doc(openid).set({ data })
  return safeMember(data)
}

async function acceptInvite(openid, code) {
  const current = await readMember(openid)
  if (current && current.status === 'active') return safeMember(current)
  if (await activeCount() >= MAX_MEMBERS) throw new Error('成员名额已满')
  const result = await invites.where({ codeHash: hash(code), active: true }).limit(1).get()
  const invite = result.data && result.data[0]
  if (!invite || Number(invite.expiresAt || 0) < Date.now() || Number(invite.usedCount || 0) >= Number(invite.maxUses || 1)) throw new Error('邀请码无效或已过期')
  await db.runTransaction(async (transaction) => {
    const fresh = (await transaction.collection('meal_invites').doc(invite._id).get()).data
    if (!fresh.active || Number(fresh.expiresAt) < Date.now() || Number(fresh.usedCount || 0) >= Number(fresh.maxUses || 1)) throw new Error('邀请码已被使用')
    await transaction.collection('meal_invites').doc(invite._id).update({ data: { usedCount: command.inc(1), active: false, usedAt: db.serverDate(), usedBy: openid } })
    await transaction.collection('meal_members').doc(openid).set({ data: { status: 'active', role: 'member', inviteId: invite._id, joinedAt: db.serverDate(), updatedAt: db.serverDate() } })
  })
  return safeMember(await readMember(openid))
}

async function createInvite(openid, label) {
  await requireOwner(openid)
  const [memberCount, inviteCount] = await Promise.all([activeCount(), activeInviteCount()])
  if (memberCount + inviteCount >= MAX_MEMBERS) throw new Error('成员名额已满或已有待使用邀请码')
  const code = crypto.randomBytes(5).toString('hex').toUpperCase()
  const now = Date.now()
  const result = await invites.add({ data: { codeHash: hash(code), label: clean(label, 20), active: true, maxUses: 1, usedCount: 0, createdBy: openid, createdAt: db.serverDate(), expiresAt: now + 7 * 24 * 60 * 60 * 1000 } })
  return { id: result._id, code, expiresAt: now + 7 * 24 * 60 * 60 * 1000 }
}

async function listMembers(openid) {
  await requireOwner(openid)
  const result = await members.where({ status: 'active' }).limit(MAX_MEMBERS).get()
  return { count: result.data.length, maxMembers: MAX_MEMBERS, members: result.data.map((item) => ({ role: item.role === 'owner' ? 'owner' : 'member', joinedAt: item.joinedAt || null })) }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, message: '无法识别微信身份' }
  try {
    if (event.action === 'status') return { success: true, data: safeMember(await readMember(OPENID)) }
    if (event.action === 'activateOwner') return { success: true, data: await activateOwner(OPENID, event.code) }
    if (event.action === 'acceptInvite') return { success: true, data: await acceptInvite(OPENID, event.code) }
    if (event.action === 'createInvite') return { success: true, data: await createInvite(OPENID, event.label) }
    if (event.action === 'listMembers') return { success: true, data: await listMembers(OPENID) }
    return { success: false, message: '不支持的成员操作' }
  } catch (error) {
    console.error('membership failed', error)
    return { success: false, message: error.message || '访问服务暂时不可用' }
  }
}
