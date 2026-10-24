/**
 * P06 创作上下文的 returnTo 校验:模型中心等配置页带着「回哪去」的参数,
 * 但跳转目标必须是本站已知创作路径——防开放跳转(外链、协议相对、//、
 * query 注入)。不认识的目标一律拒绝,调用方回落默认导航。
 */
const KNOWN_PREFIXES = ['/projects/', '/settings']

export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value) return null
  // 只接受以单个 / 开头的站内路径;//host 与协议形式都排除。
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (!KNOWN_PREFIXES.some(prefix => value.startsWith(prefix))) return null
  return value
}
