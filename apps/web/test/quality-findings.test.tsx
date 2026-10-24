import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QualityFindingsTable } from '@/components/episode/quality-findings-panel'
import { ApiError, type ApiClient } from '@/lib/api'
import { I18nProvider } from '@/lib/i18n'
import {
  decideFinding,
  listQualityFindings,
  sortFindingsBySeverity,
  type QualityFinding,
} from '@/lib/quality-findings'

/**
 * US-034 质量问题队列。组件走 react-dom/server 渲染断言（本仓测试跑在 node 环境，
 * 无 DOM）；裁决流程在 api client 注入层 mock——与 useSession 注入页面的同一签名。
 */

function makeFinding(overrides: Partial<QualityFinding> = {}): QualityFinding {
  return {
    id: 'f1',
    dimension: 'video',
    severity: 'blocking',
    message: 'no video stream found',
    evidenceTimeSeconds: 312,
    storyboardId: 'sb-3',
    status: 'open',
    decidedBy: null,
    reason: null,
    fingerprint: 'fp-1',
    ...overrides,
  }
}

/** 记录每次调用的假 api：PATCH 断言看 calls，不真发请求。 */
function recordingApi(respond: () => unknown): { api: ApiClient; calls: Array<{ path: string; init?: RequestInit }> } {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const api = (async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    return respond() as never
  }) as ApiClient
  return { api, calls }
}

function renderTable(findings: QualityFinding[], canDecide = true): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <QualityFindingsTable
        findings={findings}
        canDecide={canDecide}
        onAccept={() => {}}
        onResolve={() => {}}
        onLocateShot={() => {}}
      />
    </I18nProvider>,
  )
}

describe('质量问题队列', () => {
  it('渲染 findings 列表：严重度徽标、维度、消息、时间点、状态都可读', () => {
    const html = renderTable([
      makeFinding({ id: 'f1', severity: 'blocking', status: 'open' }),
      makeFinding({
        id: 'f2',
        severity: 'warning',
        status: 'stale',
        message: 'suspected black frame at 41s',
        evidenceTimeSeconds: null,
        storyboardId: null,
      }),
    ])
    expect(html).toContain('no video stream found')
    expect(html).toContain('suspected black frame at 41s')
    expect(html).toContain('Blocking')
    expect(html).toContain('Warning')
    expect(html).toContain('Video')
    expect(html).toContain('312s')
    expect(html).toContain('Open')
    expect(html).toContain('Outdated')
    // 只有带 storyboardId 的行给定位入口：第二行不该有。
    expect(html.match(/Show this shot/g)).toHaveLength(1)
  })

  it('stale 与已裁决行的操作禁用，open 行可操作', () => {
    const stale = renderTable([makeFinding({ status: 'stale' })])
    expect(stale).toContain('Outdated')
    // 断言真实渲染出的 disabled 属性（按钮的 className 自带 disabled: 前缀工具类，不能当判据）。
    expect(stale).toContain('disabled=""')

    const decided = renderTable([makeFinding({ status: 'accepted', decidedBy: 'a@studio.dev', reason: 'intentional' })])
    expect(decided).toContain('Accepted')
    expect(decided).toContain('disabled=""')
    // 可读摘要：裁决人与理由留在行里，列表自己能复盘。
    expect(decided).toContain('a@studio.dev')
    expect(decided).toContain('intentional')

    const open = renderTable([makeFinding({ status: 'open' })])
    expect(open).toContain('Open')
    expect(open).not.toContain('disabled=""')
  })

  it('接受流程：填理由后按契约调 PATCH，理由去掉首尾空白', async () => {
    const { api, calls } = recordingApi(() => ({
      finding: {
        id: 'f1',
        status: 'accepted',
        dimension: 'video',
        severity: 'warning',
        message: 'width 540 differs from expected 720',
        evidenceTimeSeconds: null,
        storyboardId: null,
        decidedBy: 'a@studio.dev',
        reason: 'rewatched — intentional',
        fingerprint: 'fp-2',
      },
    }))
    const result = await decideFinding(api, 'f1', 'accept', '  rewatched — intentional  ')
    expect(calls).toEqual([
      {
        path: '/quality-findings/f1',
        init: { method: 'PATCH', body: JSON.stringify({ action: 'accept', reason: 'rewatched — intentional' }) },
      },
    ])
    expect(result).toEqual({
      ok: true,
      finding: expect.objectContaining({ id: 'f1', status: 'accepted', decidedBy: 'a@studio.dev' }),
    })
  })

  it('空理由不发请求：后端 400 之前先在本地拦下', async () => {
    const { api, calls } = recordingApi(() => ({}))
    const result = await decideFinding(api, 'f1', 'resolve', '   ')
    expect(calls).toEqual([])
    expect(result).toEqual({ ok: false, kind: 'reasonRequired' })
  })

  it('409（已 stale 或已被裁决）不抛异常，返回 conflict 让界面刷新后说明', async () => {
    const { api, calls } = recordingApi(() => {
      throw new ApiError('qualityFinding:stale', 409, { code: 'qualityFinding:stale' })
    })
    const result = await decideFinding(api, 'f9', 'accept', 'looks fine')
    expect(calls.map(call => call.path)).toEqual(['/quality-findings/f9'])
    expect(result).toEqual({ ok: false, kind: 'conflict' })
  })

  it('GET 404（尚无合成母带）读作「尚未检查」而不是错误', async () => {
    const { api, calls } = recordingApi(() => {
      throw new ApiError('no composition', 404, null)
    })
    expect(await listQualityFindings(api, 'ep1')).toBeNull()
    expect(calls).toEqual([{ path: '/episodes/ep1/quality-findings' }])
  })

  it('旧快照缺裁决字段时补默认值：未带 status 的行按 open 渲染', async () => {
    const { api } = recordingApi(() => ({
      compositionId: 'c1',
      passed: false,
      findings: [
        { id: 'probe_failed', severity: 'blocking', dimension: 'file', message: 'ffprobe failed to parse the file', evidenceTimeSeconds: null },
      ],
    }))
    const snapshot = await listQualityFindings(api, 'ep1')
    expect(snapshot?.compositionId).toBe('c1')
    expect(snapshot?.findings[0]).toMatchObject({
      id: 'probe_failed',
      status: 'open',
      storyboardId: null,
      decidedBy: null,
      reason: null,
    })
  })

  it('队列按严重度排：阻断在前，警告居中，提示垫底，同级保持后端顺序', () => {
    const sorted = sortFindingsBySeverity([
      makeFinding({ id: 'i1', severity: 'info' }),
      makeFinding({ id: 'w1', severity: 'warning' }),
      makeFinding({ id: 'i2', severity: 'info' }),
      makeFinding({ id: 'b1', severity: 'blocking' }),
      makeFinding({ id: 'w2', severity: 'warning' }),
    ])
    expect(sorted.map(finding => finding.id)).toEqual(['b1', 'w1', 'w2', 'i1', 'i2'])
  })
})
