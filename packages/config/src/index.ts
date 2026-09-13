export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production'
  databaseUrl: string
  redisUrl: string
  s3Endpoint: string
  s3Bucket: string
  s3Region: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  return {
    nodeEnv,
    databaseUrl,
    redisUrl: env.REDIS_URL || 'redis://localhost:6380',
    s3Endpoint: env.S3_ENDPOINT || 'http://localhost:9000',
    s3Bucket: env.S3_BUCKET || 'studio',
    s3Region: env.S3_REGION || 'us-east-1',
  }
}
