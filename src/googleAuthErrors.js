export const AUTHORIZATION_TIMEOUT_MS = 120_000

function setupHint(origin) {
  return `check that ${origin} is listed under "Authorized JavaScript origins" for the OAuth client in Google Cloud Console, and that your Google account is a test user on the OAuth consent screen.`
}

// Turns Google Identity Services error_callback types into actionable messages.
export function describeAuthorizationError(error, origin) {
  switch (error?.type) {
    case 'popup_failed_to_open':
      return 'The Google sign-in window was blocked. Allow pop-ups for this site and tap Connect Google again.'
    case 'popup_closed':
      return `The Google sign-in window closed before access was granted. If it showed an error, ${setupHint(origin)}`
    default:
      return error?.message || 'Google authorization failed.'
  }
}

export function timeoutMessage(origin) {
  return `Google sign-in did not finish. Tap Connect Google to try again. If it keeps happening, ${setupHint(origin)}`
}

// Rejects with `message` if `promise` has not settled within `ms`.
export function withTimeout(promise, ms, message, timers = globalThis) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => timers.clearTimeout(timer))
}
