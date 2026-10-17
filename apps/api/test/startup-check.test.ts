import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

describe('GET /system/startup-check (US-004)', () => {
  it('reports environment facts without auth and separates them from model readiness', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/system/startup-check' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { service: string; checks: Array<{ id: string; status: string; detail: string }> }
    expect(body.service).toBe('makemovie-api')
    const ids = body.checks.map(check => check.id)
    // 环境四件:数据库/ffmpeg/主密钥/存储。模型配置不在此列——那是登录后
    // /system/readiness 的事,两个面分开是本任务的存在理由。
    expect(ids).toEqual(expect.arrayContaining(['database', 'ffmpeg', 'master_key', 'storage']))
    expect(ids).not.toContain('models')
    expect(body.checks.find(check => check.id === 'database')?.status).toBe('ok')
  })

  it('names the missing ffmpeg filters instead of a generic failure', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/system/startup-check' })
    const ffmpeg = (res.json() as { checks: Array<{ id: string; status: string; detail: string }> }).checks.find(check => check.id === 'ffmpeg')!
    // 测试机 ffmpeg 完整与否都可能,但 detail 必须要么报能力,要么点名缺的滤镜。
    expect(ffmpeg.detail).toMatch(/subtitles and drawtext|missing filters: /)
  })
})
