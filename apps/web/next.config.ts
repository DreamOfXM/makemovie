import type { NextConfig } from 'next'

// 容器部署（docker compose --profile full）里 API 是服务名不是 localhost：
// 代理目标跟环境走，本机开发保持原默认。
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4010'

const nextConfig: NextConfig = {
  transpilePackages: ['@studio/domain'],

  // @studio/domain 是 type:module 的工作区包，内部相对导入按 NodeNext 拼写
  // （'./readiness.js' 实指 readiness.ts）。tsx/vitest 认这种拼写，webpack 不认
  // ——拆包后（15915f6）web 一启动就 500。extensionAlias 是 webpack 5 对这个
  // 「TS 源码 + .js 拼写」问题的官方开关：.js 请求依次尝试 .ts/.tsx/.js。
  webpack(config) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }
    return config
  },

  // 镜像里只跑 standalone server.js，体积与依赖面以它为准。
  output: 'standalone',

  // Dev-only origin allow-list (Next >= 15.2 answers 404 to any dev request
  // whose origin is not localhost). LAN teammates open the console via
  // the machine IP, so extra origins come from the environment
  // (ALLOWED_DEV_ORIGINS, comma-separated) instead of hard-coding any
  // machine's address into a public repository; production builds ignore
  // this key entirely.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    ...(process.env.ALLOWED_DEV_ORIGINS ? process.env.ALLOWED_DEV_ORIGINS.split(',').map(host => host.trim()).filter(Boolean) : []),
  ],

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
      // MCP 端点(agent 接入):与 /api 同源反代,Claude Code/Cursor 只填一个 URL。
      {
        source: '/mcp',
        destination: `${apiOrigin}/mcp`,
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
