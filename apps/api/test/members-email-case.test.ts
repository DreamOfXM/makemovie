import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

/**
 * 邮箱大小写：注册时敲的是 `Zhang.San@Corp.com`，加成员时敲的是同一个人。
 *
 * 曾经这两条路各自为政——注册原样存、加成员先 toLowerCase 再按精确值查，于是邮箱里
 * 只要有一个大写字母，这个人就永远「未注册」。这里锁三件事：存的必须是归一后的、
 * 查必须忽略大小写（含修之前落库的历史大写行），以及同一个人在同一空间只能有一条成员。
 */
let env: TestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

const login = (payload: Record<string, unknown>) =>
  env.app.inject({ method: 'POST', url: '/auth/login', payload })

const invite = (token: string, email: string, role = 'EDITOR') =>
  env.app.inject({ method: 'POST', url: '/api/members', headers: env.authHeaders(token), payload: { email, role } })

describe('email case handling', () => {
  it('stores the address normalized, so the login side never has to guess', async () => {
    await env.register('McOwner-0926@Example.com', 'MC Org')
    // 落库的是归一后的形式，原样带大写的行不该存在
    expect(await env.db.user.findUnique({ where: { email: 'mcowner-0926@example.com' } })).not.toBeNull()
    expect(await env.db.user.findFirst({ where: { email: 'McOwner-0926@Example.com' } })).toBeNull()

    for (const typed of ['McOwner-0926@Example.com', 'mcowner-0926@example.com', 'MCOWNER-0926@EXAMPLE.COM']) {
      const res = await login({ email: typed, password: 'password123' })
      expect(res.statusCode, typed).toBe(200)
      expect(res.json().token).toBeTruthy()
    }

    // 同一个人换种大小写再注册：撞 409，而不是悄悄开出第二个账号
    const dup = await env.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'MCOWNER-0926@example.com', password: 'password123', organizationName: 'Second Org' },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('adds a member whose stored address still carries capitals (pre-fix rows)', async () => {
    const owner = await env.register('mc-adder@example.com', 'Adder Org')
    // 直接落一条大写邮箱的用户，模拟修复前注册的账号：归一化只保证新数据，
    // 历史行必须靠查询侧的 insensitive 才捞得回来。
    const legacy = await env.db.user.create({
      data: { email: 'Legacy.User@Corp.com', name: 'Legacy', passwordHash: 'not-a-real-hash' },
    })

    const res = await invite(owner.token, 'legacy.user@corp.com')
    expect(res.statusCode).toBe(201)
    expect(res.json().userId).toBe(legacy.id)

    // 同一人换个大小写再邀请：命中已有成员，报 409 而不是再建一条
    const again = await invite(owner.token, 'Legacy.User@CORP.com')
    expect(again.statusCode).toBe(409)
    const rows = await env.db.organizationMember.findMany({
      where: { organizationId: owner.organization.id, userId: legacy.id },
    })
    expect(rows).toHaveLength(1)
  })

  it('finds that member back through the fuzzy email search regardless of case', async () => {
    const owner = await env.register('mc-search@example.com', 'Search Org')
    await env.register('Peer.Person@Corp.com', 'Peer Org')
    const peer = await env.db.user.findFirstOrThrow({ where: { email: 'peer.person@corp.com' } })

    const res = await env.app.inject({
      method: 'GET',
      url: '/api/members?email=PEER.person',
      headers: env.authHeaders(owner.token),
    })
    expect(res.statusCode).toBe(200)
    const found = res.json() as { userId: string; member: boolean }[]
    expect(found.map(item => item.userId)).toEqual([peer.id])
    // 安装内查得到人，但对本空间不是成员——必须如实报 member:false，不能给占位角色
    expect(found[0].member).toBe(false)

    const added = await invite(owner.token, peer.email)
    expect(added.statusCode).toBe(201)
    const after = await env.app.inject({
      method: 'GET',
      url: '/api/members?email=peer.PERSON@corp',
      headers: env.authHeaders(owner.token),
    })
    expect(after.json()).toEqual([
      expect.objectContaining({ userId: peer.id, member: true, role: 'EDITOR' }),
    ])
  })
})
