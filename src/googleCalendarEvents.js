import { dateKey } from './plannerDates.js'

export function localSnapshot(item) {
  return {
    title: item.title,
    date: item.date,
    time: item.time,
    duration: Number(item.duration) || 60,
    endDate: item.endDate || null,
    location: item.location || '',
    description: item.description || '',
  }
}

export function googleSnapshot(event) {
  if (!event.start?.dateTime || !event.end?.dateTime) return null
  const start = new Date(event.start.dateTime)
  const end = new Date(event.end.dateTime)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null
  const inclusiveEnd = new Date(end.getTime() - 1)
  const date = dateKey(start)
  const endDate = dateKey(inclusiveEnd)
  return {
    title: event.summary || '(No title)',
    date,
    time: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
    duration: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000)),
    endDate: endDate === date ? null : endDate,
    location: event.location || '',
    description: event.description || '',
  }
}

export function googleEventBody(item) {
  if (!item.date || !item.time || !Number.isFinite(new Date(`${item.date}T${item.time}:00`).getTime())) {
    throw new TypeError('Google Calendar events need a valid date and start time.')
  }
  const start = new Date(`${item.date}T${item.time}:00`)
  const end = new Date(start)
  if (item.endDate && item.endDate > item.date) {
    end.setFullYear(Number(item.endDate.slice(0, 4)), Number(item.endDate.slice(5, 7)) - 1, Number(item.endDate.slice(8, 10)))
  }
  const duration = Number(item.duration)
  end.setMinutes(end.getMinutes() + (Number.isFinite(duration) && duration > 0 ? duration : 60))
  return {
    summary: item.title,
    description: item.description || '',
    location: item.location || '',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { elementalId: item.id } },
  }
}

export function itemFromGoogleEvent(event, snapshot) {
  return {
    id: crypto.randomUUID(),
    googleCalendarId: event.id,
    title: snapshot.title,
    type: 'event',
    category: 'personal-life',
    priority: 'Normal',
    project: '',
    duration: snapshot.duration,
    date: snapshot.date,
    endDate: snapshot.endDate,
    time: snapshot.time,
    order: 0,
    status: 'scheduled',
    dueDate: '',
    location: snapshot.location,
    description: snapshot.description,
    frogDate: null,
    xpAwarded: false,
  }
}
