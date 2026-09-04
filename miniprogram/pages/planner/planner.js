'use strict'

const { membershipStore } = require('../../services/membership-store')
const { userStore } = require('../../services/user-store')
const {
  aiPlanner,
  createClientRequestId,
  failurePolicy,
  isActiveTask,
  taskPresentation,
  CONTRACT_VERSION,
  PLANNER_VERSION,
  AI_DATA_CONSENT_VERSION,
  PROVIDER_CONTRACT_REVISION,
} = require('../../services/ai-planner')

const PREVIEW_URL = '/pages/plan-preview/plan-preview'
const PLAN_URL = '/pages/plan/plan'
const FORM_CONTROL_BLUR_DELAY = 160
const MIN_DURATION_DAYS = 1
const MAX_DURATION_DAYS = 14
const MEAL_OPTIONS = [
  { value: 'breakfast', label: '早餐', detail: '起床后的第一餐' },
  { value: 'lunch', label: '午餐', detail: '白天的正餐' },
  { value: 'dinner', label: '晚餐', detail: '晚间正餐' },
  { value: 'snack', label: '加餐', detail: '按需安排的小份餐食' },
]
const GOAL_OPTIONS = ['均衡饮食', '高碳水', '高蛋白', '控制能量', '补钙与维生素 D']
const STYLE_OPTIONS = ['清淡低油', '家常中式', '简单快手', '少盐', '食材易买']
const INTENSITY_OPTIONS = [
  { value: 'low', label: '轻松', detail: '例如散步、舒展等轻量活动' },
  { value: 'medium', label: '适中', detail: '例如快走、骑行等持续活动' },
  { value: 'high', label: '较强', detail: '例如跑步、力量训练等较高负荷活动' },
]
const EXERCISE_INTENTS = ['none', 'daily']
const STEP_TITLES = ['选择餐次', '周期与日期', '目标与风格', '饮食约束', '运动安排', '确认信息']

function canNavigateBack() {
  try {
    return typeof getCurrentPages === 'function' && getCurrentPages().length > 1
  } catch (_) {
    return false
  }
}

function returnFromSecondaryPage() {
  const goHome = () => wx.switchTab({ url: PLAN_URL })
  if (!canNavigateBack() || typeof wx.navigateBack !== 'function') return goHome()
  try {
    return wx.navigateBack({ delta: 1, fail: goHome })
  } catch (_) {
    return goHome()
  }
}

function pad(value) { return String(value).padStart(2, '0') }

function beijingToday() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

function addDays(value, offset) {
  const source = parseDate(value)
  if (!source) return ''
  const date = new Date(source.getTime() + offset * 24 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function defaultPreferences(startDate) {
  return {
    contractVersion: CONTRACT_VERSION,
    durationDays: MIN_DURATION_DAYS,
    startDate,
    mealTypes: [],
    doubleDinner: false,
    goals: [],
    styles: [],
    customGoal: '',
    restrictions: '',
    healthNotes: '',
    exerciseIntent: '',
    exerciseNotes: '',
    exerciseByDay: [],
  }
}

function cleanArray(value, allowed) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => allowed.includes(item)))]
}

function normalizePreferences(value) {
  const fallback = defaultPreferences(beijingToday())
  const source = value && typeof value === 'object' ? value : {}
  const requestedDuration = Number(source.durationDays)
  const durationDays = Number.isInteger(requestedDuration)
    && requestedDuration >= MIN_DURATION_DAYS && requestedDuration <= MAX_DURATION_DAYS
    ? requestedDuration : fallback.durationDays
  const mealTypes = cleanArray(source.mealTypes, MEAL_OPTIONS.map((item) => item.value))
  const startDate = parseDate(source.startDate) ? source.startDate : fallback.startDate
  const exerciseIntent = EXERCISE_INTENTS.includes(source.exerciseIntent) ? source.exerciseIntent : ''
  const exerciseInput = Array.isArray(source.exerciseByDay) ? source.exerciseByDay : []
  const exerciseByDay = Array.from({ length: durationDays }, (_, dayIndex) => {
    const stored = exerciseInput.find((item) => Number(item && item.dayIndex) === dayIndex) || {}
    const planned = stored.planned === true
    const duration = Number(stored.durationMinutes)
    return {
      dayIndex,
      planned,
      type: planned ? String(stored.type || '').slice(0, 30) : '',
      durationMinutes: planned && Number.isInteger(duration) && duration >= 0 && duration <= 360 ? duration : 0,
      intensity: planned && ['low', 'medium', 'high'].includes(stored.intensity) ? stored.intensity : 'medium',
    }
  })
  return {
    contractVersion: CONTRACT_VERSION,
    durationDays,
    startDate,
    mealTypes,
    doubleDinner: mealTypes.includes('dinner') && source.doubleDinner === true,
    goals: cleanArray(source.goals, GOAL_OPTIONS),
    styles: cleanArray(source.styles, STYLE_OPTIONS),
    customGoal: String(source.customGoal || '').slice(0, 160),
    restrictions: String(source.restrictions || '').slice(0, 240),
    healthNotes: String(source.healthNotes || '').slice(0, 240),
    exerciseIntent,
    exerciseNotes: String(source.exerciseNotes || '').slice(0, 160),
    exerciseByDay,
  }
}

function selectedOptions(options, selected) {
  return options.map((item) => ({ ...item, checked: selected.includes(item.value || item) }))
}

function weekday(dateText) {
  const date = parseDate(dateText)
  return date ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getUTCDay()] : ''
}

function validateExerciseEntry(exercise, durationText) {
  if (!exercise || exercise.planned !== true) return { typeError: '', durationError: '' }
  const typeError = String(exercise.type || '').trim() ? '' : '请填写运动类型'
  const rawDuration = durationText === undefined ? String(exercise.durationMinutes) : String(durationText).trim()
  const duration = Number(rawDuration)
  const durationError = /^\d+$/.test(rawDuration) && Number.isInteger(duration) && duration >= 1 && duration <= 360
    ? ''
    : '请输入 1–360 的整数分钟'
  return { typeError, durationError }
}

