import { useCallback, useEffect, useRef, useState } from 'react'
import { isFixedEvent } from './plannerDates'
import { syncFailureSummary } from './googleRequest'
import { fullSyncWindow, googleEventBody, googleSnapshot, isInSyncWindow, itemFromGoogleEvent, localSnapshot } from './googleCalendarEvents'
import { interruptionMessage, isInterruption, waitUntilVisible, withRetries } from './googleRequest'
import { AUTHORIZATION_TIMEOUT_MS, describeAuthorizationError, timeoutMessage, withTimeout } from './googleAuthErrors'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/calendar.events openid email'
const SYNC_KEY_PREFIX = 'elemental-google-calendar-sync-v1'
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'
const CALENDAR_API_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const CALENDAR_REQUEST_TIMEOUT_MS = 30_000

let identityScriptPromise

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts.oauth2)
  if (identityScriptPromise) return identityScriptPromise

  identityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve(window.google.accounts.oauth2)
      else {
        identityScriptPromise = null
        reject(new Error('Google sign-in did not load correctly.'))
      }
    }
    script.onerror = () => {
      identityScriptPromise = null
      reject(new Error('Google sign-in could not be loaded.'))
    }
    document.head.append(script)
  })
  return identityScriptPromise
}

function requestAccessToken(oauth, prompt) {
  const origin = window.location.origin
  // The executor runs synchronously, so when `oauth` is already loaded the popup
  // opens inside the user's tap and is not blocked by the browser.
  const authorization = new Promise((resolve, reject) => {
    const tokenClient = oauth.initTokenClient({
      client_id: CLIENT_ID,
      scope: TOKEN_SCOPE,
      callback: (response) => {
        if (response.error) reject(new Error(response.error_description || response.error))
        else if (!response.access_token) reject(new Error('Google did not return an access token.'))
        else resolve({
          accessToken: response.access_token,
          expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
        })
      },
      error_callback: (error) => reject(new Error(describeAuthorizationError(error, origin))),
    })
    tokenClient.requestAccessToken({ prompt })
  })
  return withTimeout(authorization, AUTHORIZATION_TIMEOUT_MS, timeoutMessage(origin), window)
}

function storageKey(accountId) {
  return `${SYNC_KEY_PREFIX}:${accountId || 'local'}`
}

function readSyncState(accountId) {
  const saved = localStorage.getItem(storageKey(accountId))
  if (!saved) return { mappings: {} }
  const state = JSON.parse(saved)
  if (!state || !state.mappings || typeof state.mappings !== 'object' || Array.isArray(state.mappings)) {
    throw new TypeError('Saved Google Calendar sync data has an invalid format.')
  }
  return state
}

function writeSyncState(accountId, state) {
  localStorage.setItem(storageKey(accountId), JSON.stringify(state))
}

async function calendarRequestOnce(token, url, method, body) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, CALENDAR_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      const details = await response.json().catch(() => null)
      const message = details?.error?.message || response.statusText
      throw new Error(`Google Calendar request failed (${response.status}): ${message}`)
    }
    if (response.status === 204) return null
    return await response.json()
  } catch (requestError) {
    // Only report a timeout when our own timer fired; the browser also cancels requests
    // (AbortError / TypeError), e.g. while the tab is hidden during Google sign-in.
    if (timedOut || isInterruption(requestError)) {
      const interrupted = new Error(interruptionMessage({ method, url, timedOut, error: requestError }), {
        cause: requestError,
      })
      interrupted.interrupted = true
      throw interrupted
    }
    throw requestError
  } finally {
    window.clearTimeout(timeout)
  }
}

function calendarRequest(token, url, method = 'GET', body) {
  return withRetries(() => calendarRequestOnce(token, url, method, body), { method })
}

