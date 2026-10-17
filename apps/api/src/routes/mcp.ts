import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@studio/db'
import { planAutoBind, wiredRequiredSlots } from '@studio/domain'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { AuthContext } from '../types.js'
import { createBinding, loadOrgModelPool } from '../lib/bindings.js'
import { authenticate } from '../plugins/auth.js'
import { recommendedForPredicate } from './bindings.js'

/**
 * Agent 接入面(MCP):Claude Code / Cursor 一类客户端把 makemovie 当工具箱驱动——
 * 槽位就绪度、连了哪些厂商、一句话补齐必填槽位。鉴权走同一条 authenticate
 * (agent 令牌 mmt_ 或用户会话都可),工具内部复用与 REST 完全相同的服务函数和
 * 唯一写路径(createBinding),agent 与人做的事可审计地等价。
 *
 * 无状态传输:每个 POST 自带完整 JSON-RPC 请求,不留会话——部署在 compose 反代
 * 后面最省事,agent 客户端只需要 URL + Bearer 头。
 */
function buildMcpServer(db: PrismaClient, auth: AuthContext): McpServer {
  const server = new McpServer({ name: 'makemovie', version: '1.0.0' })

  server.registerTool(
    'slot_readiness',
    {
      description: '模型槽位就绪度:哪些必填槽位还没绑定模型(空缺会阻塞生成链),以及每档候选覆盖情况',
    },
    async () => {
      const { connections, bindings } = await loadOrgModelPool(db, auth.organizationId)
      const slots = wiredRequiredSlots()
      const plan = planAutoBind(connections, bindings, slots, recommendedForPredicate())
      const bound = bindings.map(binding => binding.slot)
      const lines = [
        `必填槽位 ${slots.filter(slot => bound.includes(slot)).length}/${slots.length} 已绑定`,
        ...slots.map(slot => `- ${slot}: ${bound.includes(slot) ? '已绑定' : `未绑定${plan.planned.some(choice => choice.slot === slot) ? '(可自动补齐)' : '(无已验证候选,先连厂商并探测)'}`}`),
      ]
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    },
  )

  server.registerTool(
    'list_connections',
    { description: '列出组织已连接的模型厂商与每个连接下已验证的模型(含模态)' },
    async () => {
      const connections = await db.providerConnection.findMany({
        where: { organizationId: auth.organizationId },
        include: { capabilities: true },
        orderBy: { createdAt: 'asc' },
      })
      if (connections.length === 0) {
        return { content: [{ type: 'text' as const, text: '还没有任何厂商连接。先在模型中心添加连接并探测。' }] }
      }
      const text = connections
        .map(connection => `${connection.provider}「${connection.name}」\n` + connection.capabilities
          .map(capability => `  - ${capability.model} (${capability.modality}${capability.entitlementVerifiedAt || capability.credentialVerifiedAt ? ', 已验证' : ', 未验证'})`)
          .join('\n'))
        .join('\n')
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  server.registerTool(
    'auto_bind',
    {
      description: '一键补齐必填槽位:把已验证的厂商模型按目录推荐档绑定到空缺必填槽位(tts_voice 等可选槽默认不动,要绑需显式说明)',
      inputSchema: { includeOptionalVoice: z.boolean().optional().describe('是否把可选的 tts_voice(配音)也一并绑定') },
    },
    async ({ includeOptionalVoice }) => {
      const slots = includeOptionalVoice ? [...wiredRequiredSlots(), 'tts_voice' as const] : wiredRequiredSlots()
      const { connections, bindings } = await loadOrgModelPool(db, auth.organizationId)
      const plan = planAutoBind(connections, bindings, slots, recommendedForPredicate())
      if (plan.planned.length === 0) {
        return { content: [{ type: 'text' as const, text: `没有可绑定的计划。${plan.unfulfilled.length > 0 ? `缺候选的槽位: ${plan.unfulfilled.join(', ')}——先连厂商并探测。` : '必填槽位已全部绑定。'}` }] }
      }
      const created: string[] = []
      const skipped: string[] = []
      for (const choice of plan.planned) {
        const result = await createBinding(db, auth, { slot: choice.slot, capabilityId: choice.capabilityId, projectId: null })
        if (result.ok) created.push(`${choice.slot} → ${choice.provider}/${choice.model}`)
        else skipped.push(`${choice.slot} → ${choice.model}: ${result.error}`)
      }
      const text = [`已绑定 ${created.length} 项`, ...created.map(item => `- ${item}`), ...(skipped.length > 0 ? ['跳过', ...skipped.map(item => `- ${item}`)] : []), ...(plan.unfulfilled.length > 0 ? [`仍缺候选: ${plan.unfulfilled.join(', ')}`] : [])].join('\n')
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  return server
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/mcp',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth!
      reply.hijack()
      const server = buildMcpServer(app.db, auth)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      reply.raw.on('close', () => {
        void server.close()
        void transport.close()
      })
      await server.connect(transport)
      await transport.handleRequest(request.raw, reply.raw, request.body)
    },
  )

  // 无状态端点:GET(SSE)/DELETE(会话终止)没有对应语义,按协议答 405。
  const methodNotAllowed = async (_request: unknown, reply: { code: (status: number) => { send: (body: unknown) => void } }) => {
    await Promise.resolve(reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: stateless MCP endpoint, POST only' }, id: null }))
  }
  app.get('/mcp', methodNotAllowed as never)
  app.delete('/mcp', methodNotAllowed as never)
}
