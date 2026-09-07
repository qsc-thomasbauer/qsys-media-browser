/**
 * Low-level HTTPS transport for the Q-SYS Management API.
 *
 * Node's `https` is used directly rather than a client library because uploads
 * and downloads need to stream with byte-level progress and be cancellable
 * mid-flight; a buffering client would hold whole audio files in memory.
 *
 * Three Q-SYS-specific details are handled here so callers never think about
 * them:
 *
 *  - **The `Host` header is mandatory.** The Core's security check rejects
 *    requests without one with HTTP 406, so it is set explicitly on every
 *    request rather than left to Node's defaults.
 *  - **Cores use self-signed certificates.** `NODE_TLS_REJECT_UNAUTHORIZED` is
 *    deliberately *not* touched, which would disable verification process-wide.
 *    Instead a single Agent scoped to the configured host relaxes verification,
 *    and the certificate is pinned on first contact (trust-on-first-use) so a
 *    later change surfaces as a warning instead of being silently accepted.
 *  - **Tokens expire after an hour idle.** A 401 triggers one re-auth and
 *    retry, transparently, for requests whose body can be replayed.
 */
import { Agent, request as httpsRequest, type RequestOptions as HttpsOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { isIP } from 'node:net'
import { coreHostHeader, customer } from '../config'

export const API_BASE = '/api/v0'

export class QsysError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'QsysError'
  }
}

/* ---------------------------------------------------------- cert pinning */

export interface CertStore {
  get(): string | null
  set(fingerprint: string): void
}

let certStore: CertStore = (() => {
  let value: string | null = null
  return { get: () => value, set: (f) => void (value = f) }
})()

let certChanged = false
let onCertChange: ((fingerprint: string, expected: string) => void) | null = null

/** Back the pin with persistent storage (wired to userData by main/index.ts). */
export function setCertStore(store: CertStore, onChange?: typeof onCertChange): void {
  certStore = store
  onCertChange = onChange ?? null
}

/** True once the Core has presented a certificate other than the pinned one. */
export function hasCertChanged(): boolean {
  return certChanged
}

/**
 * The Core is an appliance with a self-signed certificate, so there is no CA to
 * validate against. Verification is relaxed only for this one agent, and the
 * fingerprint is recorded so a swap is at least *noticed*.
 */
const agent = new Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: 6,
  // SNI must carry a hostname, never an IP (RFC 6066) - and Cores are usually
  // addressed by IP, so this is the common case rather than the exception.
  ...(isIP(customer.core.host) === 0 ? { servername: customer.core.host } : {})
})

/**
 * Sockets whose certificate has already been checked.
 *
 * The agent has keepAlive on, so one socket serves many requests. Attaching a
 * `secureConnect` listener per request would pile up listeners that never fire
 * on a reused socket - Node warns about this at eleven.
 */
const pinnedSockets = new WeakSet<TLSSocket>()

function pinCertificate(socket: TLSSocket): void {
  const cert = socket.getPeerCertificate()
  const fingerprint = cert?.fingerprint256
  if (!fingerprint) return

  const expected = certStore.get()
  if (!expected) {
    certStore.set(fingerprint)
    return
  }
  if (expected !== fingerprint && !certChanged) {
    certChanged = true
    onCertChange?.(fingerprint, expected)
  }
}

/* -------------------------------------------------------------- requests */

export interface QsysRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path below `/api/v0`, already percent-encoded. Must start with `/`. */
  path: string
  headers?: Record<string, string>
  accept?: string
  body?: Buffer | string | Readable
  signal?: AbortSignal
  /** Send no Authorization header (used by `/logon` itself). */
  anonymous?: boolean
}

export interface QsysResponse {
  status: number
  headers: IncomingMessage['headers']
  stream: IncomingMessage
}

export interface AuthHooks {
  /** The current token, or null in open mode. */
  token(): string | null
  /** Log in if there is no usable token. Cheap and idempotent. */
  ensure(): Promise<void>
  /** Discard the current token and log in again. */
  refresh(): Promise<void>
}

let auth: AuthHooks = {
  token: () => null,
  ensure: async () => {},
  refresh: async () => {}
}
let hooksInstalled = false

/** Called by `auth.ts` on load. */
export function setAuthHooks(hooks: AuthHooks): void {
  auth = hooks
  hooksInstalled = true
}

/**
 * Load the auth module on first use.
 *
 * `auth.ts` registers its hooks as a load-time side effect, which used to mean
 * any module reaching the Core had to be sure `auth` had been imported *by
 * someone*. Nothing enforced that, and the failure mode was a bare 401 with no
 * hint as to the cause. Importing it dynamically from here inverts the
 * dependency: the transport pulls in what it needs, and no caller has to know.
 *
 * A dynamic import is required rather than a static one because `auth`
 * statically imports this module; by the time this runs, that cycle is resolved.
 */
async function ensureAuthHooks(): Promise<void> {
  if (!hooksInstalled) await import('./auth')
}

function mapNetworkError(err: NodeJS.ErrnoException): QsysError {
  const unreachable = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']
  if (err.code && unreachable.includes(err.code)) {
    return new QsysError(
      'UNREACHABLE',
      `Cannot reach the Q-SYS Core at ${coreHostHeader}. Check the network and that the Core is powered on.`,
      undefined,
      err.code
    )
  }
  if (err.name === 'AbortError') return new QsysError('CANCELLED', 'Request cancelled')
  return new QsysError('NETWORK', err.message, undefined, err.code)
}

