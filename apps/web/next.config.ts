import type { NextConfig } from 'next'

// 容器部署（docker compose --profile full）里 API 是服务名不是 localhost：
// 代理目标跟环境走，本机开发保持原默认。
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4010'

const nextConfig: NextConfig = {
  transpilePackages: ['@studio/domain'],

  // 镜像里只跑 standalone server.js，体积与依赖面以它为准。
  output: 'standalone',

  // Dev-only origin allow-list (Next >= 15.2 answers 404 to any dev request
  // whose origin is not localhost). LAN teammates open the console via
  // the machine IP, so it must be allowed explicitly; production builds ignore
  // this key entirely.
  allowedDevOrigins: ['localhost', '127.0.0.1', '192.168.5.99'],

  // Proxy requests to backend API
  async rewrites() {
    return [
      // With NEXT_PUBLIC_API_URL=/api the client prefixes auth paths too, so
      // /api/auth/* must land on the backend's unprefixed /auth/* mount —
      // first match wins, keep it above the generic /api rule.
      {
        source: '/api/auth/:path*',
        destination: `${apiOrigin}/auth/:path*`,
      },
      // Rewrite /api/* to backend /api/*
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
      // Rewrite /auth/* to backend /auth/*
      {
        source: '/auth/:path*',
        destination: `${apiOrigin}/auth/:path*`,
      },
    ]
  },
}

export default nextConfig
