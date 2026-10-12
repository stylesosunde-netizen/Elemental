import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './firebaseAuthContext'
import { firebaseConfigured } from './firebaseConfig'

export function FirebaseAuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(firebaseConfigured)
  const [error, setError] = useState('')
  const [services, setServices] = useState(null)

  useEffect(() => {
    if (!firebaseConfigured) return undefined
    let cancelled = false
    let unsubscribe = null
    import('./firebaseClient.js').then((firebase) => {
      if (cancelled) return
      setServices(firebase)
      if (!firebase.firebaseAuth) {
        setLoading(false)
        return
      }
      unsubscribe = firebase.firebaseApi.onAuthStateChanged(firebase.firebaseAuth, (nextUser) => {
        setUser(nextUser)
        setLoading(false)
        setError('')
      }, (authError) => {
        setLoading(false)
        setError(`Sign-in status could not be checked: ${authError.message}`)
      })
    }).catch((loadError) => {
      if (cancelled) return
      setLoading(false)
      setError(`Firebase could not start: ${loadError.message}`)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const signIn = useCallback(async () => {
    if (!services?.firebaseAuth) return
    setError('')
    try {
      await services.firebaseApi.signInWithPopup(
        services.firebaseAuth,
        new services.firebaseApi.GoogleAuthProvider(),
      )
    } catch (authError) {
      setError(`Google sign-in failed: ${authError.message}`)
    }
  }, [services])

  const signOutUser = useCallback(async () => {
    if (!services?.firebaseAuth) return
    setError('')
    try {
      await services.firebaseApi.signOut(services.firebaseAuth)
    } catch (authError) {
      setError(`Could not sign out: ${authError.message}`)
    }
  }, [services])

  const value = useMemo(() => ({
    user,
    loading,
    error,
    configured: firebaseConfigured && Boolean(services?.firebaseAuth),
    signIn,
    signOut: signOutUser,
    clearError: () => setError(''),
  }), [user, loading, error, signIn, signOutUser, services])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
