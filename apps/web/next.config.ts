import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@studio/domain'],

  // Dev-only origin allow-list (Next >= 15.2 answers 404 to any dev request
  // whose origin is not localhost). LAN teammates open the console via the
  // machine IP, so it must be allowed explicitly; production builds ignore
  // this key entirely.
  allowedDevOrigins: ['localhost', '127.0.0.1', '192.168.5.99'],
  
  // Proxy /api requests to backend
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:4010/:path*',
      },
    ]
  },
}

export default nextConfig
