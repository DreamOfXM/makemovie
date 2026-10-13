import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMasterKey, loadConfig } from '../src/index.js'

const DB = 'postgresql://u:p@localhost:5432/db'
const HEX64 = /^[0-9a-f]{64}$/

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'studio-secrets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 调用者拿到的 env 就是 loadConfig 要读的那一份，所以断言都落在它身上。 */
function freshEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { NODE_ENV: 'production', DATABASE_URL: DB, ...extra }
}

describe('ensureMasterKey', () => {
  it('takes an explicitly configured key and writes nothing', () => {
    const env = freshEnv({ STUDIO_MASTER_KEY: 'AB'.repeat(32) })
    const result = ensureMasterKey({ env, secretsDir: dir, onNotice: () => {} })

    expect(result.source).toBe('environment')
    expect(env.STUDIO_MASTER_KEY).toBe('ab'.repeat(32))
    expect(readdirSync(dir)).toEqual([])
  })

  it('stays out of the way outside production, where loadConfig falls back', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      const env: Record<string, string | undefined> = { NODE_ENV: nodeEnv }
      const result = ensureMasterKey({ env, secretsDir: path.join(dir, 'not-created'), onNotice: () => {} })
      expect(result.source).toBe('development')
      expect(env.STUDIO_MASTER_KEY).toBeUndefined()
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it('generates one on a first production start, persists it owner-only, and leaves no staging file', () => {
    const env = freshEnv()
    const notices: string[] = []
    const result = ensureMasterKey({ env, secretsDir: dir, onNotice: message => notices.push(message) })

    expect(result.source).toBe('generated')
    expect(result.file).toBe(path.join(dir, 'master.key'))
    expect(env.STUDIO_MASTER_KEY).toMatch(HEX64)
    expect(readFileSync(result.file!, 'utf8')).toBe(env.STUDIO_MASTER_KEY)
    expect(statSync(result.file!).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['master.key'])
    expect(notices).toHaveLength(1)
  })

  it('never writes the key itself into the log', () => {
    const env = freshEnv()
    const notices: string[] = []
    ensureMasterKey({ env, secretsDir: dir, onNotice: message => notices.push(message) })

    expect(notices.join('\n')).not.toContain(env.STUDIO_MASTER_KEY!)
  })

  it('reuses the stored key on every later start instead of minting a new one', () => {
    const first = freshEnv()
    ensureMasterKey({ env: first, secretsDir: dir, onNotice: () => {} })

    const second = freshEnv()
    const result = ensureMasterKey({ env: second, secretsDir: dir, onNotice: () => {} })

    expect(result.source).toBe('volume')
    // 换一把就等于库里所有 provider 凭据作废,这条断言是那个约束的守门人。
    expect(second.STUDIO_MASTER_KEY).toBe(first.STUDIO_MASTER_KEY)
  })

  it('reads the key a parallel process already landed', () => {
    const landed = 'cd'.repeat(32)
    writeFileSync(path.join(dir, 'master.key'), landed, { mode: 0o600 })

    const env = freshEnv()
    expect(ensureMasterKey({ env, secretsDir: dir, onNotice: () => {} }).source).toBe('volume')
    expect(env.STUDIO_MASTER_KEY).toBe(landed)
  })

  it('refuses to overwrite a file that is not a key', () => {
    writeFileSync(path.join(dir, 'master.key'), 'not-a-key')

    const env = freshEnv()
    expect(() => ensureMasterKey({ env, secretsDir: dir, onNotice: () => {} })).toThrow(/undecryptable/)
    expect(readFileSync(path.join(dir, 'master.key'), 'utf8')).toBe('not-a-key')
  })

  it('honours STUDIO_SECRETS_DIR', () => {
    const nested = path.join(dir, 'nested')
    const env = freshEnv({ STUDIO_SECRETS_DIR: nested })

    const result = ensureMasterKey({ env, onNotice: () => {} })

    expect(result.file).toBe(path.join(nested, 'master.key'))
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })

  it('hands loadConfig a key it accepts in production', () => {
    const env = freshEnv()

    ensureMasterKey({ env, secretsDir: dir, onNotice: () => {} })

    expect(loadConfig(env).masterKey).toBe(env.STUDIO_MASTER_KEY)
  })
})