async function getGoogleAccountEmail(token) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not identify the Google account (${response.status}).`)
  const profile = await response.json()
  if (typeof profile.email !== 'string' || !profile.email) {
    throw new Error('Google did not provide an account email for calendar sync.')
  }
  return profile.email.toLowerCase()
}

async function listGoogleEvents(token, syncToken = '', range = null) {
  const events = []
  let pageToken = ''
  do {
    const url = new URL(CALENDAR_API_URL)
    url.searchParams.set('maxResults', '250')
    url.searchParams.set('showDeleted', 'true')
    url.searchParams.set('singleEvents', 'true')
    if (syncToken) url.searchParams.set('syncToken', syncToken)
    else if (range) {
      // Full syncs are limited to a date window: listing a whole calendar history with
      // every recurring occurrence expanded is slow enough to time out.
      url.searchParams.set('timeMin', range.timeMin)
      url.searchParams.set('timeMax', range.timeMax)
    }
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const result = await calendarRequest(token, url)
    events.push(...(result.items || []))
    pageToken = result.nextPageToken || ''
    if (!pageToken) {
      // A date-limited full sync may not return a cursor; the next sync is then a
      // windowed full sync again, which is still fast.
      if (!result.nextSyncToken && syncToken) throw new Error('Google Calendar did not return a sync cursor.')
      return { events, nextSyncToken: result.nextSyncToken || '' }
    }
  } while (pageToken)
  throw new Error('Google Calendar did not return a sync cursor.')
}

async function deleteGoogleEvent(token, googleId) {
  try {
    await calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(googleId)}?sendUpdates=none`, 'DELETE')
  } catch (deleteError) {
    if (!(deleteError instanceof Error) || !deleteError.message.includes('(404)')) throw deleteError
  }
}

