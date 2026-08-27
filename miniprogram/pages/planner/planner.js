'use strict'

const { membershipStore } = require('../../services/membership-store')
const { userStore } = require('../../services/user-store')
const {
  aiPlanner,
  createClientRequestId,
  isActiveTask,
  taskPresentation,
} = require('../../services/ai-planner')

const CONTRACT_VERSION = 1
const PREVIEW_URL = '/pages/plan-preview/plan-preview'
const MEAL_OPTIONS = [
  { value: 'breakfast', label: '早餐', detail: '起床后的第一餐' },
  { value: 'lunch', label: '午餐', detail: '白天的正餐' },
  { value: 'dinner', label: '晚餐', detail: '晚间正餐' },
  { value: 'snack', label: '加餐', detail: '按需安排的小份餐食' },
]
const GOAL_OPTIONS = ['均衡饮食', '高碳水', '高蛋白', '控制能量', '补钙与维生素 D']
const STYLE_OPTIONS = ['清淡低油', '家常中式', '简单快手', '少盐', '食材易买']
const INTENSITY_OPTIONS = [
  { value: 'low', label: '低强度' },
  { value: 'medium', label: '中强度' },
  { value: 'high', label: '高强度' },
]
const STEP_TITLES = ['选择餐次', '周期与日期', '目标与风格', '饮食约束', '运动安排', '确认生成']

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
    durationDays: 7,
    startDate,
    mealTypes: [],
    doubleDinner: false,
    goals: [],
    styles: [],
    customGoal: '',
    restrictions: '',
    healthNotes: '',
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
  const durationDays = source.durationDays === 14 ? 14 : 7
  const mealTypes = cleanArray(source.mealTypes, MEAL_OPTIONS.map((item) => item.value))
  const startDate = parseDate(source.startDate) ? source.startDate : fallback.startDate
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

function buildExerciseDays(preferences) {
  return preferences.exerciseByDay.map((exercise, dayIndex) => {
    const date = addDays(preferences.startDate, dayIndex)
    return {
      ...exercise,
      date,
      label: `第 ${dayIndex + 1} 天`,
      weekday: weekday(date),
      durationText: exercise.durationMinutes ? String(exercise.durationMinutes) : '',
      intensityOptions: INTENSITY_OPTIONS.map((item) => ({ ...item, checked: exercise.intensity === item.value })),
    }
  })
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
    { label: '运动', value: plannedDays ? `计划 ${plannedDays} 天运动` : '未安排运动' },
  ]
}

function errorMessage(error, fallback) {
  return error && error.message ? error.message : fallback
}

function taskFailureDetail(task) {
  const code = task && task.errorCode
  if (code === 'STATE_REVISION_CONFLICT') return '其他设备或页面已经更新数据，请刷新设置后重新生成。'
  if (code === 'AI_RATE_LIMITED') return '生成次数暂时达到上限，请稍后再试。'
  if (code === 'AI_TIMEOUT') return '本次生成片段超时，可重新发起任务。'
  if (code === 'AI_CONFIGURATION_INVALID') return '生成服务配置不可用，请联系管理员检查云函数。'
  if (task && task.status === 'expired') return '任务保留时间已结束，请重新生成。'
  if (task && task.status === 'cancelled') return '任务已停止，没有替换当前计划。'
  return '候选计划没有写入当前计划，可重新生成。'
}

