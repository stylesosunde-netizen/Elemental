import { useEffect, useRef, useState } from 'react'
import { dataForAccount, mergeCloudRecords } from './cloudData'

const RECORD_COLLECTIONS = ['tasks', 'notes', 'history', 'logbook']
const DATA_KEYS = [...RECORD_COLLECTIONS, 'xp']
const CLOUD_OWNER_KEY = 'elemental-planner-cloud-owner-v1'

function accountCacheKey(uid) {
  return `elemental-planner-cloud-cache-v1:${uid}`
}

function firestoreRecordId(id) {
  return encodeURIComponent(id)
}

function recordIdFromSnapshot(snapshotDoc, value) {
  return value.recordId || value.payload?.id || snapshotDoc.id
}

function readAccountCache(uid) {
  try {
    const value = localStorage.getItem(accountCacheKey(uid))
    if (!value) return null
    const cached = JSON.parse(value)
    if (!cached || !RECORD_COLLECTIONS.every((key) => Array.isArray(cached[key])) ||
      !Number.isFinite(cached.xp)) {
      throw new TypeError('Saved account cache has an invalid format.')
    }
    return cached
  } catch (cacheError) {
    throw new Error(`Could not read this account's offline cache: ${cacheError.message}`, { cause: cacheError })
  }
}

function writeAccountCache(uid, data) {
  const cache = { ...data }
  cache.logbook = data.logbook.map((record) => {
    if (!record.attachment?.data || !record.attachment.storagePath) return record
    const attachment = { ...record.attachment }
    delete attachment.data
    return { ...record, attachment }
  })
  localStorage.setItem(accountCacheKey(uid), JSON.stringify(cache))
}

function persistAccountData(uid, data, setError) {
  try {
    writeAccountCache(uid, data)
  } catch (cacheError) {
    setError(`Could not save this account's offline cache: ${cacheError.message}`)
  }
}

function queueDocumentOperation(operations, path, operation) {
  const previous = operations.get(path) || Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  operations.set(path, next)
  const clear = () => {
    if (operations.get(path) === next) operations.delete(path)
  }
  next.then(clear, clear)
  return next
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function asDataUrl(bytes, type) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return `data:${type};base64,${btoa(binary)}`
}

function localAttachment(record) {
  const attachment = record?.attachment
  return attachment && typeof attachment === 'object' ? attachment : null
}

async function uploadRecord(api, storage, uid, collectionName, record) {
  const payload = structuredClone(record)
  const attachment = localAttachment(payload)
  if (collectionName === 'logbook' && attachment?.data?.startsWith('data:')) {
    const path = `users/${uid}/logbook/${encodeURIComponent(record.id)}/attachment`
    const blob = await (await fetch(attachment.data)).blob()
    await api.uploadBytes(api.ref(storage, path), blob, { contentType: attachment.type })
    payload.attachment = { name: attachment.name, type: attachment.type, size: attachment.size, storagePath: path }
  } else if (collectionName === 'logbook' && attachment && !attachment.data && !attachment.storagePath) {
    throw new Error(`Attachment on Logbook record "${record.id}" has no local file or cloud path.`)
  }
  return payload
}

async function hydrateRecord(api, storage, collectionName, payload, localRecord) {
  const record = structuredClone(payload)
  const attachment = localAttachment(record)
  if (collectionName !== 'logbook' || !attachment?.storagePath) return record

  const local = localAttachment(localRecord)
  if (local?.data && (!local.storagePath || local.storagePath === attachment.storagePath)) {
    record.attachment = { ...attachment, data: local.data }
    return record
  }

  const bytes = await api.getBytes(api.ref(storage, attachment.storagePath))
  record.attachment = { ...attachment, data: asDataUrl(bytes, attachment.type) }
  return record
}

async function writeCloudRecord(api, firestore, storage, uid, collectionName, record) {
  const payload = await uploadRecord(api, storage, uid, collectionName, record)
  await api.setDoc(api.doc(firestore, 'users', uid, collectionName, firestoreRecordId(record.id)), {
    payload,
    recordId: record.id,
    deleted: false,
    updatedAt: Date.now(),
  })
}

