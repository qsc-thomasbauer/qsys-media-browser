/**
 * Bearer token lifecycle.
 *
 * The Core's token expires after an hour of inactivity, and that timer resets
 * on every request. Rather than tracking an absolute expiry we track last
 * activity and re-authenticate once it goes stale, which matches how the Core
 * actually behaves and costs one extra request an hour at most.
 *
 * In `open` access mode (no Access Control configured on the Core) there is no
 * token to maintain and requests carry no Authorization header at all. Connect
 * still probes the Core, so the "Connected" indicator reports something that
 * was actually observed rather than something that was merely configured.
 */
import { EventEmitter } from 'node:events'
import { coreLabel, credentials, isProtected } from '../config'
import { QsysError, hasCertChanged, jsonRequest, setAuthHooks, voidRequest } from './client'
import type { ConnectionStatus } from '@shared/types'

/**
 * Re-authenticate once activity is older than this. Comfortably inside the
 * Core's one-hour idle window, so a token is never used after it lapses.
 */
const IDLE_REFRESH_MS = 45 * 60 * 1000

interface LogonResponse {
  token: string
}

let token: string | null = null
let lastActivity = 0
/** Single-flight guard so a burst of parallel requests triggers one logon. */
let inFlight: Promise<void> | null = null

let status: ConnectionStatus = { state: 'idle' }
const events = new EventEmitter()

export function connectionStatus(): ConnectionStatus {
  return { ...status, certChanged: hasCertChanged() }
}

export function onConnectionChange(listener: (status: ConnectionStatus) => void): () => void {
  events.on('change', listener)
  return () => void events.off('change', listener)
}

function setStatus(next: ConnectionStatus): void {
  status = next
  events.emit('change', connectionStatus())
}

function markActive(): void {
  lastActivity = Date.now()
}

/** True when there is a token that has not gone stale from inactivity. */
function isFresh(): boolean {
  return token !== null && Date.now() - lastActivity < IDLE_REFRESH_MS
}

async function logon(): Promise<void> {
  setStatus({ state: 'connecting', message: coreLabel() })

  const creds = credentials()
  if (!creds) {
    // Open mode: there is no token to fetch, but "Connected" should be a claim
    // about the Core actually answering, not merely about how this build was
    // configured - so probe it. `anonymous` keeps the request out of `ensure`
    // (no recursion) and sends no Authorization header, which is what the docs
    // require of an open Core.
    try {
      await voidRequest({ method: 'GET', path: '/cores/self/media', anonymous: true })
      setStatus({ state: 'connected', message: coreLabel() })
    } catch (err) {
      setStatus({
        state: 'error',
        message: err instanceof QsysError ? err.message : 'Could not reach the Core.'
      })
      throw err
    }
    return
  }

  try {
    const response = await jsonRequest<LogonResponse>({
      method: 'POST',
      path: '/logon',
      anonymous: true,
      body: JSON.stringify({ username: creds.username, password: creds.password })
    })
    if (!response?.token) {
      throw new QsysError('BAD_RESPONSE', 'The Core accepted the login but returned no token.')
    }
    token = response.token
    markActive()
    setStatus({ state: 'connected', message: coreLabel() })
  } catch (err) {
    token = null
    const message =
      err instanceof QsysError
        ? err.code === 'UNAUTHORIZED'
          ? 'The credentials in this build were rejected by the Core.'
          : err.message
        : 'Could not sign in to the Core.'
    setStatus({ state: 'error', message })
    throw err
  }
}

/** Log in only if needed. Safe to call before every request. */
export async function ensure(): Promise<void> {
  // Open mode has no token to maintain, and the connection status is owned by
  // `connect()` - claiming "connected" from here would assert it before
  // anything had actually reached the Core.
  if (!isProtected) return
  if (isFresh()) {
    markActive()
    return
  }
  inFlight ??= logon().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Discard the current token and establish the connection again.
 *
 * In open mode there is no token, so this reduces to re-probing the Core -
 * which is what the UI's retry button needs it to do.
 */
export async function refresh(): Promise<void> {
  token = null
  lastActivity = 0
  if (!isProtected) {
    inFlight ??= logon().finally(() => {
      inFlight = null
    })
    return inFlight
  }
  return ensure()
}

/** Explicit connect, used by the UI's retry button and at startup. */
export async function connect(): Promise<ConnectionStatus> {
  try {
    await refresh()
  } catch {
    // `logon` has already recorded the failure in `status`.
  }
  return connectionStatus()
}

/**
 * Revoke the token on the way out. Best-effort: a Core that has already
 * forgotten the session, or one that is unreachable, is not worth reporting.
 */
export async function logoff(): Promise<void> {
  if (!isProtected || !token) return
  try {
    await voidRequest({ method: 'DELETE', path: '/logon' })
  } catch {
    /* ignore */
  } finally {
    token = null
    lastActivity = 0
    setStatus({ state: 'idle' })
  }
}

setAuthHooks({
  token: () => token,
  ensure,
  refresh
})
