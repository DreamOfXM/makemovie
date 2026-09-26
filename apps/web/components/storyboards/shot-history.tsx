'use client'

import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from 'lucide-react'
import { translateEnum, useI18n, type TranslateFn } from '@/lib/i18n'
import type { ShotEvent } from '@/lib/shot-history'
import { batchCountOf } from '@/lib/shot-history'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** 历史行横跨几天，只给「22:24」会看不出是哪天；月日 + 时分是这个密度下能说清的最少信息。 */
function stamp(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** 一格读数：一个标签、一个展示级数字、一行出处。数字之外的都不许抢嗓门。 */
function ReadoutCell({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail: string
  tone?: 'neutral' | 'ok' | 'warn'
}) {
  return (
    <div className="min-w-0">
      <p className="text-subtle-foreground font-mono text-[9.5px] tracking-[0.14em] uppercase">{label}</p>
      <p
        className={cn(
          'mt-1 text-xl leading-none font-semibold tabular-nums',
          tone === 'ok' && 'text-success',
          tone === 'warn' && 'text-destructive',
        )}
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-1.5 text-xs leading-snug">{detail}</p>
    </div>
  )
}

interface ShotReadoutProps {
  plannedMs: number
  clipMs: number | null
  voiceMs: number | null
  /** 首帧/成片各自的质检分；null 表示没被评过（质检关掉时也是 null，所以只能写「没判过」）。 */
  frameScore: number | null
  clipScore: number | null
  /** 质检线（后端下发）。undefined = 还不知道，于是不涂色也不写「线多少」。 */
  qcThreshold: number | undefined
  /** 这一镜到底有没有成片产物。时长量不到时靠它分清「还没有」和「有但没量到」。 */
  hasClip: boolean
  /** 分镜绑了几个角色。道具和场景不算进「画面人数」的出处，机器也从没数过画面里有几个人。 */
  characters: number
}

export function ShotReadout({ plannedMs, clipMs, voiceMs, frameScore, clipScore, qcThreshold, hasClip, characters }: ShotReadoutProps) {
  const { t } = useI18n()
  const score = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}`)
  const delta = clipMs === null ? null : clipMs - plannedMs
  const detail = [
    clipMs === null
      ? t(hasClip ? 'storyboards.readoutUnmeasured' : 'storyboards.readoutNoClip')
      : t('storyboards.readoutPlanned', {
          planned: formatDuration(plannedMs),
          delta: t((delta ?? 0) < 0 ? 'storyboards.readoutShort' : 'storyboards.readoutLong', {
            delta: formatDuration(Math.abs(delta ?? 0)),
          }),
        }),
    clipMs !== null && voiceMs
      ? t(voiceMs <= clipMs ? 'storyboards.readoutVoiceFits' : 'storyboards.readoutVoiceOver', { voice: formatDuration(voiceMs) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="border-t px-4 py-4">
      <p className="text-subtle-foreground mb-3 font-mono text-[9.5px] tracking-[0.14em] uppercase">
        {t('storyboards.readoutTitle')}
      </p>
      <div className="grid gap-5 sm:grid-cols-3">
        <ReadoutCell label={t('storyboards.readoutDuration')} value={clipMs === null ? '—' : formatDuration(clipMs)} detail={detail} />
        <ReadoutCell
          label={t('storyboards.readoutQc')}
          value={score(clipScore)}
          tone={clipScore === null || qcThreshold === undefined ? 'neutral' : clipScore >= qcThreshold ? 'ok' : 'warn'}
          detail={
            frameScore === null
              ? t('storyboards.readoutNoScore')
              : t('storyboards.readoutFrameLine', { frame: score(frameScore), line: score(qcThreshold ?? null) })
          }
        />
        <ReadoutCell
          label={t('storyboards.readoutCast')}
          value={t('storyboards.readoutYouJudge')}
          detail={t(characters === 0 ? 'storyboards.readoutNoCast' : 'storyboards.readoutSubjects', { count: characters })}
        />
      </div>
    </div>
  )
}

interface ShotHistoryProps {
  events: ShotEvent[]
  /** 只有当前那一版的镜头能被重抽或钦定：接口对已被替代的行会回 409。 */
  live: boolean
  /** 两个动作要两套权限（重抽=generation:trigger，钦定=storyboard:write），合成一个
   *  canWrite 会让其中一种用户看见点了没反应的按钮。 */
  canRetry: boolean
  canPin: boolean
  qcThreshold: number | undefined
  /** 这一镜正在抽的阶段：转圈期间行尾的动作按钮不受理第二次点击。 */
  busy: boolean
  onRetry(stage: 'IMAGE' | 'VIDEO' | 'AUDIO'): void
  onPin(artifactId: string): void
}

const VISIBLE_ROWS = 3

function eventLabel(event: ShotEvent, t: TranslateFn): string {
  if (event.kind === 'BREAKDOWN') return t('storyboards.eventBreakdown')
  return translateEnum(t, 'generations.stage', event.kind)
}

function eventMessage(event: ShotEvent, t: TranslateFn): string {
  if (event.kind === 'BREAKDOWN') return t('storyboards.eventBreakdownReplaced', { revision: event.revision })
  const parts: string[] = []
  if (event.durationMs !== null) parts.push(formatDuration(event.durationMs))
  if (event.model) parts.push(event.model)
  if (event.tone === 'failed') {
    if (event.error) parts.push(event.error)
    // 这一条就是第几次尝试:一条任务会把它的每次尝试都记在 attempts 上，
    // 写重试上限会把「第 1 次就挂」和「抽满 3 次才挂」说成同一件事。
    if (event.attempts !== null) parts.push(t('storyboards.eventAttempts', { count: event.attempts }))
  } else if (event.tone === 'ok') {
    parts.push(t('storyboards.eventUsedAttempts', { count: event.attempts ?? 1 }))
    if (!event.selected) parts.push(t('storyboards.eventNotChosen'))
  }
  return parts.join(' · ')
}

/**
 * 状态徽章：失败用红、钦定用主色实心（它是这一镜的结论）。成功但没达线保持中性描边并
 * 明写「未达线」——不涂绿，绿的意思是达线；颜色一说谎，整栏都不能信。
 */
function EventBadge({ event, qcThreshold, t }: { event: ShotEvent; qcThreshold: number | undefined; t: TranslateFn }) {
  if (event.tone === 'failed')
    return (
      <Badge variant="destructive" className="h-5 shrink-0 px-1.5 text-[11px]">
        {t('storyboards.eventReworked')}
      </Badge>
    )
  if (event.tone === 'running')
    return (
      <Badge variant="muted" className="h-5 shrink-0 px-1.5 text-[11px]">
        {t('storyboards.eventRunning')}
      </Badge>
    )
  if (event.tone === 'replaced')
    return (
      <Badge variant="muted" className="h-5 shrink-0 px-1.5 text-[11px]">
        {t('storyboards.eventReplaced')}
      </Badge>
    )
  if (event.selected)
    return (
      <Badge className="h-5 shrink-0 px-1.5 text-[11px]">
        {`v${event.version ?? '—'} · ${t('storyboards.eventChosen')}`}
      </Badge>
    )
  const below = event.score !== null && qcThreshold !== undefined && event.score < qcThreshold
  return (
    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[11px]">
      {`v${event.version ?? '—'} ${t('storyboards.eventSucceeded')}${below ? ` · ${t('storyboards.eventBelowLine')}` : ''}`}
    </Badge>
  )
}

/**
 * 这一镜的历史：按镜号聚合，跨批次、跨阶段，新的在上。批次那层没有删掉，降级成行尾那枚
 * 「批 N」——日常要回答的是「#3 这一镜怎么样了」，不是「22:24 那一批怎么样了」。
 */
export function ShotHistory({ events, live, canRetry, canPin, qcThreshold, busy, onRetry, onPin }: ShotHistoryProps) {
  const { t, locale } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [failedOnly, setFailedOnly] = useState(false)

  const failed = events.filter(event => event.tone === 'failed')
  const rows = failedOnly ? failed : events
  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS)
  const hidden = rows.length - shown.length

  return (
    <div className="border-t px-4 pb-4">
      <div className="flex flex-wrap items-center gap-2 py-3">
        <p className="text-subtle-foreground font-mono text-[9.5px] tracking-[0.14em] uppercase">{t('storyboards.shotHistory')}</p>
        {events.length > 0 && (
          <span className="text-muted-foreground text-xs">{t('storyboards.shotHistoryCount', { count: events.length, batches: batchCountOf(events) })}</span>
        )}
        {failed.length > 0 && (
          <button
            type="button"
            aria-pressed={failedOnly}
            onClick={() => {
              setFailedOnly(value => !value)
              setExpanded(false)
            }}
            className={cn('text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-medium', failedOnly && 'text-destructive')}
          >
            {failedOnly ? t('storyboards.shotHistoryAll') : t('storyboards.shotHistoryFailedOnly')}
            {failedOnly ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('storyboards.shotHistoryEmpty')}</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {shown.map(event => {
            const message = eventMessage(event, t)
            // 空消息不给气泡：flex-1 的跨度照样能悬停，会弹出一个空黑框。
            const messageCell = (
              <span className="text-muted-foreground min-w-0 flex-1 truncate">{message}</span>
            )
            const retryable = live && canRetry && !busy && event.tone === 'failed' && event.kind !== 'BREAKDOWN'
            const pinnable = live && canPin && !busy && event.kind === 'VIDEO' && event.tone === 'ok' && !event.selected && event.artifactId !== null
            return (
              <li
                key={event.key}
                className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 text-xs', event.tone === 'failed' && 'bg-destructive/5', event.selected && 'bg-muted/30')}
              >
                <time className="text-subtle-foreground shrink-0 tabular-nums">{stamp(event.at, locale)}</time>
                <span className="text-muted-foreground w-14 shrink-0">{eventLabel(event, t)}</span>
                <EventBadge event={event} qcThreshold={qcThreshold} t={t} />
                {message ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{messageCell}</TooltipTrigger>
                    <TooltipContent className="break-all">{message}</TooltipContent>
                  </Tooltip>
                ) : messageCell}
                {event.tone === 'failed' && event.bestScore !== null ? (
                  <span className="text-destructive shrink-0 tabular-nums">
                    {t('storyboards.eventBestScore', { score: Math.round(event.bestScore * 100) })}
                  </span>
                ) : event.score !== null ? (
                  <span
                    className={cn(
                      'shrink-0 tabular-nums',
                      qcThreshold === undefined
                        ? 'text-muted-foreground'
                        : event.score >= qcThreshold
                          ? 'text-success'
                          : 'text-destructive',
                    )}
                  >
                    {Math.round(event.score * 100)}
                  </span>
                ) : null}
                {retryable && (
                  <button type="button" onClick={() => onRetry(event.kind as 'IMAGE' | 'VIDEO' | 'AUDIO')} className="text-primary shrink-0 font-medium hover:underline">
                    {t('storyboards.eventRetry')}
                  </button>
                )}
                {pinnable && event.artifactId && (
                  <button type="button" onClick={() => onPin(event.artifactId as string)} className="text-primary shrink-0 font-medium hover:underline">
                    {t('storyboards.eventChoose')}
                  </button>
                )}
                {event.batchSeq !== null && (
                  <span className="text-subtle-foreground shrink-0 font-mono text-[10px] tracking-wide">
                    {t('storyboards.eventBatch', { seq: event.batchSeq })}
                  </span>
                )}
              </li>
            )
          })}
          {hidden > 0 && (
            <li>
              <button type="button" onClick={() => setExpanded(true)} className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 py-2 text-xs">
                <ChevronDownIcon className="size-3.5" />
                {t('storyboards.shotHistoryMore', { count: hidden })}
              </button>
            </li>
          )}
          {expanded && rows.length > VISIBLE_ROWS && (
            <li>
              <button type="button" onClick={() => setExpanded(false)} className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 py-2 text-xs">
                <ChevronRightIcon className="size-3.5" />
                {t('storyboards.shotHistoryLess')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
