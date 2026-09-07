/**
 * Credential codec.
 *
 * Both halves live in one module on purpose: the build script encrypts with
 * `encryptCredentials` and the main process decrypts with
 * `decryptCredentials`, and if the KDF recipe drifted between two copies every
 * build would silently produce an app that cannot log in.
 *
 * ## What this is, and is not
 *
 * This is *obfuscation*. The key material is generated per build and split into
 * two constants injected at different points in the main bundle, so the
 * password is not a greppable string and never exists in the renderer bundle
 * or in devtools. But the key ships alongside the ciphertext, so anyone willing
 * to unpack the .asar can recover the password. Treat every shipped credential
 * as eventually public.
 *
 * The containment that actually matters is operational: give each customer
 * build its own Core user, scoped to that build's folder, so a recovered
 * credential grants nothing the binary could not already do. See
 * docs/SECURITY.md.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export interface Credentials {
  username: string
  password: string
}

export interface CredentialBlob {
  /** base64(salt | iv | authTag | ciphertext) */
  blob: string
  keyA: string
  keyB: string
}

const KEY_LEN = 32
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const SCRYPT = { N: 16384, r: 8, p: 1 } as const

/**
 * The app id is mixed into the key material so a blob lifted from one
 * customer's build cannot be decrypted by another's.
 */
function deriveKey(keyA: string, keyB: string, appId: string, salt: Buffer): Buffer {
  return scryptSync(`${keyA}:${appId}:${keyB}`, salt, KEY_LEN, SCRYPT)
}

export function encryptCredentials(
  credentials: Credentials | undefined,
  appId: string
): CredentialBlob {
  if (!credentials) return { blob: '', keyA: '', keyB: '' }

  const keyA = randomBytes(24).toString('base64url')
  const keyB = randomBytes(24).toString('base64url')
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)

  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyA, keyB, appId, salt), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()])

  return {
    blob: Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64'),
    keyA,
    keyB
  }
}

export function decryptCredentials(
  blob: string,
  keyA: string,
  keyB: string,
  appId: string
): Credentials | null {
  if (!blob) return null

  const buf = Buffer.from(blob, 'base64')
  if (buf.length <= SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Embedded credential blob is truncated')
  }
  const salt = buf.subarray(0, SALT_LEN)
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const body = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN)

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyA, keyB, appId, salt), iv)
  decipher.setAuthTag(tag)
  const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')

  const parsed: unknown = JSON.parse(json)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Credentials).username !== 'string' ||
    typeof (parsed as Credentials).password !== 'string'
  ) {
    throw new Error('Embedded credential blob has an unexpected shape')
  }
  return parsed as Credentials
}