function buildExerciseDays(preferences, durationDrafts = {}, durationInputErrors = {}, showErrors = false) {
  return preferences.exerciseByDay.map((exercise, dayIndex) => {
    const date = addDays(preferences.startDate, dayIndex)
    const hasDurationDraft = Object.prototype.hasOwnProperty.call(durationDrafts, dayIndex)
    const durationText = hasDurationDraft
      ? durationDrafts[dayIndex]
      : exercise.durationMinutes ? String(exercise.durationMinutes) : ''
    const validation = validateExerciseEntry(exercise, durationText)
    const selectedIntensity = INTENSITY_OPTIONS.find((item) => item.value === exercise.intensity)
    return {
      ...exercise,
      date,
      label: `第 ${dayIndex + 1} 天`,
      weekday: weekday(date),
      durationText,
      typeError: showErrors ? validation.typeError : '',
      durationError: durationInputErrors[dayIndex] || (showErrors ? validation.durationError : ''),
      intensityOptions: INTENSITY_OPTIONS.map((item) => ({ ...item, checked: exercise.intensity === item.value })),
      intensityHint: selectedIntensity ? selectedIntensity.detail : '',
    }
  })
}

function validateExercisePlan(preferences, durationDrafts = {}) {
  if (!EXERCISE_INTENTS.includes(preferences.exerciseIntent)) {
    return { dayIndex: null, message: '请选择本周期不安排运动，或逐日安排运动' }
  }
  const plannedExercises = preferences.exerciseByDay.filter((exercise) => exercise.planned)
  if (preferences.exerciseIntent === 'none') {
    return plannedExercises.length
      ? { dayIndex: plannedExercises[0].dayIndex, message: '运动安排状态不一致，请重新选择' }
      : null
  }
  if (!plannedExercises.length) {
    return { dayIndex: null, message: '请至少安排一天运动；若本周期不运动，请选择“不安排运动”' }
  }
  for (const exercise of preferences.exerciseByDay) {
    const durationText = Object.prototype.hasOwnProperty.call(durationDrafts, exercise.dayIndex)
      ? durationDrafts[exercise.dayIndex]
      : undefined
    const errors = validateExerciseEntry(exercise, durationText)
    if (errors.typeError || errors.durationError) {
      const detail = errors.typeError && errors.durationError
        ? '请填写运动类型和 1–360 的整数分钟'
        : errors.typeError || errors.durationError
      return { dayIndex: exercise.dayIndex, message: `第 ${exercise.dayIndex + 1} 天：${detail}` }
    }
  }
  return null
}

function durationInputError(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (!raw) return '请输入 1–14 的天数'
  if (!/^\d+$/.test(raw)) return '请输入 1–14 的整数天数'
  const durationDays = Number(raw)
  if (durationDays < MIN_DURATION_DAYS) return '最少生成 1 天，不会生成 0 天餐单'
  if (durationDays > MAX_DURATION_DAYS) return '最多生成 14 天，请输入 1–14'
  return ''
}

function summaryRows(preferences) {
  const mealLabels = MEAL_OPTIONS.filter((item) => preferences.mealTypes.includes(item.value)).map((item) => item.label)
  const plannedDays = preferences.exerciseByDay.filter((item) => item.planned).length
  const endDate = addDays(preferences.startDate, preferences.durationDays - 1)
  return [
    { label: '餐次', value: mealLabels.join('、') || '尚未选择' },
    { label: '周期', value: `${preferences.durationDays} 天，${preferences.startDate} 至 ${endDate}` },
    { label: '目标', value: [...preferences.goals, preferences.customGoal].filter(Boolean).join('、') || '未填写' },
    { label: '风格', value: preferences.styles.join('、') || '未选择' },
    { label: '约束', value: preferences.restrictions || preferences.healthNotes ? '已填写，将仅用于本次生成' : '未填写' },
    {
      label: '运动',
      value: preferences.exerciseIntent === 'none'
        ? '本周期不安排运动'
        : preferences.exerciseIntent === 'daily'
          ? `逐日安排，其中 ${plannedDays} 天运动`
          : '尚未确认',
    },
  ]
}

const AI_STORAGE_NOT_READY_DETAIL = '餐单生成暂时不可用，请稍后重试。当前餐单不会改变。'

function isAiStorageNotReady(error) {
  return Boolean(error && error.code === 'AI_STORAGE_NOT_READY')
}

function aiStorageUnavailableState() {
  return {
    aiStatus: 'error',
    aiStatusTitle: '餐单生成暂不可用',
    aiStatusDetail: AI_STORAGE_NOT_READY_DETAIL,
    providerDisplayName: '',
    providerRevision: 0,
  }
}

function errorMessage(error, fallback) {
  if (isAiStorageNotReady(error)) return AI_STORAGE_NOT_READY_DETAIL
  return error && error.message ? error.message : fallback
}

function providerDisplayName(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  return label && label.length <= 40 ? label : ''
}

function taskFailureDetail(task) {
  if (task && task.status === 'cancelled') return '任务已停止，当前餐单没有改变。'
  return failurePolicy(task && task.errorCode, task && task.status).detail
}

function taskStageStateText(state, retryable) {
  if (state === 'done') return '完成'
  if (state === 'current') return '进行中'
  if (state === 'error') return retryable ? '可重试' : '未完成'
  if (state === 'cancelled') return '已取消'
  return '等待'
}

function recentFailureStages(failure, retryable) {
  const stages = [
    { key: 'outline', label: '安排餐次', detail: '安排日期与每餐结构' },
    { key: 'details', label: '搭配餐食', detail: '生成每餐食材与做法' },
    { key: 'validation', label: '完整检查', detail: '检查天数、餐次与采购清单' },
  ]
  const percent = Math.max(0, Math.min(100, Number(failure && failure.progressPercent) || 0))
  const phase = failure && failure.phase
  const phaseIndex = phase === 'outline' ? 0 : phase === 'details' ? 1 : phase === 'validation' ? 2
    : percent <= 0 ? 0 : percent < 67 ? 1 : 2
  return stages.map((stage, index) => {
    const state = index < phaseIndex ? 'done' : index === phaseIndex ? 'error' : 'pending'
    return { ...stage, state, stateText: taskStageStateText(state, retryable) }
  })
}