Page({
  data: {
    currentStep: 0,
    stepNumber: 1,
    stepCount: STEP_TITLES.length,
    stepTitle: STEP_TITLES[0],
    stepItems: STEP_TITLES.map((title, index) => ({ title, index, state: index === 0 ? 'current' : 'upcoming' })),
    preferences: defaultPreferences(beijingToday()),
    mealOptions: selectedOptions(MEAL_OPTIONS, []),
    goalOptions: GOAL_OPTIONS.map((label) => ({ label, checked: false })),
    styleOptions: STYLE_OPTIONS.map((label) => ({ label, checked: false })),
    exerciseDays: [],
    summaryRows: [],
    hasDinner: false,
    aiStatus: 'loading',
    aiStatusTitle: '正在检查生成服务',
    aiStatusDetail: '只检查服务是否可用，不会发送你的选择。',
    loadingPage: true,
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
    taskRetryLabel: '继续任务',
  },

  onLoad() {
    this.pageActive = true
    this.connected = false
    this.taskLoopToken = 0
    this.taskLoopTimer = null
    this.preferenceSaveTimer = null
    this.currentTask = null
    this.pendingStart = null
    this.connect()
  },

  onShow() {
    this.pageActive = true
    if (!this.connected) return
    if (this.currentTask && (isActiveTask(this.currentTask) || this.currentTask.status === 'succeeded')) this.resumeTask(this.currentTask.taskId)
    else if (!this.data.generating && !this.data.taskVisible) this.recoverTask()
  },

  onHide() {
    this.pageActive = false
    this.stopTaskLoop()
    this.flushPreferenceDraft()
    if (this.currentTask && isActiveTask(this.currentTask)) {
      this.setData({ generating: false })
      this.renderTask(this.currentTask, { interrupted: true })
    }
  },

  onUnload() {
    this.pageActive = false
    this.stopTaskLoop()
    clearTimeout(this.preferenceSaveTimer)
    this.preferenceSaveTimer = null
    this.flushPreferenceDraft()
  },

  async connect(force = false) {
    this.setData({ loadingPage: true, pageError: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') {
        wx.reLaunch({ url: '/pages/access/access' })
        return
      }
      const state = await userStore.init({ force })
      const preferences = normalizePreferences(state.generationPreferences)
      this.renderPreferences(preferences)
      this.connected = true
      this.setData({ loadingPage: false })
      await this.checkAiStatus()
      try { await this.recoverTask() } catch (error) {
        this.setData({
          aiStatus: 'error',
          aiStatusTitle: '任务状态暂时无法读取',
          aiStatusDetail: errorMessage(error, '定制条件仍可编辑，检查网络后重试。'),
        })
      }
    } catch (error) {
      this.setData({
        loadingPage: false,
        pageError: errorMessage(error, '无法加载定制设置，请重试'),
        aiStatus: 'error',
        aiStatusTitle: '暂时无法连接',
        aiStatusDetail: '检查网络后重试，不会丢失已在本机保存的选择。',
      })
    }
  },

  async checkAiStatus() {
    this.setData({ aiStatus: 'loading', aiStatusTitle: '正在检查生成服务', aiStatusDetail: '只检查服务是否可用，不会发送你的选择。' })
    try {
      const status = await aiPlanner.status()
      if (status && status.configured === true && Number(status.contractVersion) === CONTRACT_VERSION) {
        this.setData({ aiStatus: 'ready', aiStatusTitle: '生成服务可用', aiStatusDetail: '完成六步选择后，可以生成候选餐单。' })
        return true
      } else if (status && status.configured === true) {
        this.setData({ aiStatus: 'error', aiStatusTitle: '服务版本不匹配', aiStatusDetail: '请等待管理员更新生成服务后重试。' })
      } else {
        this.setData({ aiStatus: 'unconfigured', aiStatusTitle: '生成服务尚未配置', aiStatusDetail: '管理员需要在云函数中完成 AI 配置；你的选择仍会保存在本机。' })
      }
    } catch (error) {
      this.setData({ aiStatus: 'error', aiStatusTitle: '生成服务暂不可用', aiStatusDetail: errorMessage(error, '请检查网络后重试。') })
    }
    return false
  },

  retryConnect() { this.connect(true) },
  async retryAiStatus() {
    await this.checkAiStatus()
    try { await this.recoverTask() } catch (error) {
      this.setData({ aiStatus: 'error', aiStatusTitle: '任务状态暂时无法读取', aiStatusDetail: errorMessage(error, '请检查网络后重试。') })
    }
  },

  renderPreferences(raw) {
    const preferences = normalizePreferences(raw)
    const currentStep = this.data.currentStep
    this.setData({
      preferences,
      mealOptions: selectedOptions(MEAL_OPTIONS, preferences.mealTypes),
      goalOptions: GOAL_OPTIONS.map((label) => ({ label, checked: preferences.goals.includes(label) })),
      styleOptions: STYLE_OPTIONS.map((label) => ({ label, checked: preferences.styles.includes(label) })),
      exerciseDays: buildExerciseDays(preferences),
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
      if (this.pageActive) this.setData({ stepError: errorMessage(error, '选择已保存在本机，联网后会自动同步') })
      return userStore.data
    })
  },

  onMealsChange(event) {
    const mealTypes = cleanArray(event.detail.value, MEAL_OPTIONS.map((item) => item.value))
    this.updatePreferences({ mealTypes, doubleDinner: mealTypes.includes('dinner') && this.data.preferences.doubleDinner })
    this.setData({ stepError: '' })
  },

  chooseDuration(event) {
    const durationDays = Number(event.currentTarget.dataset.days) === 14 ? 14 : 7
    const current = this.data.preferences.exerciseByDay
    const exerciseByDay = Array.from({ length: durationDays }, (_, dayIndex) => current[dayIndex] || {
      dayIndex, planned: false, type: '', durationMinutes: 0, intensity: 'medium',
    })
    this.updatePreferences({ durationDays, exerciseByDay })
    this.setData({ stepError: '' })
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

  toggleExercise(event) {
    const dayIndex = Number(event.currentTarget.dataset.index)
    const exerciseByDay = this.data.preferences.exerciseByDay.map((item) => item.dayIndex === dayIndex ? {
      ...item,
      planned: !item.planned,
      type: item.planned ? '' : item.type,
      durationMinutes: item.planned ? 0 : item.durationMinutes,
      intensity: item.planned ? 'medium' : item.intensity,
    } : item)
    this.updatePreferences({ exerciseByDay })
  },

  inputExerciseType(event) {
    this.patchExercise(Number(event.currentTarget.dataset.index), { type: event.detail.value })
  },

  inputExerciseDuration(event) {
    const raw = String(event.detail.value || '').replace(/\D/g, '').slice(0, 3)
    const durationMinutes = raw ? Math.min(360, Number(raw)) : 0
    this.patchExercise(Number(event.currentTarget.dataset.index), { durationMinutes })
  },

  chooseIntensity(event) {
    const intensity = event.currentTarget.dataset.intensity
    if (!['low', 'medium', 'high'].includes(intensity)) return
    this.patchExercise(Number(event.currentTarget.dataset.index), { intensity })
  },

  patchExercise(dayIndex, patch) {
    const exerciseByDay = this.data.preferences.exerciseByDay.map((item) => item.dayIndex === dayIndex ? { ...item, ...patch } : item)
    this.updatePreferences({ exerciseByDay })
  },

  onDoubleDinnerChange(event) {
    this.updatePreferences({ doubleDinner: this.data.hasDinner && event.detail.value.includes('enabled') })
  },

  validateStep(step) {
    const preferences = this.data.preferences
    if (step === 0 && preferences.mealTypes.length === 0) return '请至少选择一个餐次'
    if (step === 1 && ![7, 14].includes(preferences.durationDays)) return '请选择 7 天或 14 天'
    if (step === 1 && !parseDate(preferences.startDate)) return '请选择有效的开始日期'
    if (step === 4) {
      const invalid = preferences.exerciseByDay.find((item) => item.planned && item.durationMinutes > 360)
      if (invalid) return `第 ${invalid.dayIndex + 1} 天运动时长不能超过 360 分钟`
    }
    return ''
  },

  goNext() {
    const error = this.validateStep(this.data.currentStep)
    if (error) {
      this.setData({ stepError: error })
      return
    }
    const currentStep = Math.min(STEP_TITLES.length - 1, this.data.currentStep + 1)
    this.setData({ currentStep, stepError: '' })
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
      taskTitle: '正在建立生成任务',
      taskDetail: '云端会按小片段逐步生成，当前计划保持不变。',
      taskPercent: 0,
      taskPercentText: '0%',
      taskStages: [
        { key: 'outline', label: '提纲', detail: '拆分日期与餐次结构', state: 'current' },
        { key: 'details', label: '明细', detail: '逐片生成餐食与食材', state: 'pending' },
        { key: 'validation', label: '校验', detail: '合并并检查完整性', state: 'pending' },
      ],
      taskCanCancel: false,
      taskCanRetry: false,
      taskCanEdit: false,
      taskRetryLabel: '继续任务',
    })
  },

  renderTask(task, options = {}) {
    const interrupted = options.interrupted === true
    const presentation = taskPresentation(task, interrupted)
    const terminalDetail = !isActiveTask(task) && task.status !== 'succeeded' ? taskFailureDetail(task) : ''
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
      taskStages: presentation.stages,
      taskCanCancel: presentation.canCancel,
      taskCanRetry: presentation.canRetry,
      taskCanEdit: !isActiveTask(task) && task.status !== 'succeeded',
      taskRetryLabel: interrupted || task.status === 'succeeded' ? '继续任务' : '重新生成',
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
      taskRetryLabel: '继续任务',
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
    this.setData({ generating: false, canceling: false, stepError: '' })
    if (this.currentTask) {
      this.renderTask(this.currentTask, { interrupted: true })
      this.setData({
        taskDetail: errorMessage(error, '连接中断，云端任务仍可继续。'),
        taskCanRetry: this.data.aiStatus === 'ready',
      })
    } else {
      this.setData({
        taskVisible: true,
        taskInterrupted: true,
        taskTitle: '尚未确认任务是否建立',
        taskDetail: errorMessage(error, '连接中断，可使用相同请求继续尝试。'),
        taskCanCancel: false,
        taskCanRetry: true,
        taskCanEdit: true,
        taskRetryLabel: '继续任务',
      })
    }
  },

  async recoverTask() {
    if (!this.pageActive || this.data.generating) return
    const cached = aiPlanner.loadCachedTask()
    if (cached) {
      this.currentTask = cached
      this.renderTask(cached)
    }
    try {
      const current = await aiPlanner.currentTask()
      if (!this.pageActive) return
      if (!current) {
        if (cached && cached.status === 'succeeded') {
          await this.resumeTask(cached.taskId)
        } else if (cached && isActiveTask(cached)) {
          aiPlanner.clearCachedTask(cached.taskId)
          this.resetTaskPanel()
        }
        return
      }
      await this.applyTaskResponse(current)
    } catch (error) {
      if (cached && (isActiveTask(cached) || cached.status === 'succeeded')) {
        this.markTaskInterrupted(error)
        return
      }
      if (!cached) throw error
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
      if (response.draftPlan && Number.isInteger(response.stateRevision)) {
        const current = userStore.data
        userStore.replaceFromCloud({
          ...current,
          draftPlan: response.draftPlan,
          stateRevision: response.stateRevision,
          generationPreferences: response.generationPreferences || current.generationPreferences,
          updatedAt: response.updatedAt || current.updatedAt,
        })
      } else {
        await userStore.init({ force: true })
      }
      if (!userStore.data || !userStore.data.draftPlan) throw new Error('候选计划正在同步，请点击继续')
      aiPlanner.clearCachedTask(response.task.taskId)
      this.resetTaskPanel()
      wx.navigateTo({ url: PREVIEW_URL })
    } catch (error) {
      this.setData({ generating: false })
      this.renderTask(response.task, { interrupted: true })
      this.setData({ taskTitle: '候选计划已生成，等待同步', taskDetail: errorMessage(error, '请点击继续同步候选计划。') })
    }
  },

  async generatePlan() {
    if (this.data.generating) return
    for (let step = 0; step < STEP_TITLES.length - 1; step += 1) {
      const error = this.validateStep(step)
      if (error) {
        this.setData({ currentStep: step, stepError: error })
        this.renderPreferences(this.data.preferences)
        wx.pageScrollTo({ scrollTop: 0, duration: 180 })
        return
      }
    }
    if (this.data.aiStatus !== 'ready') {
      this.setData({ stepError: '生成服务当前不可用，请先重试服务检查' })
      return
    }

    this.stopTaskLoop()
    this.setData({ generating: true, canceling: false, stepError: '' })
    this.renderStartingTask()
    try {
      const preferences = normalizePreferences(this.data.preferences)
      const saved = await userStore.patch({ generationPreferences: preferences }, { immediate: true })
      this.pendingStart = {
        preferences,
        expectedStateRevision: saved.stateRevision,
        clientRequestId: await createClientRequestId(),
      }
      const response = await aiPlanner.start(
        this.pendingStart.preferences,
        this.pendingStart.expectedStateRevision,
        this.pendingStart.clientRequestId,
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
    await this.generatePlan()
  },

  retryGenerate() { this.retryTask() },

  editConditions() {
    if (this.currentTask && isActiveTask(this.currentTask)) return
    if (this.currentTask) aiPlanner.clearCachedTask(this.currentTask.taskId)
    this.resetTaskPanel()
  },

  cancelGeneration() {
    const task = this.currentTask
    if (!task || !isActiveTask(task) || this.data.canceling) return
    wx.showModal({
      title: '取消本次生成？',
      content: '已生成的临时片段会停止处理，当前正在使用的计划不会改变。',
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
          this.setData({ canceling: false, generating: false, taskCanCancel: false, taskCanRetry: true })
        } catch (error) {
          this.renderTask(task, { interrupted: true })
          this.setData({
            canceling: false,
            generating: false,
            taskTitle: '未能确认取消结果',
            taskDetail: errorMessage(error, '请重试连接；当前计划没有改变。'),
          })
        }
      },
    })
  },
})
