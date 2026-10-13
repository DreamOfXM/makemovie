import { ensureMasterKey } from '@studio/config'
import { buildApp } from './app.js'

// 首启补齐密钥：api 用它加密 provider 凭据、worker 用它解密，两边必须是同一把，
// 所以生成动作放在启动最前面，落点是与 worker 共用的那个 secrets 卷。
ensureMasterKey()

const app = await buildApp()

try {
  await app.listen({ host: '0.0.0.0', port: app.config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