Page({
  data: {
    canNavigateBack: false,
    pageNavigationLabel: '返回餐单首页',
    currentStep: 0,
    stepNumber: 1,
    stepCount: STEP_TITLES.length,
    stepTitle: STEP_TITLES[0],
    stepItems: STEP_TITLES.map((title, index) => ({ title, index, state: index === 0 ? 'current' : 'upcoming' })),
    preferences: defaultPreferences(beijingToday()),
    durationDaysInput: String(MIN_DURATION_DAYS),
    durationDaysError: '',
    durationDaysFeedback: '',
    durationAtMin: true,
    durationAtMax: false,
    mealOptions: selectedOptions(MEAL_OPTIONS, []),
    goalOptions: GOAL_OPTIONS.map((label) => ({ label, checked: false })),
    styleOptions: STYLE_OPTIONS.map((label) => ({ label, checked: false })),
    exerciseDays: [],
    summaryRows: [],
    hasDinner: false,
    aiStatus: 'loading',
    aiStatusTitle: '正在检查生成服务',
    aiStatusDetail: '只检查服务是否可用，不会发送你的选择。',
    providerDisplayName: '',
    providerRevision: 0,
    aiDataConsentAccepted: false,
    nativeControlColor: '#176B46',
    exerciseErrorsVisible: false,
    formControlFocused: false,
    loadingPage: true,
    recoverySettled: false,
    preferencesOffline: false,
    pageError: '',
    stepError: '',
    generating: false,
    canceling: false,
    taskVisible: false,
    taskInterrupted: false,
    taskTitle: '',
    taskDetail: '',
    taskPercent: 0,
    taskPercentText: '0%',
    taskStages: [],
    taskCanCancel: false,
    taskCanRetry: false,
    taskCanEdit: false,
    taskCanReturn: false,
    taskRetryLabel: '继续任务',
    taskDiagnosticStage: '',
  },

  onAiDataConsentChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ aiDataConsentAccepted: values.includes('accepted'), stepError: '' })
  },

  applyTheme(event = {}) {
    let theme = event && event.theme
    if (theme !== 'dark' && theme !== 'light') {
      try {
        if (typeof wx.getAppBaseInfo === 'function') theme = (wx.getAppBaseInfo() || {}).theme
      } catch (_) {}
    }
    if (theme !== 'dark' && theme !== 'light') theme = this.currentTheme || 'light'
    this.currentTheme = theme
    this.setData({ nativeControlColor: theme === 'dark' ? '#72D49E' : '#176B46' })
  },

  onFormControlFocus() {
    this.formControlActive = true
    this.clearFormControlBlurTimer()
    if (!this.data.formControlFocused) this.setData({ formControlFocused: true })
  },

  onFormControlBlur() {
    this.formControlActive = false
    this.scheduleFormControlFooterRestore()
  },

  clearFormControlBlurTimer() {
    clearTimeout(this.formControlBlurTimer)
    this.formControlBlurTimer = null
  },

  scheduleFormControlFooterRestore() {
    this.clearFormControlBlurTimer()
    this.formControlBlurTimer = setTimeout(() => {
      this.formControlBlurTimer = null
      if (this.formControlActive || this.keyboardHeight > 0) return
      if (this.data.formControlFocused) this.setData({ formControlFocused: false })
    }, FORM_CONTROL_BLUR_DELAY)
  },

  onKeyboardHeightChange(event) {
    const height = Math.max(0, Number(event && event.height) || 0)
    this.keyboardHeight = height
    if (height > 0) {
      this.clearFormControlBlurTimer()
      if (!this.data.formControlFocused) this.setData({ formControlFocused: true })
      return
    }
    if (!this.formControlActive) this.scheduleFormControlFooterRestore()
  },

  onLoad() {
    this.refreshPageNavigation()
    this.pageActive = true
    this.connected = false
    this.taskLoopToken = 0
    this.taskLoopTimer = null
    this.preferenceSaveTimer = null
    this.formControlActive = false
    this.keyboardHeight = 0
    this.formControlBlurTimer = null
    this.keyboardHeightHandler = (event) => this.onKeyboardHeightChange(event)
    if (typeof wx.onKeyboardHeightChange === 'function') wx.onKeyboardHeightChange(this.keyboardHeightHandler)
    this.applyTheme()
    this.themeChangeHandler = (event) => this.applyTheme(event)
    if (typeof wx.onThemeChange === 'function') wx.onThemeChange(this.themeChangeHandler)
    this.currentTask = null
    this.pendingStart = null
    this.taskRecoveryPromise = null
    this.connect()
  },

  onShow() {
    this.refreshPageNavigation()
    this.pageActive = true
    this.formControlActive = false
    this.keyboardHeight = 0
    this.clearFormControlBlurTimer()
    if (this.data.formControlFocused) this.setData({ formControlFocused: false })
    if (!this.connected || !this.data.recoverySettled) return
    if (this.currentTask && (isActiveTask(this.currentTask) || this.currentTask.status === 'succeeded')) {
      const taskId = this.currentTask.taskId
      this.runTaskRecovery(() => this.resumeTask(taskId))
    }
    else if (!this.data.generating && !this.data.taskVisible) this.runTaskRecovery()
  },

  refreshPageNavigation() {
    const canGoBack = canNavigateBack()
    this.setData({
      canNavigateBack: canGoBack,
      pageNavigationLabel: canGoBack ? '返回上一页' : '返回餐单首页',
    })
  },

  navigateFromPage() {
    return returnFromSecondaryPage()
  },

  onHide() {
    this.pageActive = false
    this.formControlActive = false
    this.keyboardHeight = 0
    this.clearFormControlBlurTimer()
    if (this.data.formControlFocused) this.setData({ formControlFocused: false })
    this.stopTaskLoop()
    this.flushPreferenceDraft()
    if (this.currentTask && isActiveTask(this.currentTask)) {
      this.setData({ generating: false })
      this.renderTask(this.currentTask, { interrupted: true })
    }
  },

  onUnload() {
    this.pageActive = false
    this.formControlActive = false
    this.keyboardHeight = 0
    this.clearFormControlBlurTimer()
    if (this.keyboardHeightHandler && typeof wx.offKeyboardHeightChange === 'function') {
      wx.offKeyboardHeightChange(this.keyboardHeightHandler)
    }
    this.keyboardHeightHandler = null
    if (this.themeChangeHandler && typeof wx.offThemeChange === 'function') wx.offThemeChange(this.themeChangeHandler)
    this.themeChangeHandler = null
    this.stopTaskLoop()
    clearTimeout(this.preferenceSaveTimer)
    this.preferenceSaveTimer = null
    this.flushPreferenceDraft()
  },

  async connect(force = false) {
    this.setData({ loadingPage: true, recoverySettled: false, preferencesOffline: false, pageError: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') {
        this.setData({ loadingPage: false, recoverySettled: true })
        wx.reLaunch({ url: '/pages/access/access' })
        return
      }
      const state = await userStore.init({ force })
      const preferences = normalizePreferences(state.generationPreferences)
      this.renderPreferences(preferences)
      this.connected = true
      if (userStore.state === 'offline') {
        this.setData({
          loadingPage: false,
          recoverySettled: true,
          preferencesOffline: true,
          aiStatus: 'error',
          aiStatusTitle: '已恢复保存的选择',
          aiStatusDetail: '当前离线，生成餐单需要联网。连接网络后点此重试。',
          providerDisplayName: '',
          providerRevision: 0,
        })
        return
      }
      await this.checkAiStatus()
      await this.runTaskRecovery()
      this.setData({ loadingPage: false, recoverySettled: true })
    } catch (error) {
      this.setData({
        loadingPage: false,
        recoverySettled: true,
        pageError: errorMessage(error, '无法加载定制设置，请重试'),
        aiStatus: 'error',
        aiStatusTitle: '暂时无法连接',
        aiStatusDetail: '检查网络后重试，已保存的选择不会丢失。',
      })
    }
  },

  async checkAiStatus() {
    this.setData({ aiStatus: 'loading', aiStatusTitle: '正在检查生成服务', aiStatusDetail: '只检查服务是否可用，不会发送你的选择。' })
    try {
      const status = await aiPlanner.status()
      const displayName = providerDisplayName(status && status.providerDisplayName)
      if (status && status.configured === true && Number(status.contractVersion) === CONTRACT_VERSION
        && String(status.plannerVersion || '') === PLANNER_VERSION
        && Number(status.aiDataConsentVersion) === AI_DATA_CONSENT_VERSION
        && Number(status.providerContractRevision) === PROVIDER_CONTRACT_REVISION
        && Number.isSafeInteger(Number(status.providerRevision)) && Number(status.providerRevision) > 0
        && status.storageReady === true && displayName) {
        this.setData({
          aiStatus: 'ready', aiStatusTitle: '生成服务可用',
          aiStatusDetail: '完成六步选择后，可以生成候选餐单。',
          providerDisplayName: displayName, providerRevision: Number(status.providerRevision),
        })
        return true
      } else {
        const storageReady = status && status.storageReady === true
        this.setData({
          ...(!storageReady ? aiStorageUnavailableState() : {
            aiStatus: status && status.configured === true ? 'error' : 'unconfigured',
            aiStatusTitle: '生成服务正在维护',
            aiStatusDetail: '暂时不能生成。你的选择已保存，请稍后重试。',
            providerDisplayName: '',
            providerRevision: 0,
          }),
        })
      }
    } catch (error) {
      this.setData({
        ...(isAiStorageNotReady(error) ? aiStorageUnavailableState() : {
          aiStatus: 'error',
          aiStatusTitle: '生成服务暂不可用',
          aiStatusDetail: '你的选择已保存，请检查网络后重试。',
          providerDisplayName: '',
          providerRevision: 0,
        }),
      })
    }
    return false
  },

  retryConnect() { this.connect(true) },
  async retryAiStatus() {
    const ready = await this.checkAiStatus()
    await this.runTaskRecovery()
    if (ready && this.data.aiStatus === 'ready' && this.pendingStart && this.data.taskVisible && !this.data.generating) {
      this.setData({ taskCanRetry: true, taskRetryLabel: '继续任务' })
    }
  },

  runTaskRecovery(operation) {
    if (this.taskRecoveryPromise) return this.taskRecoveryPromise
    const recover = typeof operation === 'function' ? operation : () => this.recoverTask()
    const recovery = Promise.resolve().then(() => recover.call(this))
    const sharedRecovery = recovery.finally(() => {
      if (this.taskRecoveryPromise === sharedRecovery) this.taskRecoveryPromise = null
    })
    this.taskRecoveryPromise = sharedRecovery
    return sharedRecovery
  },

  renderPreferences(raw) {
    const preferences = normalizePreferences(raw)
    const currentStep = this.data.currentStep
    const durationDrafts = this.exerciseDurationDrafts || {}
    const durationInputErrors = this.exerciseDurationInputErrors || {}
    this.setData({
      preferences,
      durationDaysInput: this.durationDaysDraft === undefined
        ? String(preferences.durationDays) : this.durationDaysDraft,
      durationDaysError: this.durationDaysInputError || '',
      durationAtMin: preferences.durationDays <= MIN_DURATION_DAYS,
      durationAtMax: preferences.durationDays >= MAX_DURATION_DAYS,
      mealOptions: selectedOptions(MEAL_OPTIONS, preferences.mealTypes),
      goalOptions: GOAL_OPTIONS.map((label) => ({ label, checked: preferences.goals.includes(label) })),
      styleOptions: STYLE_OPTIONS.map((label) => ({ label, checked: preferences.styles.includes(label) })),
      exerciseDays: buildExerciseDays(
        preferences,
        durationDrafts,
        durationInputErrors,
        this.data.exerciseErrorsVisible,
      ),
      summaryRows: summaryRows(preferences),
      hasDinner: preferences.mealTypes.includes('dinner'),
      stepNumber: currentStep + 1,
      stepTitle: STEP_TITLES[currentStep],
      stepItems: STEP_TITLES.map((title, index) => ({
        title,
        index,
        state: index < currentStep ? 'done' : index === currentStep ? 'current' : 'upcoming',
      })),
    })
  },

  updatePreferences(patch) {
    const preferences = normalizePreferences({ ...this.data.preferences, ...patch })
    if (this.data.aiDataConsentAccepted) this.setData({ aiDataConsentAccepted: false })
    this.renderPreferences(preferences)
    Promise.resolve().then(() => userStore.patch({ generationPreferences: preferences }, { localOnly: true })).then(() => {
      clearTimeout(this.preferenceSaveTimer)
      this.preferenceSaveTimer = setTimeout(() => this.flushPreferenceDraft(), 700)
    }).catch((error) => {
      this.setData({ stepError: errorMessage(error, '无法保存本次选择') })
    })
  },

  flushPreferenceDraft() {
    clearTimeout(this.preferenceSaveTimer)
    this.preferenceSaveTimer = null
    return userStore.flush().catch((error) => {
      if (this.pageActive) this.setData({ stepError: errorMessage(error, '选择已保留，联网后会自动同步') })
      return userStore.data
    })
  },

  onMealsChange(event) {
    const mealTypes = cleanArray(event.detail.value, MEAL_OPTIONS.map((item) => item.value))
    this.updatePreferences({ mealTypes, doubleDinner: mealTypes.includes('dinner') && this.data.preferences.doubleDinner })
    this.setData({ stepError: '' })
  },

  applyDurationDays(durationDays, feedback = '') {
    if (!Number.isInteger(durationDays)
      || durationDays < MIN_DURATION_DAYS || durationDays > MAX_DURATION_DAYS) return false
    const current = this.data.preferences.exerciseByDay
    this.exerciseDurationDrafts = Object.fromEntries(
      Object.entries(this.exerciseDurationDrafts || {}).filter(([dayIndex]) => Number(dayIndex) < durationDays),
    )
    this.exerciseDurationInputErrors = Object.fromEntries(
      Object.entries(this.exerciseDurationInputErrors || {}).filter(([dayIndex]) => Number(dayIndex) < durationDays),
    )
    const exerciseByDay = Array.from({ length: durationDays }, (_, dayIndex) => current[dayIndex] || {
      dayIndex, planned: false, type: '', durationMinutes: 0, intensity: 'medium',
    })
    this.durationDaysDraft = undefined
    this.durationDaysInputError = ''
    this.updatePreferences({ durationDays, exerciseByDay })
    this.setData({
      durationDaysInput: String(durationDays),
      durationDaysError: '',
      durationDaysFeedback: feedback,
      stepError: '',
    })
    return true
  },

  adjustDuration(event) {
    const delta = Number(event.currentTarget.dataset.delta)
    if (![1, -1].includes(delta)) return
    const rawDuration = Number(this.data.durationDaysInput)
    const base = Number.isInteger(rawDuration) ? rawDuration : this.data.preferences.durationDays
    const durationDays = Math.max(MIN_DURATION_DAYS, Math.min(MAX_DURATION_DAYS, base + delta))
    this.applyDurationDays(durationDays)
  },

  inputDurationDays(event) {
    const raw = String(event.detail.value === undefined || event.detail.value === null ? '' : event.detail.value).trim()
    const error = durationInputError(raw)
    this.durationDaysDraft = raw
    this.durationDaysInputError = error
    this.setData({
      durationDaysInput: raw,
      durationDaysError: error,
      durationDaysFeedback: '',
      stepError: '',
    })
    if (error) return
    this.applyDurationDays(Number(raw))
  },

  commitDurationDays() {
    const raw = String(this.data.durationDaysInput || '').trim()
    const durationDays = Number(raw)
    if (!raw || (Number.isInteger(durationDays) && durationDays < MIN_DURATION_DAYS)) {
      this.applyDurationDays(MIN_DURATION_DAYS, '最少生成 1 天，已调整为 1 天。')
    } else {
      const error = durationInputError(raw)
      this.durationDaysDraft = error ? raw : undefined
      this.durationDaysInputError = error
      this.setData({ durationDaysError: error, durationDaysFeedback: '', stepError: error })
    }
    this.onFormControlBlur()
  },

  onStartDateChange(event) {
    const startDate = event.detail.value
    if (!parseDate(startDate)) {
      this.setData({ stepError: '请选择有效的开始日期' })
      return
    }
    this.updatePreferences({ startDate })
    this.setData({ stepError: '' })
  },

  onGoalsChange(event) {
    this.updatePreferences({ goals: cleanArray(event.detail.value, GOAL_OPTIONS) })
  },

  onStylesChange(event) {
    this.updatePreferences({ styles: cleanArray(event.detail.value, STYLE_OPTIONS) })
  },

  inputCustomGoal(event) { this.updatePreferences({ customGoal: event.detail.value }) },
  inputRestrictions(event) { this.updatePreferences({ restrictions: event.detail.value }) },
  inputHealthNotes(event) { this.updatePreferences({ healthNotes: event.detail.value }) },
  inputExerciseNotes(event) { this.updatePreferences({ exerciseNotes: event.detail.value }) },

  onExerciseIntentChange(event) {
    const exerciseIntent = event && event.detail && EXERCISE_INTENTS.includes(event.detail.value)
      ? event.detail.value : ''
    if (!exerciseIntent) return
    const patch = { exerciseIntent }
    if (exerciseIntent === 'none') {
      patch.exerciseByDay = this.data.preferences.exerciseByDay.map((item) => ({
        ...item,
        planned: false,
        type: '',
        durationMinutes: 0,
        intensity: 'medium',
      }))
      this.exerciseDurationDrafts = {}
      this.exerciseDurationInputErrors = {}
    }
    this.updatePreferences(patch)
    this.setData({ stepError: '', exerciseErrorsVisible: false })
  },

  toggleExercise(event) {
    if (this.data.preferences.exerciseIntent !== 'daily') return
    const dayIndex = Number(event.currentTarget.dataset.index)
    const current = this.data.preferences.exerciseByDay.find((item) => item.dayIndex === dayIndex)
    if (current && current.planned) {
      if (this.exerciseDurationDrafts) delete this.exerciseDurationDrafts[dayIndex]
      if (this.exerciseDurationInputErrors) delete this.exerciseDurationInputErrors[dayIndex]
    }
    const exerciseByDay = this.data.preferences.exerciseByDay.map((item) => item.dayIndex === dayIndex ? {
      ...item,
      planned: !item.planned,
      type: item.planned ? '' : item.type,
      durationMinutes: item.planned ? 0 : item.durationMinutes,
      intensity: item.planned ? 'medium' : item.intensity,
    } : item)
    this.updatePreferences({ exerciseByDay })
    this.setData({ stepError: '' })
  },

  inputExerciseType(event) {
    this.patchExercise(Number(event.currentTarget.dataset.index), { type: event.detail.value })
  },

  inputExerciseDuration(event) {
    const dayIndex = Number(event.currentTarget.dataset.index)
    const raw = String(event.detail.value === undefined || event.detail.value === null ? '' : event.detail.value).trim()
    this.exerciseDurationDrafts = { ...(this.exerciseDurationDrafts || {}), [dayIndex]: raw }
    const inputError = /^\d{0,3}$/.test(raw) && (!raw || Number(raw) <= 360)
      ? ''
      : '请输入 1–360 的整数分钟'
    this.exerciseDurationInputErrors = { ...(this.exerciseDurationInputErrors || {}), [dayIndex]: inputError }
    if (inputError) {
      this.setData({ stepError: '' })
      this.renderPreferences(this.data.preferences)
      return
    }
    const durationMinutes = raw ? Number(raw) : 0
    this.patchExercise(dayIndex, { durationMinutes })
  },

  chooseIntensity(event) {
    const intensity = event.currentTarget.dataset.intensity
    if (!['low', 'medium', 'high'].includes(intensity)) return
    this.patchExercise(Number(event.currentTarget.dataset.index), { intensity })
  },

  patchExercise(dayIndex, patch) {
    const exerciseByDay = this.data.preferences.exerciseByDay.map((item) => item.dayIndex === dayIndex ? { ...item, ...patch } : item)
    this.updatePreferences({ exerciseByDay })
    this.setData({ stepError: '' })
  },

  onDoubleDinnerChange(event) {
    this.updatePreferences({ doubleDinner: this.data.hasDinner && event.detail.value.includes('enabled') })
  },

  validateStep(step) {
    const preferences = this.data.preferences
    if (step === 0 && preferences.mealTypes.length === 0) return '请至少选择一个餐次'
    if (step === 1) {
      const inputError = durationInputError(this.data.durationDaysInput)
      if (inputError) return inputError
      if (!Number.isInteger(preferences.durationDays)
        || preferences.durationDays < MIN_DURATION_DAYS || preferences.durationDays > MAX_DURATION_DAYS) {
        return '请选择 1–14 天的餐单周期'
      }
    }
    if (step === 1 && !parseDate(preferences.startDate)) return '请选择有效的开始日期'
    if (step === 2 && preferences.goals.length === 0 && preferences.styles.length === 0
      && !String(preferences.customGoal || '').trim()) {
      return '请至少选择一个饮食目标或风格，或填写本次补充目标'
    }
    if (step === 4) {
      const invalid = validateExercisePlan(preferences, this.exerciseDurationDrafts || {})
      if (invalid) return invalid.message
    }
    return ''
  },

  goNext() {
    const error = this.validateStep(this.data.currentStep)
    if (error) {
      const isExerciseStep = this.data.currentStep === 4
      this.setData({ stepError: error, exerciseErrorsVisible: isExerciseStep })
      if (isExerciseStep) {
        this.renderPreferences(this.data.preferences)
        const invalid = validateExercisePlan(this.data.preferences, this.exerciseDurationDrafts || {})
        if (invalid && Number.isInteger(invalid.dayIndex)) {
          wx.pageScrollTo({ selector: `#exercise-day-${invalid.dayIndex}`, offsetTop: -16, duration: 180 })
        }
      }
      return
    }
    const currentStep = Math.min(STEP_TITLES.length - 1, this.data.currentStep + 1)
    this.setData({ currentStep, stepError: '', exerciseErrorsVisible: false })
    this.renderPreferences(this.data.preferences)
    wx.pageScrollTo({ scrollTop: 0, duration: 180 })
  },

  goBack() {
    const currentStep = Math.max(0, this.data.currentStep - 1)
    this.setData({ currentStep, stepError: '' })
    this.renderPreferences(this.data.preferences)
    wx.pageScrollTo({ scrollTop: 0, duration: 180 })
  },

  goToStep(event) {
    const target = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(target) || target < 0 || target >= this.data.currentStep) return
    this.setData({ currentStep: target, stepError: '' })
    this.renderPreferences(this.data.preferences)
    wx.pageScrollTo({ scrollTop: 0, duration: 180 })
  },

  renderStartingTask() {
    this.setData({
      taskVisible: true,
      taskInterrupted: false,
      taskTitle: '正在准备候选餐单',
      taskDetail: '会分步完成并自动保存进度，当前餐单不会改变。',
      taskPercent: 0,
      taskPercentText: '0%',
      taskStages: [
        { key: 'outline', label: '安排餐次', detail: '安排日期与每餐结构', state: 'current', stateText: '进行中' },
        { key: 'details', label: '搭配餐食', detail: '生成每餐食材与做法', state: 'pending', stateText: '等待' },
        { key: 'validation', label: '完整检查', detail: '检查天数、餐次与采购清单', state: 'pending', stateText: '等待' },
      ],
      taskCanCancel: false,
      taskCanRetry: false,
      taskCanEdit: false,
      taskCanReturn: false,
      taskRetryLabel: '继续生成',
      taskDiagnosticStage: '',
    })
  },

  renderTask(task, options = {}) {
    const interrupted = options.interrupted === true
    const presentation = taskPresentation(task, interrupted)
    const terminalDetail = !isActiveTask(task) && task.status !== 'succeeded' ? taskFailureDetail(task) : ''
    const terminalPolicy = failurePolicy(task && task.errorCode, task && task.status)
    const terminalFailure = !isActiveTask(task) && !['succeeded', 'cancelled'].includes(task.status)
    const canRetry = terminalFailure ? terminalPolicy.retryable : presentation.canRetry
    this.currentTask = task
    if (this.data.currentStep !== STEP_TITLES.length - 1) {
      this.setData({ currentStep: STEP_TITLES.length - 1 })
      this.renderPreferences(this.data.preferences)
    }
    this.setData({
      taskVisible: true,
      taskInterrupted: interrupted,
      taskTitle: presentation.title,
      taskDetail: terminalDetail || presentation.detail,
      taskPercent: presentation.percent,
      taskPercentText: presentation.percentText,
      taskStages: presentation.stages.map((stage) => ({
        ...stage,
        stateText: taskStageStateText(stage.state, canRetry),
      })),
      taskCanCancel: presentation.canCancel,
      taskCanRetry: canRetry,
      taskCanEdit: !isActiveTask(task) && task.status !== 'succeeded',
      taskCanReturn: !isActiveTask(task) && task.status !== 'succeeded' && !canRetry,
      taskRetryLabel: terminalFailure ? '重新确认并生成' : '继续任务',
    })
  },

  renderRecentFailure(failure) {
    if (!failure) return
    const policy = failurePolicy(failure.errorCode, failure.status)
    const retryable = failure.retryable === true && policy.retryable
    const percent = Math.max(0, Math.min(100, Number(failure.progressPercent) || 0))
    this.currentTask = null
    this.pendingStart = null
    if (this.data.currentStep !== STEP_TITLES.length - 1) {
      this.setData({ currentStep: STEP_TITLES.length - 1 })
      this.renderPreferences(this.data.preferences)
    }
    this.setData({
      generating: false,
      canceling: false,
      taskVisible: true,
      taskInterrupted: false,
      taskTitle: failure.status === 'expired' ? '本次生成已过期'
        : failure.status === 'conflict' ? '你的餐单设置已更新' : '本次生成未完成',
      taskDetail: policy.detail,
      taskPercent: percent,
      taskPercentText: `${percent}%`,
      taskStages: recentFailureStages(failure, retryable),
      taskCanCancel: false,
      taskCanRetry: retryable,
      taskCanEdit: true,
      taskCanReturn: !retryable,
      taskRetryLabel: '重新确认并生成',
      taskDiagnosticStage: '',
    })
  },

  resetTaskPanel() {
    this.currentTask = null
    this.pendingStart = null
    this.setData({
      generating: false,
      canceling: false,
      taskVisible: false,
      taskInterrupted: false,
      taskTitle: '',
      taskDetail: '',
      taskPercent: 0,
      taskPercentText: '0%',
      taskStages: [],
      taskCanCancel: false,
      taskCanRetry: false,
      taskCanEdit: false,
      taskCanReturn: false,
      taskRetryLabel: '继续任务',
      taskDiagnosticStage: '',
      aiDataConsentAccepted: false,
    })
  },

  stopTaskLoop() {
    this.taskLoopToken = Number(this.taskLoopToken || 0) + 1
    clearTimeout(this.taskLoopTimer)
    this.taskLoopTimer = null
  },

  scheduleTaskAdvance(taskId, delayMs = 400) {
    this.stopTaskLoop()
    if (!this.pageActive || !this.currentTask || this.currentTask.taskId !== taskId || !isActiveTask(this.currentTask)) return
    const token = this.taskLoopToken
    const delay = Math.max(250, Math.min(5000, Number(delayMs) || 400))
    this.taskLoopTimer = setTimeout(async () => {
      if (!this.pageActive || token !== this.taskLoopToken) return
      try {
        const response = await aiPlanner.advance(taskId)
        if (!this.pageActive || token !== this.taskLoopToken) return
        await this.applyTaskResponse(response)
      } catch (error) {
        if (!this.pageActive || token !== this.taskLoopToken) return
        this.markTaskInterrupted(error)
      }
    }, delay)
  },

  markTaskInterrupted(error) {
    this.stopTaskLoop()
    const storageNotReady = isAiStorageNotReady(error)
    this.setData({
      generating: false,
      canceling: false,
      stepError: '',
      taskDiagnosticStage: error && typeof error.stage === 'string' ? error.stage : '',
      ...(storageNotReady ? aiStorageUnavailableState() : {}),
    })
    if (this.currentTask) {
      const task = this.currentTask
      const retryable = !storageNotReady && (isActiveTask(task) || task.status === 'succeeded'
        ? this.data.aiStatus === 'ready'
        : failurePolicy(task.errorCode, task.status).retryable)
      this.renderTask(this.currentTask, { interrupted: true })
      this.setData({
        taskDetail: errorMessage(error, '连接中断，本次生成仍可继续。'),
        taskCanRetry: retryable,
      })
    } else {
      const retryable = !storageNotReady && (!error || !error.code || failurePolicy(error.code, 'failed').retryable)
      this.setData({
        taskVisible: true,
        taskInterrupted: true,
        taskTitle: storageNotReady ? '餐单生成暂不可用' : '正在确认生成状态',
        taskDetail: errorMessage(error, '连接中断，可使用相同请求继续尝试。'),
        taskCanCancel: false,
        taskCanRetry: retryable,
        taskCanEdit: true,
        taskRetryLabel: '继续任务',
      })
    }
  },

  markTaskRecoveryInterrupted(error) {
    if (!this.currentTask) {
      if (isAiStorageNotReady(error)) this.setData(aiStorageUnavailableState())
      return
    }
    this.stopTaskLoop()
    const storageNotReady = isAiStorageNotReady(error)
    this.setData({
      generating: false,
      canceling: false,
      stepError: '',
      taskDiagnosticStage: error && typeof error.stage === 'string' ? error.stage : '',
      ...(storageNotReady ? aiStorageUnavailableState() : {}),
    })
    this.renderTask(this.currentTask, { interrupted: true })
    const task = this.currentTask
    const terminalRetryable = task && !isActiveTask(task) && task.status !== 'succeeded'
      ? failurePolicy(task.errorCode, task.status).retryable
      : false
    this.setData({
      taskDetail: storageNotReady
        ? AI_STORAGE_NOT_READY_DETAIL
        : isActiveTask(this.currentTask)
          ? '暂时无法同步生成进度。本次生成已保存，可检查网络后继续或取消。'
          : '暂时无法同步候选餐单。内容已保存，可检查网络后继续。',
      taskCanRetry: !storageNotReady && (isActiveTask(task)
        ? this.data.aiStatus === 'ready'
        : task && task.status === 'succeeded' ? true : terminalRetryable),
    })
  },

  async recoverTask() {
    if (!this.pageActive || this.data.generating) return
    let cached = aiPlanner.loadCachedTask()
    if (cached && (isActiveTask(cached) || cached.status === 'succeeded')) {
      this.currentTask = cached
      this.renderTask(cached)
    } else if (cached) {
      aiPlanner.clearCachedTask(cached.taskId)
      cached = null
    }
    try {
      const current = await aiPlanner.currentTask()
      if (!this.pageActive) return
      if (!current) {
        if (cached && cached.status === 'succeeded') {
          await this.resumeTask(cached.taskId)
          return
        } else if (cached && isActiveTask(cached)) {
          aiPlanner.clearCachedTask(cached.taskId)
          this.resetTaskPanel()
        }
        try {
          const failure = await aiPlanner.recentFailure()
          if (this.pageActive && !this.data.taskVisible && failure) this.renderRecentFailure(failure)
        } catch (_) {
          // recentFailure is optional diagnostic recovery; it must never replace service status.
        }
        return
      }
      await this.applyTaskResponse(current)
    } catch (error) {
      if (cached && (isActiveTask(cached) || cached.status === 'succeeded')) {
        this.markTaskRecoveryInterrupted(error)
        return
      }
      if (isAiStorageNotReady(error)) this.setData(aiStorageUnavailableState())
      // current 只是恢复查询。没有可恢复任务时，查询失败不能覆盖生成服务自身的状态。
    }
  },

  async resumeTask(taskId) {
    if (!this.pageActive || this.data.generating) return
    this.setData({ generating: true, canceling: false, stepError: '' })
    try {
      const response = await aiPlanner.statusTask(taskId)
      if (!this.pageActive) return
      await this.applyTaskResponse(response)
    } catch (error) {
      if (this.pageActive) this.markTaskInterrupted(error)
    }
  },

  async applyTaskResponse(response) {
    const task = response && response.task
    if (!task) throw new Error('生成任务进度不完整，请重新加载')
    if (!this.pageActive) {
      this.currentTask = task
      this.setData({ generating: false, canceling: false })
      this.renderTask(task, { interrupted: isActiveTask(task) || task.status === 'succeeded' })
      return
    }
    this.renderTask(task)
    if (task.status === 'succeeded') {
      await this.finishSucceededTask(response)
      return
    }
    if (!isActiveTask(task)) {
      this.stopTaskLoop()
      this.setData({ generating: false, canceling: false })
      return
    }
    if (this.data.aiStatus !== 'ready') {
      this.stopTaskLoop()
      this.setData({ generating: false, canceling: false })
      this.renderTask(task, { interrupted: true })
      this.setData({
        taskTitle: '生成服务暂不可用，任务仍已保留',
        taskDetail: '可以取消本次任务；服务恢复后再继续生成。',
        taskCanRetry: false,
      })
      return
    }
    this.setData({ generating: true, canceling: false })
    this.scheduleTaskAdvance(task.taskId, task.nextPollAfterMs)
  },

  async finishSucceededTask(response) {
    this.stopTaskLoop()
    try {
      const expectedDraftPlanId = response.draftPlan && response.draftPlan.id
      await userStore.init({ force: true })
      if (!userStore.data || !userStore.data.draftPlan
        || (expectedDraftPlanId && userStore.data.draftPlan.id !== expectedDraftPlanId)) {
        throw new Error('候选餐单正在同步，请点击继续')
      }
      aiPlanner.clearCachedTask(response.task.taskId)
      this.resetTaskPanel()
      wx.navigateTo({ url: PREVIEW_URL })
    } catch (error) {
      this.setData({ generating: false })
      this.renderTask(response.task, { interrupted: true })
      this.setData({ taskTitle: '候选餐单已生成，等待同步', taskDetail: errorMessage(error, '请点击继续同步候选餐单。') })
    }
  },

  async generatePlan() {
    if (this.data.generating) return
    for (let step = 0; step < STEP_TITLES.length - 1; step += 1) {
      const error = this.validateStep(step)
      if (error) {
        this.setData({ currentStep: step, stepError: error, exerciseErrorsVisible: step === 4 })
        this.renderPreferences(this.data.preferences)
        const invalid = step === 4
          ? validateExercisePlan(this.data.preferences, this.exerciseDurationDrafts || {})
          : null
        if (invalid && Number.isInteger(invalid.dayIndex)) {
          wx.pageScrollTo({ selector: `#exercise-day-${invalid.dayIndex}`, offsetTop: -16, duration: 180 })
        }
        else wx.pageScrollTo({ scrollTop: 0, duration: 180 })
        return
      }
    }
    if (this.data.aiStatus !== 'ready'
      || !Number.isSafeInteger(this.data.providerRevision) || this.data.providerRevision < 1) {
      this.setData({ stepError: '生成服务暂时不可用。你的选择已保存，请稍后重试。' })
      return
    }
    if (!this.data.aiDataConsentAccepted) {
      this.setData({ stepError: '请先单独勾选同意将上述数据发送至 AI 服务' })
      return
    }

    this.stopTaskLoop()
    this.setData({ generating: true, canceling: false, stepError: '', aiDataConsentAccepted: false })
    this.renderStartingTask()
    try {
      const preferences = normalizePreferences(this.data.preferences)
      const saved = await userStore.patch({ generationPreferences: preferences }, { immediate: true })
      this.pendingStart = {
        preferences,
        expectedStateRevision: saved.stateRevision,
        clientRequestId: await createClientRequestId(),
        consentVersion: AI_DATA_CONSENT_VERSION,
        providerRevision: this.data.providerRevision,
      }
      const response = await aiPlanner.start(
        this.pendingStart.preferences,
        this.pendingStart.expectedStateRevision,
        this.pendingStart.clientRequestId,
        this.pendingStart.consentVersion,
        this.pendingStart.providerRevision,
      )
      this.pendingStart = null
      await this.applyTaskResponse(response)
    } catch (error) {
      this.markTaskInterrupted(error)
    }
  },

  async retryTask() {
    if (this.data.generating || this.data.canceling) return
    if (this.pendingStart) {
      if (this.data.aiStatus !== 'ready') {
        this.setData({ stepError: '生成服务尚未恢复，请先重试服务检查' })
        return
      }
      this.setData({ generating: true, taskInterrupted: false, taskCanRetry: false })
      try {
        const response = await aiPlanner.start(
          this.pendingStart.preferences,
          this.pendingStart.expectedStateRevision,
          this.pendingStart.clientRequestId,
          this.pendingStart.consentVersion,
          this.pendingStart.providerRevision,
        )
        this.pendingStart = null
        await this.applyTaskResponse(response)
      } catch (error) {
        this.markTaskInterrupted(error)
      }
      return
    }
    if (this.currentTask && (isActiveTask(this.currentTask) || this.currentTask.status === 'succeeded')) {
      if (isActiveTask(this.currentTask) && this.data.aiStatus !== 'ready') {
        this.setData({ stepError: '生成服务尚未恢复；当前任务仍可取消' })
        return
      }
      await this.resumeTask(this.currentTask.taskId)
      return
    }
    if (this.currentTask) aiPlanner.clearCachedTask(this.currentTask.taskId)
    this.resetTaskPanel()
    wx.pageScrollTo({ scrollTop: 0, duration: 180 })
  },

  retryGenerate() { this.retryTask() },

  editConditions() {
    if (this.currentTask && isActiveTask(this.currentTask)) return
    if (this.currentTask) aiPlanner.clearCachedTask(this.currentTask.taskId)
    this.resetTaskPanel()
    this.setData({ currentStep: 0, stepError: '', exerciseErrorsVisible: false })
    this.renderPreferences(this.data.preferences)
    wx.pageScrollTo({ scrollTop: 0, duration: 180 })
  },

  returnToCurrentPlan() {
    wx.switchTab({ url: '/pages/plan/plan' })
  },

  cancelGeneration() {
    const task = this.currentTask
    if (!task || !isActiveTask(task) || this.data.canceling) return
    wx.showModal({
      title: '取消本次生成？',
      content: '已生成的临时片段会停止处理，当前正在使用的餐单不会改变。',
      confirmText: '取消生成',
      confirmColor: '#a33f2b',
      success: async (modal) => {
        if (!modal.confirm) return
        this.stopTaskLoop()
        this.setData({ canceling: true, generating: false, taskCanCancel: false })
        try {
          const response = await aiPlanner.cancel(task.taskId, task.taskRevision)
          this.renderTask(response.task)
          aiPlanner.clearCachedTask(task.taskId)
          this.setData({ canceling: false, generating: false, taskCanCancel: false })
        } catch (error) {
          this.renderTask(task, { interrupted: true })
          this.setData({
            canceling: false,
            generating: false,
            taskTitle: '未能确认取消结果',
            taskDetail: errorMessage(error, '请重试连接；当前餐单没有改变。'),
          })
        }
      },
    })
  },
})
