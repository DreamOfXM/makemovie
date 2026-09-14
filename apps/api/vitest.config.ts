import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 300_000,
    // Every suite boots its own embedded PostgreSQL and shells out to
    // `prisma migrate deploy`; five of those at once kills vitest workers.
    fileParallelism: false,
  },
})
