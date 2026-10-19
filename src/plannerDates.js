export function dateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date, amount) {
  const result = new Date(date)
  result.setDate(result.getDate() + amount)
  return result
}

export function rollingDates(startDate) {
  const start = startOfDay(startDate)
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

export function timelineDates(startDate, weeksBefore = 0, weeksAfter = 0) {
  const start = startOfDay(startDate)
  const dayCount = 7 + (weeksBefore + weeksAfter) * 7
  return Array.from({ length: dayCount }, (_, index) => addDays(start, index - weeksBefore * 7))
}

export function formatRange(start, end) {
  return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric', year: start.getFullYear() !== end.getFullYear() ? 'numeric' : undefined })}`
}

export const BIZKAIA_FISCAL_CALENDAR = [
  { month: 1, day: 25, title: 'Modelo 130 & 303 (Q4)' },
  { month: 2, day: 28, title: 'Modelo 140 (Annual)' },
  { month: 4, day: 25, title: 'Modelo 130 & 303 (Q1)' },
  { month: 6, day: 30, title: 'Declaración de la Renta (Deadline)' },
  { month: 7, day: 25, title: 'Modelo 130 & 303 (Q2)' },
  { month: 10, day: 25, title: 'Modelo 130 & 303 (Q3)' },
]

export function getBizkaiaTaxDeadline(date) {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const deadline = BIZKAIA_FISCAL_CALENDAR.find((entry) => entry.month === month && entry.day === day)
  if (!deadline) return null

  const key = dateKey(date)
  return {
    id: `bizkaia-tax-deadline-${key}`,
    type: 'task',
    title: deadline.title,
    date: key,
    status: 'scheduled',
    time: null,
    dueDate: key,
    isTaxDeadline: true,
  }
}

export function isFixedEvent(item) {
  return typeof item.date === 'string' && item.date.length > 0 &&
    typeof item.time === 'string' && item.time.length > 0
}

export function getMultiDayEventSegments(items, dates, columns = dates.length) {
  if (!columns || !dates.length) return []
  const visibleDates = dates.map(dateKey)
  const lanesByRow = new Map()
  const segments = []
  const events = items
    .filter((item) => isFixedEvent(item) && item.endDate > item.date)
    .sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time) || left.id.localeCompare(right.id))

  for (const item of events) {
    const indices = visibleDates
      .map((key, index) => key >= item.date && key <= item.endDate ? index : -1)
      .filter((index) => index >= 0)
    if (!indices.length) continue

    let segmentStart = indices[0]
    let segmentEnd = indices[0] + 1
    const addSegment = (startIndex, endIndex) => {
      const row = Math.floor(startIndex / columns)
      const laneIntervals = lanesByRow.get(row) ?? []
      const lane = laneIntervals.findIndex((intervals) =>
        intervals.every((interval) => endIndex <= interval.start || startIndex >= interval.end),
      )
      const assignedLane = lane < 0 ? laneIntervals.length : lane
      if (!laneIntervals[assignedLane]) laneIntervals[assignedLane] = []
      laneIntervals[assignedLane].push({ start: startIndex, end: endIndex })
      lanesByRow.set(row, laneIntervals)
      segments.push({
        item,
        startIndex,
        endIndex,
        startDate: visibleDates[startIndex],
        endDate: visibleDates[endIndex - 1],
        row,
        lane: assignedLane,
      })
    }

    for (let index = 1; index < indices.length; index += 1) {
      const currentIndex = indices[index]
      if (currentIndex !== segmentEnd || Math.floor(currentIndex / columns) !== Math.floor(segmentStart / columns)) {
        addSegment(segmentStart, segmentEnd)
        segmentStart = currentIndex
      }
      segmentEnd = currentIndex + 1
    }
    addSegment(segmentStart, segmentEnd)
  }

  return segments
}

export function getNextUpcomingEvent(items, now = new Date()) {
  return items
    .filter((item) => item.type === 'event' && isFixedEvent(item) && item.status !== 'completed' &&
      typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
      typeof item.time === 'string' && /^\d{2}:\d{2}$/.test(item.time))
    .map((item) => ({ item, startsAt: new Date(`${item.date}T${item.time}:00`) }))
    .filter(({ item, startsAt }) => Number.isFinite(startsAt.getTime()) &&
      dateKey(startsAt) === item.date &&
      startsAt.getHours() === Number(item.time.slice(0, 2)) &&
      startsAt.getMinutes() === Number(item.time.slice(3, 5)) &&
      startsAt > now)
    .sort((left, right) => left.startsAt - right.startsAt)[0] ?? null
}

export function getSpotlightCandidates(notes, items, today) {
  const notesToShow = notes
    .filter((note) => !note.archived && note.text?.trim() && (!note.spotlightSnoozedUntil || note.spotlightSnoozedUntil <= today))
    .map((note) => ({
      key: `note-${note.id}`,
      kind: 'note',
      id: note.id,
      content: note.text,
      sourceDate: note.updatedAt,
      pinned: Boolean(note.pinned),
      rank: note.pinned ? 0 : 4,
    }))

  const tasksToShow = items
    .filter((item) => item.type === 'task' && item.status !== 'completed' && (!item.spotlightSnoozedUntil || item.spotlightSnoozedUntil <= today))
    .map((item) => {
      const overdue = (item.dueDate && item.dueDate < today) ||
        (item.date && item.date < today) ||
        (!item.date && item.originalScheduledDate && item.originalScheduledDate < today)
      const upcoming = item.dueDate && item.dueDate >= today && item.dueDate <= dateKey(addDays(new Date(`${today}T12:00:00`), 7))
      return {
        key: `task-${item.id}`,
        kind: 'task',
        id: item.id,
        content: item.title,
        sourceDate: item.date || item.originalScheduledDate || null,
        dueDate: item.dueDate || null,
        pinned: Boolean(item.pinned),
        rank: item.pinned ? 0 : overdue ? 1 : upcoming ? 2 : item.status === 'inbox' ? 3 : 4,
      }
    })

  return [...notesToShow, ...tasksToShow].sort((left, right) =>
    left.rank - right.rank ||
    (left.dueDate || '9999-12-31').localeCompare(right.dueDate || '9999-12-31') ||
    (typeof right.sourceDate === 'number' && typeof left.sourceDate === 'number' ? right.sourceDate - left.sourceDate : 0) ||
    left.key.localeCompare(right.key),
  )
}

export function recordScheduleChange(item, nextDate, reason, changedAt = new Date().toISOString()) {
  if ((item.date || null) === (nextDate || null)) return item
  return {
    ...item,
    originalScheduledDate: item.originalScheduledDate || item.date || nextDate || null,
    scheduleHistory: [
      ...(Array.isArray(item.scheduleHistory) ? item.scheduleHistory : []),
      { from: item.date || null, to: nextDate || null, at: changedAt, reason },
    ],
  }
}

export function recordFrogChange(item, nextDate, action, changedAt = new Date().toISOString()) {
  if ((item.frogDate || null) === (nextDate || null)) return item
  return {
    ...item,
    frogDate: nextDate || null,
    frogHistory: [
      ...(Array.isArray(item.frogHistory) ? item.frogHistory : []),
      { from: item.frogDate || null, to: nextDate || null, at: changedAt, action },
    ],
  }
}
