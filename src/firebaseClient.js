import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import {
  collection,
  doc,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
} from 'firebase/firestore'
import { deleteObject, getBytes, getStorage, ref, uploadBytes } from 'firebase/storage'
import { firebaseConfigured, requiredConfig } from './firebaseConfig'

export { firebaseConfigured }
export const firebaseApp = firebaseConfigured ? initializeApp(requiredConfig) : null
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null
export const firebaseStorage = firebaseApp ? getStorage(firebaseApp) : null

let firestoreInitializationError = null
let firestore = null
if (firebaseApp) {
  try {
    firestore = initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    })
  } catch (error) {
    firestoreInitializationError = error
  }
}

export { firestore, firestoreInitializationError }

export const firebaseApi = {
  GoogleAuthProvider,
  collection,
  deleteObject,
  doc,
  getBytes,
  onAuthStateChanged,
  onSnapshot,
  ref,
  setDoc,
  signInWithPopup,
  signOut,
  uploadBytes,
}
