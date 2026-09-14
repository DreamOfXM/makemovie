'use client'

import { useMemo, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, HistoryIcon } from 'lucide-react'
import type { Asset, Storyboard } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { formatDateTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { StoryboardCard } from '@/components/storyboards/storyboard-card'

interface StoryboardHistoryProps {
  /** Superseded shots only: the revisions the live shot list replaced. */
  shots: Storyboard[]
  canWrite: boolean
  episodeAssets: Asset[]
  onBindAssets(storyboardId: string, assets: { assetId: string; role: string }[]): Promise<void>
  onEdit(storyboard: Storyboard): void
  onChangeStatus(storyboard: Storyboard): void
}

/**
 * A regenerate writes a new revision instead of appending shots, so the previous breakdown
 * stays readable here — collapsed by default, grouped per revision, still showing the first
 * frames and video that were paid for.
 */
export function StoryboardHistory({
  shots,
  canWrite,
  episodeAssets,
  onBindAssets,
  onEdit,
  onChangeStatus,
}: StoryboardHistoryProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)

  const revisions = useMemo(() => {
    const byRevision = new Map<number, Storyboard[]>()
    for (const shot of shots) {
      const revision = shot.revision ?? 1
      const group = byRevision.get(revision)
      if (group) group.push(shot)
      else byRevision.set(revision, [shot])
    }
    return [...byRevision.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([revision, revisionShots]) => {
        const supersededAt = revisionShots
          .map(shot => shot.supersededAt)
          .filter((value): value is string => value !== null && value !== undefined)
          .sort()
          .at(-1)
        return {
          revision,
          shots: [...revisionShots].sort((a, b) => a.number - b.number),
          supersededAt: supersededAt ?? null,
        }
      })
  }, [shots])

  if (shots.length === 0) return null

  return (
    <div className="rounded-lg border border-dashed">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors"
      >
        {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
        <HistoryIcon className="size-4 shrink-0" />
        <span className="font-medium">{t('storyboards.history')}</span>
        <Badge variant="muted" className="font-normal">
          {t('storyboards.historyCount', { count: shots.length, revisions: revisions.length })}
        </Badge>
      </button>

      {open && (
        <div className="space-y-5 border-t p-3">
          <p className="text-muted-foreground text-xs">{t('storyboards.historyHint')}</p>
          {revisions.map(revision => (
            <section key={revision.revision} className="space-y-3">
              <header className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono">
                  {t('storyboards.revision', { revision: revision.revision })}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  {t('projects.storyboardCount', { count: revision.shots.length })}
                  {revision.supersededAt &&
                    ` · ${t('storyboards.supersededAt', { time: formatDateTime(revision.supersededAt, locale) })}`}
                </span>
              </header>
              {revision.shots.map(shot => (
                <StoryboardCard
                  key={shot.id}
                  storyboard={shot}
                  canWrite={canWrite}
                  episodeAssets={episodeAssets}
                  onBindAssets={onBindAssets}
                  onEdit={() => onEdit(shot)}
                  onChangeStatus={() => onChangeStatus(shot)}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
