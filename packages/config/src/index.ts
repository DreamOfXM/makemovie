export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production'
  databaseUrl: string
  redisUrl: string
  /**
   * Which `Storage` implementation the API and worker build. Defaults to `disk` so
   * existing environments keep their behaviour; the S3 settings below are inert until
   * it is set to `s3`.
   */
  storageBackend: 'disk' | 's3'
  s3Endpoint: string
  s3Bucket: string
  s3Region: string
  s3AccessKey: string
  s3SecretKey: string
  masterKey: string
  corsOrigins: string[]
  sessionTtlMs: number
  port: number
  /** Root for generated media. The API streams from it and the worker writes into it, so both must agree. */
  artifactsDir: string
}

const DEV_MASTER_KEY = '0'.repeat(64)

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  let masterKey = env.STUDIO_MASTER_KEY
  if (!masterKey) {
    if (nodeEnv === 'production') throw new Error('STUDIO_MASTER_KEY is required in production (64 hex chars, e.g. `openssl rand -hex 32`)')
    masterKey = DEV_MASTER_KEY
  }
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) throw new Error('STUDIO_MASTER_KEY must be 64 hex characters (32 bytes)')
  if (nodeEnv === 'production' && masterKey === DEV_MASTER_KEY) throw new Error('STUDIO_MASTER_KEY must not be the all-zero development key in production')

  const sessionTtlMs = Number(env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000)
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) throw new Error('SESSION_TTL_MS must be a positive number')

  // Deliberately explicit rather than inferred from S3_ENDPOINT being set: that
  // variable has a non-empty default, so inference would flip every existing
  // deployment onto a backend it never asked for.
  const storageBackend = env.STORAGE_BACKEND || 'disk'
  if (storageBackend !== 'disk' && storageBackend !== 's3') throw new Error(`STORAGE_BACKEND must be one of disk|s3, got "${storageBackend}"`)

  return {
    nodeEnv,
    databaseUrl,
    redisUrl: env.REDIS_URL || 'redis://localhost:6380',
    storageBackend,
    s3Endpoint: env.S3_ENDPOINT || 'http://localhost:9000',
    s3Bucket: env.S3_BUCKET || 'studio',
    s3Region: env.S3_REGION || 'us-east-1',
    s3AccessKey: env.S3_ACCESS_KEY || 'studio',
    s3SecretKey: env.S3_SECRET_KEY || 'studio-password',
    masterKey: masterKey.toLowerCase(),
    corsOrigins: (env.CORS_ORIGIN || 'http://localhost:3010').split(',').map(origin => origin.trim()).filter(Boolean),
    sessionTtlMs,
    port: Number(env.PORT || 4010),
    artifactsDir: env.STUDIO_ARTIFACTS_DIR || 'var/artifacts',
  }
}