export function useFirebaseSync({ user, data, setters }) {
  const [status, setStatus] = useState('local')
  const [error, setError] = useState('')
  const [clientReady, setClientReady] = useState(false)
  const [readyVersion, setReadyVersion] = useState(0)
  const [activeUid, setActiveUid] = useState(null)
  const latestData = useRef(data)
  const previousData = useRef(data)
  const settersRef = useRef(setters)
  const readyUid = useRef(null)
  const clientRef = useRef(null)
  const documentOperations = useRef(new Map())

  useEffect(() => {
    latestData.current = data
    settersRef.current = setters
  }, [data, setters])

  useEffect(() => {
    const client = clientRef.current
    if (user && client && activeUid === user.uid) {
      persistAccountData(user.uid, data, setError)
    }
    if (!user || !client || readyUid.current !== user.uid) {
      if (!user) previousData.current = data
      return
    }

    const { firestore, firebaseStorage, firebaseApi: api } = client
    const previous = previousData.current
    previousData.current = data
    DATA_KEYS.forEach((key) => {
      if (key === 'xp') {
        if (!Object.is(previous.xp, data.xp)) {
          api.setDoc(api.doc(firestore, 'users', user.uid, 'settings', 'planner'), {
            xp: data.xp,
            updatedAt: Date.now(),
          }).catch((writeError) => setError(`Could not sync planner settings: ${writeError.message}`))
        }
        return
      }

      const oldById = new Map(previous[key].map((record) => [record.id, record]))
      const nextById = new Map(data[key].map((record) => [record.id, record]))
      oldById.forEach((record, id) => {
        if (nextById.has(id)) return
        const attachment = localAttachment(record)
        const tombstone = {
          recordId: id,
          deleted: true,
          updatedAt: Date.now(),
          ...(key === 'logbook' && attachment ? {
            storagePath: attachment.storagePath || `users/${user.uid}/logbook/${encodeURIComponent(id)}/attachment`,
          } : {}),
        }
        const path = `${user.uid}/${key}/${firestoreRecordId(id)}`
        queueDocumentOperation(documentOperations.current, path, () =>
          api.setDoc(api.doc(firestore, 'users', user.uid, key, firestoreRecordId(id)), tombstone))
          .then(async () => {
            if (tombstone.storagePath) {
              try {
                await api.deleteObject(api.ref(firebaseStorage, tombstone.storagePath))
              } catch (deleteError) {
                if (deleteError.code !== 'storage/object-not-found') throw deleteError
              }
            }
          })
          .catch((writeError) => setError(`Could not sync a deleted ${key} record: ${writeError.message}`))
      })
      nextById.forEach((record, id) => {
        if (oldById.has(id) && equal(oldById.get(id), record)) return
        const path = `${user.uid}/${key}/${firestoreRecordId(id)}`
        queueDocumentOperation(documentOperations.current, path, () =>
          writeCloudRecord(api, firestore, firebaseStorage, user.uid, key, record))
          .catch((writeError) => setError(`Could not sync ${key} record "${id}": ${writeError.message}`))
      })
    })
  }, [data, user, clientReady, readyVersion, activeUid])

  useEffect(() => {
    readyUid.current = null
    previousData.current = latestData.current

    if (!user) {
      return undefined
    }

    let disposed = false
    const unsubscribers = []

    async function startSync() {
      try {
        const client = await import('./firebaseClient.js')
        if (disposed) return
        clientRef.current = client
        setClientReady(true)
        setActiveUid(user.uid)
        setError('')
        setStatus('syncing')

        const ownerUid = localStorage.getItem(CLOUD_OWNER_KEY)
        let userCache = null
        try {
          userCache = readAccountCache(user.uid)
        } catch (cacheError) {
          setError(cacheError.message)
        }
        const initialAccountData = dataForAccount(ownerUid, user.uid, latestData.current, userCache)
        if (initialAccountData !== latestData.current) {
          latestData.current = initialAccountData
          previousData.current = initialAccountData
          DATA_KEYS.forEach((key) => settersRef.current[key](initialAccountData[key]))
        }
        try {
          localStorage.setItem(CLOUD_OWNER_KEY, user.uid)
        } catch (ownerError) {
          setError(`Could not remember the active cloud account: ${ownerError.message}`)
        }

        if (client.firestoreInitializationError) {
          setError(`Offline database could not start: ${client.firestoreInitializationError.message}`)
          setStatus('error')
          return
        }
        if (!client.firestore || !client.firebaseStorage) {
          setError('Firebase database or file storage is not configured.')
          setStatus('error')
          return
        }

        const { firestore, firebaseStorage, firebaseApi: api } = client
        const firstServerSnapshots = new Set()
        let settingsListenerAttached = false
        function applyRemoteCollection(key, records) {
          if (disposed) return
          const current = latestData.current
          const merged = mergeCloudRecords(current[key], records)
          const next = { ...current, [key]: merged }
          latestData.current = next
          previousData.current = { ...previousData.current, [key]: merged }
          settersRef.current[key](merged)
          persistAccountData(user.uid, next, setError)
        }

        async function receiveSnapshot(key, snapshot) {
          try {
            const localById = new Map(latestData.current[key].map((record) => [record.id, record]))
            const records = await Promise.all(snapshot.docs.map(async (snapshotDoc) => {
              const value = snapshotDoc.data()
              if (value.deleted) {
                if (value.storagePath && !snapshot.metadata.fromCache) {
                  api.deleteObject(api.ref(firebaseStorage, value.storagePath)).catch((deleteError) => {
                    if (deleteError.code !== 'storage/object-not-found') {
                      setError(`Could not remove a deleted Logbook attachment: ${deleteError.message}`)
                    }
                  })
                }
                return { id: recordIdFromSnapshot(snapshotDoc, value), deleted: true }
              }
              let payload = value.payload
              try {
                payload = await hydrateRecord(api, firebaseStorage, key, value.payload, localById.get(snapshotDoc.id))
              } catch (attachmentError) {
                setError(`Could not download a Logbook attachment: ${attachmentError.message}`)
              }
              return { id: recordIdFromSnapshot(snapshotDoc, value), deleted: false, payload }
            }))
            if (disposed) return

            applyRemoteCollection(key, records)
            if (snapshot.metadata.fromCache) {
              setStatus(navigator.onLine ? 'syncing' : 'offline')
              return
            }

            firstServerSnapshots.add(key)
            setStatus('syncing')
            const currentRecords = latestData.current[key]
            const cloudIds = new Set(records.map((record) => record.id))
            const localOnly = currentRecords.filter((record) => !cloudIds.has(record.id))
            for (const record of localOnly) {
              const path = `${user.uid}/${key}/${firestoreRecordId(record.id)}`
              await queueDocumentOperation(documentOperations.current, path, () =>
                writeCloudRecord(api, firestore, firebaseStorage, user.uid, key, record))
            }

            if (firstServerSnapshots.size === RECORD_COLLECTIONS.length && !settingsListenerAttached) {
              settingsListenerAttached = true
              const settingsRef = api.doc(firestore, 'users', user.uid, 'settings', 'planner')
              const settingsUnsubscribe = api.onSnapshot(settingsRef, { includeMetadataChanges: true }, (settingsSnapshot) => {
                if (settingsSnapshot.metadata.fromCache) {
                  setStatus(navigator.onLine ? 'syncing' : 'offline')
                  return
                }
                if (settingsSnapshot.exists()) {
                  const cloudXp = Number(settingsSnapshot.data().xp) || 0
                  if (!Object.is(latestData.current.xp, cloudXp)) {
                    const next = { ...latestData.current, xp: cloudXp }
                    latestData.current = next
                    previousData.current = { ...previousData.current, xp: cloudXp }
                    settersRef.current.xp(cloudXp)
                  }
                } else if (latestData.current.xp !== 0) {
                  api.setDoc(settingsRef, { xp: latestData.current.xp, updatedAt: Date.now() })
                    .catch((writeError) => setError(`Could not sync planner settings: ${writeError.message}`))
                }
                readyUid.current = user.uid
                try {
                  localStorage.setItem(CLOUD_OWNER_KEY, user.uid)
                } catch (ownerError) {
                  setError(`Could not remember the active cloud account: ${ownerError.message}`)
                }
                persistAccountData(user.uid, latestData.current, setError)
                setReadyVersion((version) => version + 1)
                setStatus(navigator.onLine ? 'online' : 'offline')
              }, (settingsError) => {
                setError(`Could not load planner settings: ${settingsError.message}`)
                setStatus('error')
              })
              unsubscribers.push(settingsUnsubscribe)
            }
          } catch (syncError) {
            setError(`Cloud sync failed: ${syncError.message}`)
            setStatus('error')
          }
        }

        RECORD_COLLECTIONS.forEach((key) => {
          const collectionRef = api.collection(firestore, 'users', user.uid, key)
          unsubscribers.push(api.onSnapshot(collectionRef, { includeMetadataChanges: true }, (snapshot) => {
            receiveSnapshot(key, snapshot)
          }, (syncError) => {
            setError(`Could not load ${key}: ${syncError.message}`)
            setStatus('error')
          }))
        })

        const handleOffline = () => setStatus('offline')
        const handleOnline = () => setStatus('syncing')
        window.addEventListener('offline', handleOffline)
        window.addEventListener('online', handleOnline)
        unsubscribers.push(() => {
          window.removeEventListener('offline', handleOffline)
          window.removeEventListener('online', handleOnline)
        })
      } catch (loadError) {
        if (disposed) return
        setError(`Firebase could not start: ${loadError.message}`)
        setStatus('error')
      }
    }

    startSync()
    return () => {
      disposed = true
      readyUid.current = null
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [user])

  const statusMessage = !user ? 'local' : activeUid !== user.uid ? 'syncing' : status

  return { status: statusMessage, error, clearError: () => setError('') }
}
