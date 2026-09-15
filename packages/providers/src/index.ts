export * from './types.js'
export * from './catalog.js'
export * from './mock.js'
export * from './dashscope.js'
export * from './seedance.js'

import type { ProviderAdapter } from './types.js'
import type { AdapterOptions } from './types.js'
import { MockProviderAdapter } from './mock.js'
import { DashScopeAdapter } from './dashscope.js'
import { SeedanceAdapter } from './seedance.js'
import { getCatalog } from './catalog.js'

export function createAdapter(provider: string, options: AdapterOptions): ProviderAdapter {
  if (provider === 'mock') return new MockProviderAdapter(options)
  if (provider === 'dashscope') return new DashScopeAdapter(options)
  if (provider === 'seedance') return new SeedanceAdapter(options)
  throw new Error(`unknown provider "${provider}"`)
}

export function isKnownProvider(provider: string): boolean {
  return getCatalog(provider) !== undefined
}
