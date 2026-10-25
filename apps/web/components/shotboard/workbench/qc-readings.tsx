'use client'

import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'

/**
 * SD-081：审核过去只往屏上送一个总分，于是「四秒里哪一秒崩了」在评审处读不出来——
 * 同一镜的四条 findings 全挂在同一个时刻（实测 2.048 s），看起来像只有一种毛病。
 *
 * worker 早就把逐帧分、结构漂移、邻镜重复写进了 QualityCheck.report；这里只负责把
 * 已经下发的事实摊开，不做任何判分，也不设新的合格线（SD-087/088 的量测结论：这组
 * 轴的合法与缺陷样本区间重叠，没有可站的阈值）。
 */

/** 与 API 下发形状同构；三项都是可选的——旧报文里根本没有它们。 */
export interface QcReadingsLike {
  frameScores?: { position: number; score: number }[]
  structureDrift?: {
    measured: boolean
    earlyLateDistance: number | null
    firstMidDistance: number | null
    maxStepDistance: number | null
    sampleSeconds: number[]
  } | null
  auditRepetition?: {
    matchedArtifactId: string | null
    pictureDistance: number | null
    status: 'no-baseline' | 'distinct' | 'repeated' | 'unknown'
  } | null
}

/** 0..1 的读数按两位小数报；不是有限数就返回 null，让调用方整句不写。 */
function reading(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : null
}

export function QcReadings({ readings, durationMs }: { readings: QcReadingsLike | null; durationMs: number | null }) {
  const { t } = useI18n()
  if (!readings) return null
  const frames = (readings.frameScores ?? []).filter(
    frame => Number.isFinite(frame.position) && Number.isFinite(frame.score) && frame.position >= 0 && frame.position <= 1,
  )
  const drift = readings.structureDrift ?? null
  const repeat = readings.auditRepetition ?? null
  if (frames.length === 0 && !drift && !repeat) return null

  const driftParts = drift
    ? [
        [t('workbench.qc.driftEarlyLate'), reading(drift.earlyLateDistance)],
        [t('workbench.qc.driftFirstMid'), reading(drift.firstMidDistance)],
        [t('workbench.qc.driftMaxStep'), reading(drift.maxStepDistance)],
      ].filter((part): part is [string, string] => part[1] !== null)
    : []

  const repeatDistance = repeat ? reading(repeat.pictureDistance) : null
  const repeatText = !repeat
    ? null
    : repeat.status === 'no-baseline'
      ? t('workbench.qc.repeat.noBaseline')
      : repeat.status === 'distinct'
        ? t('workbench.qc.repeat.distinct', { distance: repeatDistance ?? '—' })
        : repeat.status === 'repeated'
          ? t('workbench.qc.repeat.repeated', { distance: repeatDistance ?? '—' })
          : t('workbench.qc.repeat.unknown')

  return (
    <div className="space-y-1.5">
      {frames.length > 0 ? (
        <div>
          <p className="text-muted-foreground text-[10.5px] font-medium">{t('workbench.qc.frameScoresTitle')}</p>
          {/* 时间轴按片内相对位置铺开：横轴是「第几秒」，纵轴是那一格的分。柱子高度就是读数，
              不另设颜色档——同一屏里再造一套红黄绿会与合格线打架。 */}
          <div className="bg-muted/30 relative mt-1 flex h-10 items-end gap-px overflow-hidden rounded">
            {frames.map(frame => (
              <span
                key={`${frame.position}:${frame.score}`}
                style={{ left: `${frame.position * 100}%`, height: `${Math.max(6, Math.round(frame.score * 100))}%` }}
                className="bg-primary/70 absolute bottom-0 w-[3px] rounded-t-sm"
              />
            ))}
          </div>
          <div className="text-subtle-foreground mt-0.5 flex items-center justify-between text-[10px] tabular-nums">
            <span>0:00</span>
            <span>
              {t('workbench.qc.samples', { count: frames.length })}
              {durationMs !== null ? ` · ${formatDuration(durationMs)}` : ''}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-subtle-foreground text-[10.5px]">{t('workbench.qc.frameScoresMissing')}</p>
      )}

      {drift ? (
        !drift.measured ? (
          <p className="text-subtle-foreground text-[10.5px]">{t('workbench.qc.driftMissing')}</p>
        ) : driftParts.length > 0 ? (
          <p className="text-subtle-foreground text-[10.5px] tabular-nums">
            {t('workbench.qc.driftTitle')}
            {driftParts.map(([label, value]) => ` · ${label} ${value}`).join('')}
          </p>
        ) : (
          <p className="text-subtle-foreground text-[10.5px]">{t('workbench.qc.driftUnreadable')}</p>
        )
      ) : null}

      {repeatText ? (
        <p className={cn('text-subtle-foreground text-[10.5px] tabular-nums', repeat?.status === 'repeated' && 'text-warning-ink')}>
          {repeatText}
          {repeat?.status === 'repeated' && repeat.matchedArtifactId ? ` · ${repeat.matchedArtifactId}` : ''}
        </p>
      ) : null}
    </div>
  )
}
