import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The suites cover `lib/` logic, which imports through the same `@/` alias the app uses.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
