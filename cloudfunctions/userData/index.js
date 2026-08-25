const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const states = db.collection('meal_user_states')
const members = db.collection('meal_members')

const CURRENT_SCHEMA = 4
const DEFAULT_PLAN_ID = 'week-2026-01'

function defaults() {
  return {
    schemaVersion: CURRENT_SCHEMA,
    activePlanId: DEFAULT_PLAN_ID,
    selectedDayId: '',
    selectedDay: 0,
    defaultDinnerMode: 'rest',
    dinnerModeByDay: {},
    mealOverrides: {},
    checkedShoppingIds: [],
    customReminders: [],
    settings: { calciumAnchorReminder: true, vitaminDReminder: true },
  }
}

async function requireMember(openid) {
  try {
    const member = (await members.doc(openid).get()).data
    if (member && member.status === 'active') return member
  } catch (_) {}
  throw new Error('需要有效邀请才能使用')
}

function text(value, maxLength) { return typeof value === 'string' ? value.trim().slice(0, maxLength) : '' }
function stringArray(value, maxItems = 100) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.slice(0, 100)))].slice(0, maxItems) : []
}

// Migration is additive: stable IDs and unknown server fields survive content updates.
function migrate(raw = {}) {
  const base = defaults()
  const legacyMode = raw.dinnerMode === 'workout' ? 'workout' : 'rest'
  const reminders = Array.isArray(raw.customReminders) ? raw.customReminders.slice(0, 50).map((item, index) => ({
    id: text(item && item.id, 100) || `migrated-${index}`,
    text: text(item && item.text, 80),
    done: Boolean(item && item.done),
  })).filter((item) => item.text) : []
  const modes = {}
  if (raw.dinnerModeByDay && typeof raw.dinnerModeByDay === 'object') {
    Object.keys(raw.dinnerModeByDay).slice(0, 100).forEach((id) => { modes[text(id, 100)] = raw.dinnerModeByDay[id] === 'workout' ? 'workout' : 'rest' })
  }
  const mealOverrides = {}
  if (raw.mealOverrides && typeof raw.mealOverrides === 'object') {
    Object.keys(raw.mealOverrides).slice(0, 200).forEach((id) => {
      const item = raw.mealOverrides[id] || {}
      const cleanId = text(id, 120)
      if (!cleanId) return
      mealOverrides[cleanId] = {
        title: text(item.title, 40), ingredients: text(item.ingredients, 300),
        method: text(item.method, 300), tag: text(item.tag, 60), updatedAt: text(item.updatedAt, 40),
      }
    })
  }
  return {
    ...base,
    activePlanId: text(raw.activePlanId, 100) || DEFAULT_PLAN_ID,
    selectedDayId: text(raw.selectedDayId, 100),
    selectedDay: Math.max(0, Math.min(31, Number(raw.selectedDay) || 0)),
    defaultDinnerMode: raw.defaultDinnerMode === 'workout' ? 'workout' : legacyMode,
    dinnerModeByDay: modes,
    mealOverrides,
    checkedShoppingIds: stringArray(raw.checkedShoppingIds),
    customReminders: reminders,
    settings: {
      calciumAnchorReminder: raw.settings ? raw.settings.calciumAnchorReminder !== false : true,
      vitaminDReminder: raw.settings ? raw.settings.vitaminDReminder !== false : true,
    },
  }
}

async function read(openid) {
  try { return (await states.doc(openid).get()).data || null }
  catch (error) {
    if (/not exist|does not exist|DATABASE_DOCUMENT_NOT_FOUND/i.test(error.message || error.errMsg || '')) return null
    throw error
  }
}

function publicState(value) {
  const state = migrate(value)
  state.updatedAt = value && value.updatedAt ? value.updatedAt : null
  return state
}

async function bootstrap(openid) {
  const current = await read(openid)
  if (!current) {
    const state = defaults()
    await states.doc(openid).set({ data: { ...state, createdAt: db.serverDate(), updatedAt: db.serverDate() } })
    return state
  }
  if (Number(current.schemaVersion || 0) < CURRENT_SCHEMA) {
    const migrated = migrate(current)
    await states.doc(openid).update({ data: { ...migrated, migratedFrom: Number(current.schemaVersion || 0), updatedAt: db.serverDate() } })
    return migrated
  }
  return publicState(current)
}

async function saveState(openid, incoming) {
  const current = await read(openid)
  const clean = migrate(incoming)
  const data = { ...clean, updatedAt: db.serverDate() }
  // Existing documents use update so fields introduced by a future server version survive old clients.
  if (current) await states.doc(openid).update({ data })
  else await states.doc(openid).set({ data: { ...data, createdAt: db.serverDate() } })
  return { ...clean, updatedAt: new Date().toISOString() }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, message: '无法识别当前微信用户' }
  try {
    await requireMember(OPENID)
    if (event.action === 'bootstrap') return { success: true, data: await bootstrap(OPENID) }
    if (event.action === 'saveState') return { success: true, data: await saveState(OPENID, event.state) }
    return { success: false, message: '不支持的数据操作' }
  } catch (error) {
    console.error('userData failed', error)
    return { success: false, message: error.message || '数据服务暂时不可用' }
  }
}
