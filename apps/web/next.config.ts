import type { NextConfig } from 'next'

// @studio/domain ships raw TypeScript sources (no dist build), so Next has to
// compile it instead of treating it as a prebuilt package.
const nextConfig: NextConfig = {
  transpilePackages: ['@studio/domain'],
}

export default nextConfig
