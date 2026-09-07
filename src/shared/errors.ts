/**
 * Error marshalling across IPC.
 *
 * `ipcMain.handle` serialises a rejection by stringifying the Error, which
 * loses custom properties and wraps the message in "Error invoking remote
 * method '...':". Both sides therefore agree on a small envelope: main encodes
 * `{code, message, status}` as the message, and preload unpacks it into a real
 * Error with `.code` intact so the UI can branch on it (READ_ONLY needs a
 * different treatment from UNREACHABLE) rather than matching on prose.
 */
import type { IpcErrorShape } from './types'

const MARKER = '@@qsys-error@@'

export function encodeIpcError(error: unknown): string {
  const shape: IpcErrorShape =
    error instanceof Error
      ? {
          code: (error as { code?: string }).code ?? 'INTERNAL',
          message: error.message,
          status: (error as { status?: number }).status
        }
      : { code: 'INTERNAL', message: String(error) }
  return MARKER + JSON.stringify(shape)
}

export class QsysClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'QsysClientError'
  }
}

/** Rebuild a typed error from whatever came back across the bridge. */
export function decodeIpcError(error: unknown): QsysClientError {
  const raw = error instanceof Error ? error.message : String(error)
  const at = raw.indexOf(MARKER)
  if (at === -1) {
    return new QsysClientError('INTERNAL', raw || 'Something went wrong.')
  }
  try {
    const shape = JSON.parse(raw.slice(at + MARKER.length)) as IpcErrorShape
    return new QsysClientError(shape.code, shape.message, shape.status)
  } catch {
    return new QsysClientError('INTERNAL', 'Something went wrong.')
  }
}

/** True for errors the UI should present as "the Core is not reachable". */
export function isConnectivityError(code: string): boolean {
  return code === 'UNREACHABLE' || code === 'NETWORK' || code === 'UNAUTHORIZED'
}
