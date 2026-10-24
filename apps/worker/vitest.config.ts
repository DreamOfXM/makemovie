import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false, // suites share the destructive Redis DB5 fixture
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
})
