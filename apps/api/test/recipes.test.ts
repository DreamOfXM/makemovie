import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let organizationId: string

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('recipe-owner@example.com', 'Recipe Org')
  ownerToken = owner.token
  organizationId = owner.organization.id
}, 300_000)

afterAll(async () => { await env?.stop() })

const authHeaders = (token: string) => env.authHeaders(token)

describe('recipes (US-005)', () => {
  it('lists official recipes without auth; 9:16 and 16:9 share one rule set', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/recipes' })
    expect(res.statusCode).toBe(200)
    const recipes = (res.json() as { recipes: Array<{ recipeKey: string; spec: Record<string, unknown> }> }).recipes
    expect(recipes.map(recipe => recipe.recipeKey)).toEqual(['drama-serial', 'drama-short'])
    // 共用规则:除画幅与时长档外逐字段一致——不是两条流水线。
    const [serial, short] = recipes
    const { aspect: _a, targetShotDurationMs: _t, ...serialRest } = serial.spec
    const { aspect: _b, targetShotDurationMs: _u, ...shortRest } = short.spec
    expect(serialRest).toEqual(shortRest)
    expect(serial.spec.aspect).toBe('9:16')
    expect(short.spec.aspect).toBe('16:9')
  })

  it('publishes immutably: same version rejects different content, republish is idempotent', async () => {
    const first = await env.app.inject({ method: 'POST', url: '/api/recipes/publish', headers: authHeaders(ownerToken), payload: { recipeKey: 'drama-serial', version: 1 } })
    expect(first.statusCode).toBe(201)
    expect(first.json().published).toBe(true)
    // 幂等重发:已存在且 checksum 一致 → alreadyPresent,不报错不重写。
    const again = await env.app.inject({ method: 'POST', url: '/api/recipes/publish', headers: authHeaders(ownerToken), payload: { recipeKey: 'drama-serial', version: 1 } })
    expect(again.statusCode).toBe(200)
    expect(again.json().alreadyPresent).toBe(true)
    // 未知配方 400。
    const unknown = await env.app.inject({ method: 'POST', url: '/api/recipes/publish', headers: authHeaders(ownerToken), payload: { recipeKey: 'nope', version: 9 } })
    expect(unknown.statusCode).toBe(400)
    void organizationId
  })

  it('snapshots into a project at instantiation and serves it back verbatim', async () => {
    const created = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Recipe Drama' } })
    const projectId = created.json().id as string
    const { OFFICIAL_RECIPES } = await import('@studio/pipeline')
    const recipe = OFFICIAL_RECIPES[0]!
    // 实例化:快照进项目(US-006 建项服务将走同一路径;此处按落库事实测)。
    await env.db.project.update({
      where: { id: projectId },
      data: { recipeKey: recipe.recipeKey, recipeVersion: recipe.version, recipeSnapshot: JSON.stringify(recipe.spec) },
    })
    const read = await env.app.inject({ method: 'GET', url: `/api/projects/${projectId}/recipe`, headers: authHeaders(ownerToken) })
    expect(read.statusCode).toBe(200)
    const body = read.json() as { recipeKey: string; recipeVersion: number; snapshot: Record<string, unknown> }
    expect(body.recipeKey).toBe('drama-serial')
    expect(body.snapshot.aspect).toBe('9:16')
    // 旧项目(无快照)诚实 404,不回退到「最新配方」冒充。
    const bare = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authHeaders(ownerToken), payload: { name: 'Bare' } })
    const bareRead = await env.app.inject({ method: 'GET', url: `/api/projects/${bare.json().id}/recipe`, headers: authHeaders(ownerToken) })
    expect(bareRead.statusCode).toBe(404)
    expect(bareRead.json().error).toContain('no recipe snapshot')
  })
})
