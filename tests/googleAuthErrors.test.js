import assert from 'node:assert/strict'
import test from 'node:test'
import { describeAuthorizationError, timeoutMessage, withTimeout } from '../src/googleAuthErrors.js'

const origin = 'https://elemental.example.app'

test('blocked Google sign-in popups explain how to recover', () => {
  assert.match(describeAuthorizationError({ type: 'popup_failed_to_open' }, origin), /Allow pop-ups/)
})

test('closed Google sign-in popups point to the authorized origin setup', () => {
  const message = describeAuthorizationError({ type: 'popup_closed' }, origin)
  assert.match(message, /closed before access was granted/)
  assert.ok(message.includes(origin))
  assert.match(message, /Authorized JavaScript origins/)
})

test('unknown authorization errors keep the Google message or fall back', () => {
  assert.equal(describeAuthorizationError({ type: 'unknown', message: 'Boom' }, origin), 'Boom')
  assert.equal(describeAuthorizationError(undefined, origin), 'Google authorization failed.')
})

test('authorization that never answers rejects instead of hanging on Connecting', async () => {
  const never = new Promise(() => {})
  await assert.rejects(withTimeout(never, 10, timeoutMessage(origin)), (error) => {
    assert.match(error.message, /did not finish/)
    assert.ok(error.message.includes(origin))
    return true
  })
})

test('authorization that answers in time resolves and clears its timer', async () => {
  let cleared = false
  const timers = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (id) => { cleared = true; globalThis.clearTimeout(id) },
  }
  assert.equal(await withTimeout(Promise.resolve('token'), 1000, 'late', timers), 'token')
  assert.ok(cleared)
})