export function useGoogleCalendarSync({ items, setItems, accountId }) {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const tokenRef = useRef('')
  const tokenExpiresAtRef = useRef(0)
  const itemsRef = useRef(items)
  const syncingRef = useRef(false)
  const syncStateRef = useRef(null)
  const syncAccountIdRef = useRef('')
  const accountIdRef = useRef(accountId)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    // Preload Google Identity Services so Connect Google can open its popup immediately.
    if (CLIENT_ID) loadGoogleIdentity().catch(() => {})
  }, [])

  useEffect(() => {
    if (accountIdRef.current === accountId) return
    accountIdRef.current = accountId
    tokenRef.current = ''
    tokenExpiresAtRef.current = 0
    syncStateRef.current = null
    syncAccountIdRef.current = ''
    setConnected(false)
    setStatus('idle')
    setError('')
  }, [accountId])

  const sync = useCallback(async (token = tokenRef.current) => {
    if (!token || syncingRef.current) return
    if (!navigator.onLine) {
      setStatus('offline')
      return
    }
    syncingRef.current = true
    setStatus('syncing')
    setError('')
    try {
      const state = syncStateRef.current || readSyncState(syncAccountIdRef.current || accountId)
      const mappings = { ...state.mappings }
      let fullSync = !state.nextSyncToken
      const syncWindow = fullSyncWindow(new Date())
      let batch
      try {
        batch = await listGoogleEvents(token, state.nextSyncToken || '', syncWindow)
      } catch (listError) {
        if (!state.nextSyncToken || !(listError instanceof Error) || !listError.message.includes('(410)')) throw listError
        fullSync = true
        batch = await listGoogleEvents(token, '', syncWindow)
      }
      const googleEvents = batch.events
      const googleById = new Map(googleEvents.map((event) => [event.id, event]))
      const cancelledIds = new Set(googleEvents.filter((event) => event.status === 'cancelled').map((event) => event.id))
      const localEvents = itemsRef.current.filter((item) => isFixedEvent(item) && item.status !== 'deleted')
      const localById = new Map(localEvents.map((item) => [item.id, item]))
      const localByGoogleId = new Map(localEvents.filter((item) => item.googleCalendarId).map((item) => [item.googleCalendarId, item]))
      const updates = new Map()
      const remotePulls = new Map()
      const removals = new Set()
      const seenGoogleIds = new Set()
      const failures = []
      // A single event that cannot be written to Google must not stop the rest of the
      // sync (and especially not the import of Google events into Elemental).
      const tryWrite = async (item, write) => {
        try {
          return { ok: true, value: await write() }
        } catch (writeError) {
          if (writeError instanceof Error && writeError.message.includes('(401)')) throw writeError
          failures.push({ title: item?.title || item?.summary || 'Untitled event', message: writeError instanceof Error ? writeError.message : String(writeError) })
          return { ok: false }
        }
      }

      for (const [googleId, mapping] of Object.entries(mappings)) {
        const remote = googleById.get(googleId)
        const local = localById.get(mapping.itemId) || localByGoogleId.get(googleId)
        if (!remote && !fullSync) {
          if (!local) {
            const removed = await tryWrite(mapping.snapshot, () => deleteGoogleEvent(token, googleId))
            if (removed.ok) delete mappings[googleId]
          } else {
            const localData = localSnapshot(local)
            if (!mapping.snapshot || JSON.stringify(localData) !== JSON.stringify(mapping.snapshot)) {
              const updated = await tryWrite(local, () => calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(googleId)}?sendUpdates=none`, 'PATCH', googleEventBody(local)))
              if (updated.ok) mappings[googleId] = { itemId: local.id, snapshot: localData, updatedAt: updated.value.updated }
            }
          }
          continue
        }
        if (!remote && fullSync && local && !isInSyncWindow(local, syncWindow)) {
          // Outside the full-sync window, a missing event is unknown rather than deleted.
          continue
        }
        if (!remote || cancelledIds.has(googleId)) {
          if (local) removals.add(local.id)
          delete mappings[googleId]
          continue
        }
        seenGoogleIds.add(googleId)
        if (!local) {
          const removed = await tryWrite(remote, () => deleteGoogleEvent(token, googleId))
          if (removed.ok) delete mappings[googleId]
          continue
        }
        const remoteData = googleSnapshot(remote)
        if (!remoteData) {
          removals.add(local.id)
          delete mappings[googleId]
          continue
        }
        const localData = localSnapshot(local)
        const baseline = mapping.snapshot
        if (!baseline || JSON.stringify(localData) !== JSON.stringify(baseline)) {
          const updated = await tryWrite(local, () => calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(googleId)}?sendUpdates=none`, 'PATCH', googleEventBody(local)))
          if (updated.ok) mappings[googleId] = { itemId: local.id, snapshot: localData, updatedAt: updated.value.updated }
        } else if (JSON.stringify(remoteData) !== JSON.stringify(baseline)) {
          remotePulls.set(local.id, { expected: localData, snapshot: remoteData, googleId })
          mappings[googleId] = { itemId: local.id, snapshot: remoteData, updatedAt: remote.updated }
        }
      }

      for (const remote of googleEvents) {
        if (remote.status === 'cancelled' || seenGoogleIds.has(remote.id) || mappings[remote.id]) continue
        const taggedItemId = remote.extendedProperties?.private?.elementalId
        const local = localByGoogleId.get(remote.id) || localById.get(taggedItemId)
        const snapshot = googleSnapshot(remote)
        if (!snapshot) continue
        let baseline = snapshot
        let updatedAt = remote.updated
        if (local) {
          if (JSON.stringify(localSnapshot(local)) !== JSON.stringify(snapshot)) {
            // If this update fails, the Google version stays the baseline so it is retried.
            const updated = await tryWrite(local, () => calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(remote.id)}?sendUpdates=none`, 'PATCH', googleEventBody(local)))
            if (updated.ok) {
              baseline = localSnapshot(local)
              updatedAt = updated.value.updated
            }
          }
          if (local.googleCalendarId !== remote.id) {
            updates.set(local.id, { ...local, googleCalendarId: remote.id })
          }
          mappings[remote.id] = { itemId: local.id, snapshot: baseline, updatedAt }
        } else {
          const item = itemFromGoogleEvent(remote, snapshot)
          updates.set(item.id, item)
          mappings[remote.id] = { itemId: item.id, snapshot, updatedAt }
        }
      }

      const mappedItemIds = new Set(Object.values(mappings).map((mapping) => mapping.itemId))
      for (const local of localEvents) {
        if (removals.has(local.id)) continue
        if (mappedItemIds.has(local.id) || (local.googleCalendarId && mappings[local.googleCalendarId])) continue
        const created = await tryWrite(local, () => calendarRequest(token, `${CALENDAR_API_URL}?sendUpdates=none`, 'POST', googleEventBody(local)))
        if (!created.ok) continue
        const response = created.value
        updates.set(local.id, { ...local, googleCalendarId: response.id })
        mappings[response.id] = {
          itemId: local.id,
          snapshot: localSnapshot(local),
          updatedAt: response.updated,
        }
      }

      const nextState = { mappings, nextSyncToken: batch.nextSyncToken }
      writeSyncState(syncAccountIdRef.current || accountId, nextState)
      syncStateRef.current = nextState
      if (updates.size || remotePulls.size || removals.size) {
        setItems((current) => [
          ...current.filter((item) => !removals.has(item.id)).map((item) => {
            const update = updates.get(item.id)
            if (update) return update.googleCalendarId
              ? { ...item, googleCalendarId: update.googleCalendarId }
              : update
            const remotePull = remotePulls.get(item.id)
            if (remotePull && JSON.stringify(localSnapshot(item)) === JSON.stringify(remotePull.expected)) {
              return { ...item, ...remotePull.snapshot, googleCalendarId: remotePull.googleId, type: 'event' }
            }
            return item
          }),
          ...[...updates.entries()]
            .filter(([id]) => !current.some((item) => item.id === id))
            .map(([, item]) => item),
        ])
      }
      if (failures.length) {
        setError(syncFailureSummary(failures))
        setStatus('error')
      } else {
        setStatus('connected')
      }
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Google Calendar sync failed.')
      setStatus('error')
      if (syncError instanceof Error && syncError.message.includes('(401)')) {
        tokenRef.current = ''
        tokenExpiresAtRef.current = 0
        setConnected(false)
      }
    } finally {
      syncingRef.current = false
    }
  }, [accountId, setItems])

  const connect = useCallback(async () => {
    if (!CLIENT_ID) {
      setError('Set VITE_GOOGLE_CALENDAR_CLIENT_ID to enable Google Calendar sync.')
      setStatus('error')
      return
    }
    setStatus('connecting')
    setError('')
    try {
      // Request the token before any await when the script is preloaded, so the
      // popup is still tied to the tap (Safari blocks popups opened after an await).
      const preloaded = window.google?.accounts?.oauth2
      const tokenRequest = preloaded
        ? requestAccessToken(preloaded, 'consent')
        : loadGoogleIdentity().then((oauth) => requestAccessToken(oauth, 'consent'))
      const token = await tokenRequest
      await waitUntilVisible()
      const googleEmail = await getGoogleAccountEmail(token.accessToken)
      tokenRef.current = token.accessToken
      tokenExpiresAtRef.current = token.expiresAt
      syncAccountIdRef.current = `${accountId || 'local'}:${googleEmail}`
      syncStateRef.current = readSyncState(syncAccountIdRef.current)
      setConnected(true)
      // After the Google sign-in tab closes, wait until Elemental is on screen again so
      // the browser does not pause or cancel the first sync's requests.
      await waitUntilVisible()
      await sync(token.accessToken)
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Could not connect Google Calendar.')
      setStatus('error')
    }
  }, [accountId, sync])

  const disconnect = useCallback(() => {
    tokenRef.current = ''
    setConnected(false)
    setStatus('idle')
    setError('')
  }, [])

  useEffect(() => {
    if (!connected) return undefined
    const timer = window.setInterval(async () => {
      if (tokenExpiresAtRef.current && tokenExpiresAtRef.current - Date.now() < 180_000) {
        try {
          const oauth = await loadGoogleIdentity()
          const refreshed = await requestAccessToken(oauth, '')
          tokenRef.current = refreshed.accessToken
          tokenExpiresAtRef.current = refreshed.expiresAt
        } catch (refreshError) {
          tokenRef.current = ''
          tokenExpiresAtRef.current = 0
          setConnected(false)
          setStatus('error')
          setError(refreshError instanceof Error
            ? `Google Calendar authorization expired: ${refreshError.message}`
            : 'Google Calendar authorization expired. Reconnect to continue syncing.')
          return
        }
      }
      await sync()
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [connected, sync])

  useEffect(() => {
    if (!connected) return undefined
    const timer = window.setTimeout(() => sync(), 900)
    return () => window.clearTimeout(timer)
  }, [connected, items, sync])

  return {
    configured: Boolean(CLIENT_ID),
    connected,
    status,
    error,
    connect,
    disconnect,
    sync: () => sync(),
  }
}