/**
 * Perform one request and hand back the live response stream.
 *
 * The caller owns the stream and must consume or destroy it.
 */
function once(req: QsysRequest, token: string | null): Promise<QsysResponse> {
  return new Promise<QsysResponse>((resolve, reject) => {
    const headers: Record<string, string> = {
      // Explicit, because the Core answers 406 when this is missing.
      Host: coreHostHeader,
      Accept: req.accept ?? 'application/json',
      ...req.headers
    }
    if (token && !req.anonymous) headers.Authorization = `Bearer ${token}`

    // Always declare the length of a buffered body. Node does not use chunked
    // encoding for DELETE, so without this the body is written with no framing
    // at all: the server reads it as the start of the next request on the
    // keep-alive connection and answers 400. Bulk delete depends on this.
    if (req.body !== undefined && !(req.body instanceof Readable) && !headers['Content-Length']) {
      headers['Content-Length'] = String(Buffer.byteLength(req.body))
    }

    const options: HttpsOptions = {
      method: req.method,
      host: customer.core.host,
      port: customer.core.port,
      path: `${API_BASE}${req.path}`,
      headers,
      agent,
      signal: req.signal
    }

    const clientReq = httpsRequest(options, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res })
    })

    clientReq.on('socket', (socket) => {
      const tlsSocket = socket as TLSSocket
      if (pinnedSockets.has(tlsSocket)) return
      pinnedSockets.add(tlsSocket)
      if (tlsSocket.encrypted) pinCertificate(tlsSocket)
      else tlsSocket.once('secureConnect', () => pinCertificate(tlsSocket))
    })
    clientReq.on('error', (err: NodeJS.ErrnoException) => reject(mapNetworkError(err)))

    if (req.body instanceof Readable) {
      req.body.on('error', (err) => clientReq.destroy(err))
      req.body.pipe(clientReq)
    } else {
      if (req.body !== undefined) clientReq.write(req.body)
      clientReq.end()
    }
  })
}

/** Drain a response body, capped so a runaway error page cannot exhaust memory. */
async function readText(stream: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    size += buf.length
    if (size <= limit) chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function statusError(status: number, body: string): QsysError {
  const detail = body.trim().slice(0, 400) || undefined
  switch (status) {
    case 401:
      return new QsysError('UNAUTHORIZED', 'The Core rejected these credentials.', status, detail)
    case 403:
      return new QsysError(
        'FORBIDDEN',
        'This account is not allowed to perform that operation.',
        status,
        detail
      )
    case 404:
      return new QsysError('NOT_FOUND', 'That file or folder no longer exists.', status, detail)
    case 406:
      return new QsysError(
        'NOT_ACCEPTABLE',
        'The Core rejected the request headers.',
        status,
        detail
      )
    case 409:
      return new QsysError(
        'CONFLICT',
        'A file or folder with that name already exists.',
        status,
        detail
      )
    case 413:
      return new QsysError('TOO_LARGE', 'The Core rejected the file as too large.', status, detail)
    case 507:
      return new QsysError(
        'NO_SPACE',
        'The Core does not have enough free space. Note that an upload needs room for both copies while it runs.',
        status,
        detail
      )
    default:
      return new QsysError(
        'HTTP_ERROR',
        `The Core returned an unexpected response (HTTP ${status}).`,
        status,
        detail
      )
  }
}

/**
 * Request with automatic auth and one transparent retry on 401.
 *
 * A streamed body cannot be replayed after a rejection, so the token is always
 * made valid *before* sending; the retry path exists for the case where a token
 * expires between that check and the Core reading it.
 */
export async function rawRequest(req: QsysRequest): Promise<QsysResponse> {
  if (!req.anonymous) {
    await ensureAuthHooks()
    await auth.ensure()
  }

  let response = await once(req, auth.token())

  const replayable = !(req.body instanceof Readable)
  if (response.status === 401 && !req.anonymous && replayable) {
    response.stream.resume()
    await auth.refresh()
    response = await once(req, auth.token())
  }

  if (response.status >= 400) {
    throw statusError(response.status, await readText(response.stream))
  }
  return response
}

/** Request expecting a JSON body. */
export async function jsonRequest<T>(req: QsysRequest): Promise<T> {
  const headers = { ...req.headers }
  let body = req.body
  if (body !== undefined && !(body instanceof Readable) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await rawRequest({ ...req, headers, body, accept: 'application/json' })
  const text = await readText(response.stream)
  if (text.trim().length === 0) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new QsysError(
      'BAD_RESPONSE',
      'The Core returned a response this app could not read.',
      response.status,
      text.slice(0, 200)
    )
  }
}

/** Request whose response body is discarded (DELETE, HEAD-like calls). */
export async function voidRequest(req: QsysRequest): Promise<void> {
  const response = await rawRequest(req)
  response.stream.resume()
}

/** HEAD probe: true on 2xx, false on 404, throws otherwise. */
export async function headRequest(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await rawRequest({ method: 'HEAD', path, signal })
    response.stream.resume()
    return true
  } catch (err) {
    if (err instanceof QsysError && err.code === 'NOT_FOUND') return false
    throw err
  }
}
