import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/index.js'

const DB = 'postgresql://u:p@localhost:5432/db'

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })

  it('applies development defaults', () => {
    const config = loadConfig({ DATABASE_URL: DB })
    expect(config.nodeEnv).toBe('development')
    expect(config.masterKey).toBe('0'.repeat(64))
    expect(config.corsOrigins).toEqual(['http://localhost:3010'])
    expect(config.sessionTtlMs).toBe(7 * 24 * 3600 * 1000)
    expect(config.port).toBe(4010)
  })

  it('requires a real master key in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: DB })).toThrow(/STUDIO_MASTER_KEY is required/)
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: DB, STUDIO_MASTER_KEY: '0'.repeat(64) })).toThrow(/all-zero/)
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: DB, STUDIO_MASTER_KEY: 'abc' })).toThrow(/64 hex/)
  })

  it('accepts a valid production key and parses comma-separated CORS origins', () => {
    const config = loadConfig({ NODE_ENV: 'production', DATABASE_URL: DB, STUDIO_MASTER_KEY: 'ab'.repeat(32), CORS_ORIGIN: 'https://a.dev, https://b.dev' })
    expect(config.nodeEnv).toBe('production')
    expect(config.masterKey).toBe('ab'.repeat(32))
    expect(config.corsOrigins).toEqual(['https://a.dev', 'https://b.dev'])
  })

  it('rejects a non-positive session TTL', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, SESSION_TTL_MS: '0' })).toThrow(/SESSION_TTL_MS/)
  })
})
