import type { PrismaClient } from '@studio/db'
import type { Role } from '@studio/domain'
import { generateToken, hashToken } from '@studio/security'
import type { AuthContext } from '../types.js'

/**
 * Agent 接入令牌:给 AI agent(Claude Code/Cursor 经 MCP)用的 Bearer 凭据。与
 * Session 同一套 hash 落库,但独立成表——可命名、可吊销、带角色,不受用户改密/
 * 退会牵连。前缀 `mmt_` 让 authenticate 不用碰两张表就能分流。
 */
export const AGENT_TOKEN_PREFIX = 'mmt_'

export function isAgentToken(token: string): boolean {
  return token.startsWith(AGENT_TOKEN_PREFIX)
}

export async function createAgentToken(
  db: PrismaClient,
  input: { organizationId: string; name: string; role: Role },
): Promise<{ row: { id: string; name: string; role: string; createdAt: Date }; secret: string }> {
  const secret = `${AGENT_TOKEN_PREFIX}${generateToken()}`
  const row = await db.agentToken.create({
    data: { name: input.name, organizationId: input.organizationId, role: input.role, tokenHash: hashToken(secret) },
    select: { id: true, name: true, role: true, createdAt: true },
  })
  return { row, secret }
}

export async function resolveAgentToken(db: PrismaClient, token: string): Promise<AuthContext | null> {
  const row = await db.agentToken.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row || row.revokedAt) return null
  // lastUsedAt 是运营信号(哪个 agent 还活着),丢失不致命——失败静默。
  await db.agentToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
  return {
    sessionId: row.id,
    userId: null,
    organizationId: row.organizationId,
    role: row.role as Role,
    userEmail: null,
  }
}
