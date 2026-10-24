import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The suites cover `lib/` logic, which imports through the same `@/` alias the app uses.
// JSX compiles with the automatic runtime (the same one Next/SWC uses for the app), so
// component-level tests need no React import shim.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
