import assert from 'node:assert/strict'
import test from 'node:test'
import { addDays, BIZKAIA_FISCAL_CALENDAR, dateKey, getBizkaiaTaxDeadline, getMultiDayEventSegments, getNextUpcomingEvent, getSpotlightCandidates, isFixedEvent, returnOverdueTasks, rollingDates, timelineDates } from '../src/plannerDates.js'

function keys(dates) {
  return dates.map(dateKey)
}

test('rolling horizon starts on Saturday and continues through Friday', () => {
  const saturday = new Date(2026, 9, 10, 15, 30)
  assert.deepEqual(keys(rollingDates(saturday)), [
    '2026-10-10',
    '2026-10-11',
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
  ])
})

test('rolling horizon starts on Monday and continues through Sunday', () => {
  const monday = new Date(2026, 9, 12, 8, 0)
  assert.deepEqual(keys(rollingDates(monday)), [
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
    '2026-10-17',
    '2026-10-18',
  ])
})

test('only overdue unfinished tasks return to the deck with dates and history preserved', () => {
  const items = [
    {
      id: 'unfinished-frog',
      type: 'task',
      status: 'scheduled',
      date: '2026-10-09',
      time: null,
      frogDate: '2026-10-09',
      scheduleHistory: [{ from: null, to: '2026-10-09', at: 'before', reason: 'scheduled' }],
    },
    { id: 'completed-task', type: 'task', status: 'completed', date: '2026-10-09', frogDate: null },
    { id: 'past-event', type: 'event', status: 'scheduled', date: '2026-10-09', time: '09:30' },
    { id: 'today-task', type: 'task', status: 'scheduled', date: '2026-10-10', frogDate: null },
  ]

  const updated = returnOverdueTasks(items, '2026-10-10')
  const unfinished = updated.find((item) => item.id === 'unfinished-frog')

  assert.equal(updated.length, items.length)
  assert.equal(unfinished.date, null)
  assert.equal(unfinished.status, 'ready')
  assert.equal(unfinished.originalScheduledDate, '2026-10-09')
  assert.equal(unfinished.scheduleHistory.length, 2)
  assert.equal(unfinished.scheduleHistory[1].from, '2026-10-09')
  assert.equal(unfinished.scheduleHistory[1].to, null)
  assert.equal(unfinished.frogDate, null)
  assert.equal(unfinished.frogHistory[0].from, '2026-10-09')
  assert.equal(updated.find((item) => item.id === 'completed-task').date, '2026-10-09')
  assert.equal(updated.find((item) => item.id === 'past-event').date, '2026-10-09')
  assert.equal(updated.find((item) => item.id === 'today-task').date, '2026-10-10')
  assert.equal(updated.filter((item) => item.id === 'unfinished-frog').length, 1)
})

test('date navigation advances exactly seven local calendar days', () => {
  const start = new Date(2026, 9, 10)
  assert.equal(dateKey(addDays(start, 7)), '2026-10-17')
})

