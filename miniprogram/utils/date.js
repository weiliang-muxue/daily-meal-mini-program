function currentDayIndex() {
  const day = new Date().getDay()
  return day === 0 ? 6 : day - 1
}

function formatUpdatedAt(value) {
  if (!value) return '尚未同步'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '已同步'
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pad(value) { return String(value).padStart(2, '0') }
function dateKey(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
function monthKey(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}` }
function shiftMonth(month, offset) {
  const [year, value] = month.split('-').map(Number)
  return monthKey(new Date(year, value - 1 + offset, 1))
}
function monthLabel(month) { const [year, value] = month.split('-'); return `${year} 年 ${Number(value)} 月` }

function calendarCells(month, records = []) {
  const [year, value] = month.split('-').map(Number)
  const firstDay = new Date(year, value - 1, 1).getDay()
  const mondayOffset = firstDay === 0 ? 6 : firstDay - 1
  const daysInMonth = new Date(year, value, 0).getDate()
  const recordMap = Object.fromEntries(records.map((item) => [item.date, item]))
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - mondayOffset + 1
    if (day < 1 || day > daysInMonth) return { key: `empty-${index}`, empty: true }
    const date = `${month}-${pad(day)}`
    const record = recordMap[date] || {}
    return {
      key: date, date, day, empty: false,
      isToday: date === dateKey(), weightText: typeof record.weight === 'number' ? `${record.weight}` : '',
      exercised: Boolean(record.exercise && record.exercise.completed), hasPhoto: Boolean(record.hasPhoto || record.photoFileId), record,
    }
  })
}

module.exports = { currentDayIndex, formatUpdatedAt, dateKey, monthKey, shiftMonth, monthLabel, calendarCells }
