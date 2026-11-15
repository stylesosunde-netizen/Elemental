import assert from 'node:assert/strict'
import test from 'node:test'
import { interruptionMessage, isInterruption, requestStep, waitUntilVisible, withRetries } from '../src/googleRequest.js'

const eventsUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=250'

function interrupted() {
  const error = new Error('interrupted')
  error.interrupted = true
  return error
}

const fast = { wait: async () => {}, sleep: async () => {} }

test('browser cancellations and network drops count as interruptions', () => {
  const abort = new Error('The operation was aborted.')
  abort.name = 'AbortError'
  assert.equal(isInterruption(abort), true)
  assert.equal(isInterruption(new TypeError('Load failed')), true)
  assert.equal(isInterruption(new Error('Google Calendar request failed (403): Forbidden')), false)
})

test('only a real timeout is reported as taking too long', () => {
  assert.match(interruptionMessage({ method: 'GET', url: eventsUrl, timedOut: true }), /took too long while loading your Google events/)
  const cancelled = interruptionMessage({ method: 'GET', url: eventsUrl, timedOut: false, error: new TypeError('Load failed') })
  assert.match(cancelled, /was interrupted while loading your Google events \(Load failed\)/)
  assert.doesNotMatch(cancelled, /too long/)
})

test('request steps name what the sync was doing', () => {
  assert.equal(requestStep('POST', eventsUrl), 'adding an Elemental event to Google')
  assert.equal(requestStep('PATCH', `${eventsUrl}/abc`), 'updating a Google event')
})

test('interrupted reads are retried and then succeed', async () => {
  let calls = 0
  const result = await withRetries(async () => {
    calls += 1
    if (calls < 3) throw interrupted()
    return 'events'
  }, { method: 'GET', ...fast })
  assert.equal(result, 'events')
  assert.equal(calls, 3)
})

test('interrupted creates are not retried, to avoid duplicate Google events', async () => {
  let calls = 0
  await assert.rejects(withRetries(async () => { calls += 1; throw interrupted() }, { method: 'POST', ...fast }))
  assert.equal(calls, 1)
})

test('Google API errors are not retried', async () => {
  let calls = 0
  await assert.rejects(withRetries(async () => { calls += 1; throw new Error('(403)') }, { method: 'GET', ...fast }))
  assert.equal(calls, 1)
})

test('requests wait until a hidden page is visible again', async () => {
  const listeners = new Set()
  const doc = {
    visibilityState: 'hidden',
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  }
  let resolved = false
  const waiting = waitUntilVisible(doc).then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false)
  doc.visibilityState = 'visible'
  listeners.forEach((listener) => listener())
  await waiting
  assert.equal(resolved, true)
  assert.equal(listeners.size, 0)
})