test('Bizkaia tax deadlines auto-populate as recurring frontend task records', () => {
  for (const { month, day, title } of BIZKAIA_FISCAL_CALENDAR) {
    for (const year of [2026, 2027]) {
      const deadline = getBizkaiaTaxDeadline(new Date(year, month - 1, day))
      assert.deepEqual(deadline, {
        id: `bizkaia-tax-deadline-${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        type: 'task',
        title,
        date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        status: 'scheduled',
        time: null,
        dueDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        isTaxDeadline: true,
      })
    }
  }
  assert.equal(getBizkaiaTaxDeadline(new Date(2026, 0, 24)), null)
})

test('fixed events are identified by having both a date and a time', () => {
  assert.equal(isFixedEvent({ type: 'event', date: '2026-10-11', time: '09:00' }), true)
  assert.equal(isFixedEvent({ type: 'task', date: '2026-10-11', time: '09:00' }), true)
  assert.equal(isFixedEvent({ type: 'event', date: '2026-10-11', time: null }), false)
  assert.equal(isFixedEvent({ type: 'task', date: null, time: null }), false)
})

test('multi-day events span consecutive weekly columns and overlapping events use separate lanes', () => {
  const dates = rollingDates(new Date(2026, 9, 10))
  const segments = getMultiDayEventSegments([
    { id: 'first', type: 'event', date: '2026-10-11', endDate: '2026-10-13', time: '09:00' },
    { id: 'overlap', type: 'event', date: '2026-10-12', endDate: '2026-10-14', time: '10:00' },
  ], dates)

  assert.deepEqual(segments.map(({ item, startIndex, endIndex, lane }) => ({ id: item.id, startIndex, endIndex, lane })), [
    { id: 'first', startIndex: 1, endIndex: 4, lane: 0 },
    { id: 'overlap', startIndex: 2, endIndex: 5, lane: 1 },
  ])
})

test('weekly multi-day events remain one continuous segment across an extended timeline', () => {
  const dates = timelineDates(new Date(2026, 9, 10), 0, 1)
  const segments = getMultiDayEventSegments([
    { id: 'continuous', type: 'event', date: '2026-10-12', endDate: '2026-10-20', time: '09:00' },
  ], dates)

  assert.equal(segments.length, 1)
  assert.equal(segments[0].startIndex, 2)
  assert.equal(segments[0].endIndex, 11)
  assert.equal(segments[0].startDate, '2026-10-12')
  assert.equal(segments[0].endDate, '2026-10-20')
})

test('multi-day event rendering uses date and time even if a stored item has a stale task type', () => {
  const segments = getMultiDayEventSegments([
    { id: 'legacy-event', type: 'task', date: '2026-10-11', endDate: '2026-10-12', time: '09:00' },
  ], rollingDates(new Date(2026, 9, 10)))

  assert.equal(segments.length, 1)
  assert.equal(segments[0].item.id, 'legacy-event')
  assert.equal(segments[0].startIndex, 1)
  assert.equal(segments[0].endIndex, 3)
})

test('monthly multi-day events split into connected row segments and clip to visible dates', () => {
  const dates = [...rollingDates(new Date(2026, 9, 1)), ...rollingDates(new Date(2026, 9, 8))]
  const segments = getMultiDayEventSegments([
    { id: 'cross-week', type: 'event', date: '2026-10-06', endDate: '2026-10-10', time: '09:00' },
    { id: 'outside', type: 'event', date: '2026-09-28', endDate: '2026-10-02', time: '08:00' },
  ], dates, 7)

  assert.deepEqual(segments.map(({ item, startIndex, endIndex, row, startDate, endDate }) => ({
    id: item.id, startIndex, endIndex, row, startDate, endDate,
  })), [
    { id: 'outside', startIndex: 0, endIndex: 2, row: 0, startDate: '2026-10-01', endDate: '2026-10-02' },
    { id: 'cross-week', startIndex: 5, endIndex: 7, row: 0, startDate: '2026-10-06', endDate: '2026-10-07' },
    { id: 'cross-week', startIndex: 7, endIndex: 10, row: 1, startDate: '2026-10-08', endDate: '2026-10-10' },
  ])
})

test('next upcoming event selects the nearest future fixed event only', () => {
  const now = new Date(2026, 9, 10, 10, 0)
  const items = [
    { id: 'later', type: 'event', status: 'scheduled', date: '2026-10-10', time: '12:00' },
    { id: 'soonest', type: 'event', status: 'scheduled', date: '2026-10-10', time: '10:30' },
    { id: 'past', type: 'event', status: 'scheduled', date: '2026-10-10', time: '09:30' },
    { id: 'done', type: 'event', status: 'completed', date: '2026-10-10', time: '10:15' },
    { id: 'task', type: 'task', status: 'scheduled', date: '2026-10-10', time: '10:05' },
    { id: 'without-time', type: 'event', status: 'scheduled', date: '2026-10-10', time: null },
    { id: 'without-date', type: 'event', status: 'scheduled', date: null, time: '10:05' },
    { id: 'invalid', type: 'event', status: 'scheduled', date: 'not-a-date', time: '10:05' },
    { id: 'impossible-date', type: 'event', status: 'scheduled', date: '2026-02-31', time: '10:05' },
  ]

  assert.equal(getNextUpcomingEvent(items, now).item.id, 'soonest')
})

test('next upcoming event excludes events starting exactly now', () => {
  const now = new Date(2026, 9, 10, 10, 0)
  assert.equal(getNextUpcomingEvent([
    { id: 'now', type: 'event', status: 'scheduled', date: '2026-10-10', time: '10:00' },
  ], now), null)
})

test('timeline expands by full consecutive weeks before and after its anchor', () => {
  const dates = timelineDates(new Date(2026, 9, 10), 1, 2)
  assert.equal(dates.length, 28)
  assert.equal(dateKey(dates[0]), '2026-10-03')
  assert.equal(dateKey(dates[7]), '2026-10-10')
  assert.equal(dateKey(dates.at(-1)), '2026-10-30')
  assert.ok(dates.every((date, index) => index === 0 || dateKey(date) === dateKey(addDays(dates[index - 1], 1))))
})

test('spotlight ranks pinned and due tasks, omits completed/archived/snoozed items, and preserves source records', () => {
  const notes = [
    { id: 'pinned-note', text: 'Keep this thought', updatedAt: 4, pinned: true },
    { id: 'archived-note', text: 'Archived', archived: true, updatedAt: 3 },
    { id: 'snoozed-note', text: 'Later', spotlightSnoozedUntil: '2026-10-11', updatedAt: 2 },
    { id: 'ordinary-note', text: 'Remember this', updatedAt: 1 },
  ]
  const items = [
    { id: 'pinned-task', type: 'task', title: 'Pinned commitment', status: 'ready', pinned: true },
    { id: 'overdue-task', type: 'task', title: 'Past due', status: 'ready', dueDate: '2026-10-09' },
    { id: 'old-schedule-task', type: 'task', title: 'Returned from a past date', status: 'ready', originalScheduledDate: '2026-10-08' },
    { id: 'upcoming-task', type: 'task', title: 'Due soon', status: 'scheduled', dueDate: '2026-10-12', date: '2026-10-12' },
    { id: 'done-task', type: 'task', title: 'Finished', status: 'completed', dueDate: '2026-10-09' },
    { id: 'snoozed-task', type: 'task', title: 'Later', status: 'ready', spotlightSnoozedUntil: '2026-10-11' },
    { id: 'fixed-event', type: 'event', title: 'Not a task', status: 'scheduled', date: '2026-10-10' },
  ]
  const beforeNotes = structuredClone(notes)
  const beforeItems = structuredClone(items)
  const candidates = getSpotlightCandidates(notes, items, '2026-10-10')

  assert.deepEqual(candidates.map((candidate) => candidate.key), [
    'note-pinned-note',
    'task-pinned-task',
    'task-overdue-task',
    'task-old-schedule-task',
    'task-upcoming-task',
    'note-ordinary-note',
  ])
  assert.ok(!candidates.some((candidate) => ['note-archived-note', 'note-snoozed-note', 'task-done-task', 'task-snoozed-task', 'event-fixed-event'].includes(candidate.key)))
  assert.deepEqual(notes, beforeNotes)
  assert.deepEqual(items, beforeItems)
})
