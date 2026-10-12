import { createContext, useContext } from 'react'

export const AuthContext = createContext(null)

export function useFirebaseAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useFirebaseAuth must be used within FirebaseAuthProvider.')
  return context
}
