// Helpers for classifying and retrying Google Calendar HTTP requests.

export const IDEMPOTENT_METHODS = new Set(['GET', 'PATCH', 'DELETE'])

// A request that never got a response: cancelled by the browser (for example while the
// tab was in the background during Google sign-in) or a dropped network connection.
export function isInterruption(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError')
}

export function requestStep(method, url) {
  const path = String(url)
  if (method === 'GET' && path.includes('/events')) return 'loading your Google events'
  if (method === 'POST') return 'adding an Elemental event to Google'
  if (method === 'PATCH') return 'updating a Google event'
  if (method === 'DELETE') return 'removing a Google event'
  return 'contacting Google Calendar'
}

export function interruptionMessage({ method, url, timedOut, error }) {
  const step = requestStep(method, url)
  if (timedOut) {
    return `Google Calendar took too long while ${step}. Tap Sync Google to try again.`
  }
  const detail = error?.message ? ` (${error.message})` : ''
  return `The connection to Google Calendar was interrupted while ${step}${detail}. Keep this tab open and tap Sync Google to try again.`
}

// Resolves once the page is visible, so requests are not started while the browser is
// likely to pause or cancel them.
export function waitUntilVisible(doc = globalThis.document) {
  if (!doc || doc.visibilityState !== 'hidden') return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = () => {
      if (doc.visibilityState === 'hidden') return
      doc.removeEventListener('visibilitychange', onChange)
      resolve()
    }
    doc.addEventListener('visibilitychange', onChange)
  })
}

// Runs `attempt` and retries idempotent requests that were interrupted.
export async function withRetries(attempt, { method, retries = 2, delayMs = 1500, wait = waitUntilVisible, sleep } = {}) {
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let tryNumber = 0; ; tryNumber += 1) {
    try {
      return await attempt()
    } catch (error) {
      const retryable = IDEMPOTENT_METHODS.has(method) && error?.interrupted && tryNumber < retries
      if (!retryable) throw error
      await wait()
      await pause(delayMs)
    }
  }
}

// Message shown when the sync finished but some events could not be written to Google.
export function syncFailureSummary(failures) {
  const [first] = failures
  const others = failures.length - 1
  const more = others ? ` (and ${others} more event${others === 1 ? '' : 's'})` : ''
  return `Google events were imported, but "${first.title}"${more} could not be sent to Google: ${first.message}`
}
