import { useCallback, useEffect, useRef, useState } from 'react'
import { isFixedEvent } from './plannerDates'
import { googleEventBody, googleSnapshot, itemFromGoogleEvent, localSnapshot } from './googleCalendarEvents'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/calendar.events openid email'
const SYNC_KEY_PREFIX = 'elemental-google-calendar-sync-v1'
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'
const CALENDAR_API_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

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
  return new Promise((resolve, reject) => {
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
      error_callback: (error) => reject(new Error(error.message || 'Google authorization failed.')),
    })
    tokenClient.requestAccessToken({ prompt })
  })
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

async function calendarRequest(token, url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const details = await response.json().catch(() => null)
    const message = details?.error?.message || response.statusText
    throw new Error(`Google Calendar request failed (${response.status}): ${message}`)
  }
  if (response.status === 204) return null
  return response.json()
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

async function listGoogleEvents(token, syncToken = '') {
  const events = []
  let pageToken = ''
  do {
    const url = new URL(CALENDAR_API_URL)
    url.searchParams.set('maxResults', '2500')
    url.searchParams.set('showDeleted', 'true')
    url.searchParams.set('singleEvents', 'true')
    if (syncToken) url.searchParams.set('syncToken', syncToken)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const result = await calendarRequest(token, url)
    events.push(...(result.items || []))
    pageToken = result.nextPageToken || ''
    if (!pageToken) {
      if (!result.nextSyncToken) throw new Error('Google Calendar did not return a sync cursor.')
      return { events, nextSyncToken: result.nextSyncToken }
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
      let batch
      try {
        batch = await listGoogleEvents(token, state.nextSyncToken || '')
      } catch (listError) {
        if (!state.nextSyncToken || !(listError instanceof Error) || !listError.message.includes('(410)')) throw listError
        fullSync = true
        batch = await listGoogleEvents(token)
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

      for (const [googleId, mapping] of Object.entries(mappings)) {
        const remote = googleById.get(googleId)
        const local = localById.get(mapping.itemId) || localByGoogleId.get(googleId)
        if (!remote && !fullSync) {
          if (!local) {
            await deleteGoogleEvent(token, googleId)
            delete mappings[googleId]
          } else {
            const localData = localSnapshot(local)
            if (!mapping.snapshot || JSON.stringify(localData) !== JSON.stringify(mapping.snapshot)) {
              const updated = await calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(googleId)}?sendUpdates=none`, 'PATCH', googleEventBody(local))
              mappings[googleId] = { itemId: local.id, snapshot: localData, updatedAt: updated.updated }
            }
          }
          continue
        }
        if (!remote || cancelledIds.has(googleId)) {
          if (local) removals.add(local.id)
          delete mappings[googleId]
          continue
        }
        seenGoogleIds.add(googleId)
        if (!local) {
          await deleteGoogleEvent(token, googleId)
          delete mappings[googleId]
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
          const updated = await calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(googleId)}?sendUpdates=none`, 'PATCH', googleEventBody(local))
          mappings[googleId] = { itemId: local.id, snapshot: localData, updatedAt: updated.updated }
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
            const updated = await calendarRequest(token, `${CALENDAR_API_URL}/${encodeURIComponent(remote.id)}?sendUpdates=none`, 'PATCH', googleEventBody(local))
            baseline = localSnapshot(local)
            updatedAt = updated.updated
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
        const response = await calendarRequest(token, `${CALENDAR_API_URL}?sendUpdates=none`, 'POST', googleEventBody(local))
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
      setStatus('connected')
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
      const oauth = await loadGoogleIdentity()
      const token = await requestAccessToken(oauth, 'consent')
      const googleEmail = await getGoogleAccountEmail(token.accessToken)
      tokenRef.current = token.accessToken
      tokenExpiresAtRef.current = token.expiresAt
      syncAccountIdRef.current = `${accountId || 'local'}:${googleEmail}`
      syncStateRef.current = readSyncState(syncAccountIdRef.current)
      setConnected(true)
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
