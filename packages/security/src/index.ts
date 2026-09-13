import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'

const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const
const SECRET_VERSION = 'v1'

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    return await argon2Verify(encoded, password)
  } catch {
    return false
  }
}

export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function normalizeKey(masterKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error('master key must be 64 hex characters (32 bytes); generate one with: openssl rand -hex 32')
  }
  return Buffer.from(masterKey, 'hex')
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = normalizeKey(masterKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [SECRET_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptSecret(payload: string, masterKey: string): string {
  const key = normalizeKey(masterKey)
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== SECRET_VERSION) {
    throw new Error('malformed encrypted secret')
  }
  const [, ivPart, tagPart, ctPart] = parts as [string, string, string, string]
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctPart, 'base64url')), decipher.final()])
  return plaintext.toString('utf8')
}

export function redactSecret(value: string | null | undefined): string {
  if (!value) return ''
  if (value.length <= 8) return '********'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}
