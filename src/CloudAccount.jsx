import { Cloud, CloudOff, LogIn, LogOut, X } from 'lucide-react'
import './CloudAccount.css'

const statusLabels = {
  local: 'Local only',
  syncing: 'Syncing',
  online: 'Synced',
  offline: 'Offline',
  error: 'Sync issue',
}

export default function CloudAccount({
  user,
  loading,
  configured,
  authError,
  syncStatus,
  syncError,
  onSignIn,
  onSignOut,
  onDismissError,
}) {
  const message = authError || syncError

  return (
    <div className="cloud-account">
      {user
        ? <>
            <span className={`cloud-status cloud-status-${syncStatus}`} aria-label={statusLabels[syncStatus] || 'Local only'} aria-live="polite" title={syncError || statusLabels[syncStatus]}>
              {syncStatus === 'offline' ? <CloudOff size={14} /> : <Cloud size={14} />}
              <span>{statusLabels[syncStatus] || 'Local only'}</span>
            </span>
            <button className="cloud-account-button" type="button" aria-label={`Sign out ${user.email || user.displayName || 'Google account'}`} title={`Signed in as ${user.email || user.displayName || 'Google account'}`} onClick={onSignOut}>
              <LogOut size={14} /><span>Sign out</span>
            </button>
          </>
        : <button
            className="cloud-account-button"
            type="button"
            aria-label={configured ? 'Sign in with Google to sync this planner' : 'Firebase configuration is required for cloud sync'}
            onClick={onSignIn}
            disabled={!configured || loading}
            title={!configured ? 'Set VITE_FIREBASE_* values to enable cloud sync' : undefined}
          >
            <LogIn size={14} /><span>{loading ? 'Connecting' : configured ? 'Sign in' : 'Local only'}</span>
          </button>}
      {message && <div className="cloud-account-error" role="alert">
        <span>{message}</span>
        <button type="button" aria-label="Dismiss cloud sync message" onClick={onDismissError}><X size={13} /></button>
      </div>}
    </div>
  )
}
