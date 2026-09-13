import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, generateToken, hashPassword, hashToken, redactSecret, verifyPassword } from '../src/index.js'

const KEY = 'a'.repeat(64)

describe('password hashing', () => {
  it('round-trips argon2id hashes', async () => {
    const encoded = await hashPassword('correct horse battery staple')
    expect(encoded).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true)
  })

  it('rejects wrong passwords and malformed hashes', async () => {
    const encoded = await hashPassword('secret123')
    expect(await verifyPassword('secret124', encoded)).toBe(false)
    expect(await verifyPassword('secret123', 'not-a-hash')).toBe(false)
  })
})

describe('secret encryption', () => {
  it('round-trips plaintext', () => {
    const payload = encryptSecret('sk-provider-key-123', KEY)
    expect(payload.startsWith('v1.')).toBe(true)
    expect(decryptSecret(payload, KEY)).toBe('sk-provider-key-123')
  })

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY))
  })

  it('fails with a different key', () => {
    const payload = encryptSecret('secret', KEY)
    expect(() => decryptSecret(payload, 'b'.repeat(64))).toThrow()
  })

  it('fails on tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptSecret('secret', KEY).split('.')
    const tampered = Buffer.from(ct!, 'base64url')
    tampered[0] = tampered[0]! ^ 0xff
    expect(() => decryptSecret([v, iv, tag, tampered.toString('base64url')].join('.'), KEY)).toThrow()
  })

  it('rejects malformed master keys and payloads', () => {
    expect(() => encryptSecret('x', 'short-key')).toThrow(/64 hex/)
    expect(() => decryptSecret('garbage', KEY)).toThrow(/malformed/)
  })
})

describe('tokens', () => {
  it('generates 64-hex-char tokens and stable hashes', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(hashToken(generateToken()))
  })
})

describe('redactSecret', () => {
  it('keeps only the edges of long values', () => {
    expect(redactSecret('sk-abcdefgh12345678')).toBe('sk-a****5678')
    expect(redactSecret('short')).toBe('********')
    expect(redactSecret(null)).toBe('')
  })
})
