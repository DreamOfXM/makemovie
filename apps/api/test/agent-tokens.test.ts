import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let viewerToken: string
let organizationId: string

const authHeaders = (token: string) => env.authHeaders(token)

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('agent-owner@example.com', 'Agent Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
  await env.register('agent-viewer@example.com', 'Agent Viewer Org')
  const added = await env.app.inject({ method: 'POST', url: '/api/members', headers: authHeaders(ownerToken), payload: { email: 'agent-viewer@example.com', role: 'VIEWER' } })
  expect(added.statusCode).toBe(201)
  const login = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'agent-viewer@example.com', password: 'password123', organizationId } })
  expect(login.statusCode).toBe(200)
  viewerToken = login.json().token as string
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })

describe('agent tokens', () => {
  it('issues a one-time secret that authenticates API calls and MCP', async () => {
    const created = await env.app.inject({ method: 'POST', url: '/api/agent-tokens', headers: authHeaders(ownerToken), payload: { name: 'claude-code' } })
    expect(created.statusCode).toBe(201)
    const body = created.json() as { token: { id: string; name: string; role: string }; secret: string }
    expect(body.token.name).toBe('claude-code')
    expect(body.secret).toMatch(/^mmt_/)

    // Agent 令牌走同一条 authenticate:REST 能读,MCP 能握手。
    const readiness = await env.app.inject({ method: 'GET', url: '/api/system/readiness', headers: { authorization: `Bearer ${body.secret}` } })
    expect(readiness.statusCode).toBe(200)

    const init = await env.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${body.secret}`, ...MCP_HEADERS }, payload: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }) })
    expect(init.statusCode).toBe(200)
    expect(init.json().result.serverInfo.name).toBe('makemovie')

    const tools = await env.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${body.secret}`, ...MCP_HEADERS }, payload: rpc('tools/list') })
    expect(tools.statusCode).toBe(200)
    const toolNames = (tools.json().result.tools as { name: string }[]).map(tool => tool.name)
    expect(toolNames).toContain('slot_readiness')
    expect(toolNames).toContain('auto_bind')

    // 吊销后立刻失效,列表里带着已吊销标记。
    const revoked = await env.app.inject({ method: 'DELETE', url: `/api/agent-tokens/${body.token.id}`, headers: authHeaders(ownerToken) })
    expect(revoked.statusCode).toBe(200)
    const afterRevoke = await env.app.inject({ method: 'GET', url: '/api/system/readiness', headers: { authorization: `Bearer ${body.secret}` } })
    expect(afterRevoke.statusCode).toBe(401)
    const list = await env.app.inject({ method: 'GET', url: '/api/agent-tokens', headers: authHeaders(ownerToken) })
    expect(list.statusCode).toBe(200)
    const listed = list.json().tokens as { id: string; revokedAt: string | null }[]
    expect(listed.find(token => token.id === body.token.id)?.revokedAt).not.toBeNull()
    // hash 永不出现在任何响应里。
    expect(JSON.stringify(listed)).not.toContain(body.secret)
  })

  it('keeps token management to provider managers and refuses OWNER tokens', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/agent-tokens', headers: authHeaders(viewerToken) })).statusCode).toBe(403)
    expect((await env.app.inject({ method: 'GET', url: '/api/agent-tokens' })).statusCode).toBe(401)
    const badRole = await env.app.inject({ method: 'POST', url: '/api/agent-tokens', headers: authHeaders(ownerToken), payload: { name: 'x', role: 'OWNER' } })
    expect(badRole.statusCode).toBe(400)
    const noName = await env.app.inject({ method: 'POST', url: '/api/agent-tokens', headers: authHeaders(ownerToken), payload: { name: '  ' } })
    expect(noName.statusCode).toBe(400)
  })

  it('answers 405 on the stateless GET/DELETE MCP routes and 401 without a token', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/mcp', headers: authHeaders(ownerToken) })).statusCode).toBe(405)
    expect((await env.app.inject({ method: 'POST', url: '/mcp', headers: MCP_HEADERS, payload: rpc('tools/list') })).statusCode).toBe(401)
  })
})
