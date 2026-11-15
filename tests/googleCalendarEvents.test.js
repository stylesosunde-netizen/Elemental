import assert from 'node:assert/strict'
import test from 'node:test'
import { dateKey } from '../src/plannerDates.js'
import { googleEventBody, googleSnapshot, localSnapshot } from '../src/googleCalendarEvents.js'

test('Google timed events map to Elemental event fields and retain cross-day spans', () => {
  const start = new Date('2026-11-13T23:30:00Z')
  const end = new Date('2026-11-14T01:00:00Z')
  const snapshot = googleSnapshot({
    summary: 'Launch review',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    location: 'Studio',
    description: 'Final review',
  })

  assert.deepEqual(snapshot, {
    title: 'Launch review',
    date: dateKey(start),
    time: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
    duration: 90,
    endDate: dateKey(new Date(end.getTime() - 1)) === dateKey(start) ? null : dateKey(new Date(end.getTime() - 1)),
    location: 'Studio',
    description: 'Final review',
  })
})

test('all-day and invalid-duration Google events are ignored', () => {
  assert.equal(googleSnapshot({ start: { date: '2026-11-13' }, end: { date: '2026-11-14' } }), null)
  assert.equal(googleSnapshot({
    start: { dateTime: '2026-11-13T10:00:00Z' },
    end: { dateTime: '2026-11-13T09:00:00Z' },
  }), null)
})

test('Elemental events create Google events with location, description, and app identity', () => {
  const item = {
    id: 'planner-event-1',
    title: 'Design review',
    date: '2026-11-13',
    time: '10:30',
    duration: 45,
    location: 'Studio',
    description: 'Bring the latest mockups',
  }
  const body = googleEventBody(item)

  assert.equal(body.summary, item.title)
  assert.equal(body.location, item.location)
  assert.equal(body.description, item.description)
  assert.equal(body.extendedProperties.private.elementalId, item.id)
  assert.equal(new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime(), 45 * 60_000)
})

test('local snapshots normalize optional event data for sync comparisons', () => {
  assert.deepEqual(localSnapshot({
    title: 'Review',
    date: '2026-11-13',
    time: '10:30',
    duration: 0,
  }), {
    title: 'Review',
    date: '2026-11-13',
    time: '10:30',
    duration: 60,
    endDate: null,
    location: '',
    description: '',
  })
})

test('full syncs cover the last 90 days through the next year', async () => {
  const { fullSyncWindow } = await import('../src/googleCalendarEvents.js')
  const now = new Date(2026, 10, 15, 15, 0)
  const window = fullSyncWindow(now)
  assert.equal(window.startKey, dateKey(new Date(2026, 7, 17)))
  assert.equal(window.endKey, dateKey(new Date(2027, 10, 15)))
  assert.ok(new Date(window.timeMin) < now && new Date(window.timeMax) > now)
})

test('events outside the full-sync window are recognised so they are not removed', async () => {
  const { fullSyncWindow, isInSyncWindow } = await import('../src/googleCalendarEvents.js')
  const window = fullSyncWindow(new Date(2026, 10, 15))
  assert.equal(isInSyncWindow({ date: '2026-11-20' }, window), true)
  assert.equal(isInSyncWindow({ date: '2025-01-10' }, window), false)
  assert.equal(isInSyncWindow({ date: '2028-01-10' }, window), false)
  assert.equal(isInSyncWindow({ date: '2026-08-10', endDate: '2026-08-20' }, window), true)
})
