'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import type { GenerationArtifact, ShotboardShot, ShotVideoCandidate } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { GuardedButton, usePermission } from '@/components/permission'
import { useArtifactUrl } from '@/components/generations/artifact-media'

interface VideoReviewLightboxProps {
  shot: ShotboardShot
  /** 打开时落在哪一版（点哪条候选缩略图就从哪版看起）；null＝已钦定版，其次最新一版。 */
  initialVersion: number | null
  onClose(): void
  /** 与右栏同一刷新链：钦定后镜头列表/候选行/钦定徽章全部回读。 */
  onChanged(): void
}

/**
 * 制作台 · 视频审查放大态（r02 骨架A·胶片条裁决台）：主播放器右上「放大」与
 * 候选缩略图都能进来。裁决动作留在放大态里——胶片条切版本，「选它」就地钦定，
 * 看完不用退出去点。选中语义分两轨：紫边＝正在看（唯一），绿字✓＝已钦定（标签层，
 * 不上第二道描边——同帧双色描边会打架，盲评点名过）。
 */
export function VideoReviewLightbox({ shot, initialVersion, onClose, onChanged }: VideoReviewLightboxProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const [viewVersion, setViewVersion] = useState<number | null>(initialVersion)
  const [busy, setBusy] = useState(false)

  const candidates = shot.videoCandidates

  // 打开时没点名版本：落在已钦定版；没有钦定就看最新一版。候选是「新→旧」排序，
  // 最新=[0]，取末位会把最旧一版当成最新（实测抓到过）。
  const current: ShotVideoCandidate | null = useMemo(() => {
    if (candidates.length === 0) return null
    if (viewVersion !== null) return candidates.find(item => item.version === viewVersion) ?? candidates[0]
    return candidates.find(item => item.selected) ?? candidates[0]
  }, [candidates, viewVersion])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
      if (candidates.length < 2) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const index = current ? candidates.findIndex(item => item.version === current.version) : -1
      if (index < 0) return
      event.preventDefault()
      const next = event.key === 'ArrowLeft' ? index - 1 : index + 1
      if (next >= 0 && next < candidates.length) setViewVersion(candidates[next].version)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [candidates, current, onClose])

  async function choose(candidate: ShotVideoCandidate) {
    setBusy(true)
    try {
      await api(`/storyboards/${shot.id}/video-selection`, {
        method: 'POST',
        body: JSON.stringify({ artifactId: candidate.artifactId }),
      })
      toast.success(t('shotboard.chosenToast'))
      onChanged()
      onClose()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(false)
    }
  }

  const single = candidates.length < 2
  const artifact: GenerationArtifact | null = current
    ? {
        id: current.artifactId,
        mimeType: current.mimeType,
        objectKey: '',
        version: current.version,
        width: null,
        height: null,
        durationMs: current.durationMs,
        downloadUrl: `/artifacts/${current.artifactId}/content`,
      }
    : shot.video
  if (!artifact) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="bg-background/80 fixed inset-0 z-50 flex flex-col p-5 backdrop-blur-sm"
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="flex items-center gap-3">
        <p className="text-sm font-semibold">
          <span className="text-muted-foreground font-mono font-medium">#{shot.number}</span> {shot.title}
          {current && <span className="text-muted-foreground ml-2 font-medium">v{current.version}</span>}
        </p>
        <span className="text-subtle-foreground text-xs tabular-nums">
          {formatDuration(artifact.durationMs ?? shot.durationMs)}
          {current?.qc && ` · QC ${current.qc.kind} ${current.qc.score !== null ? Math.round(current.qc.score * 100) : '—'}`}
        </span>
        <button
          type="button"
          aria-label="close"
          onClick={onClose}
          className="bg-muted ml-auto flex size-9 items-center justify-center rounded-full"
        >
          <XIcon className="size-5" />
        </button>
      </div>

      <div className="mt-2 flex min-h-0 flex-1 items-center justify-center">
        {!single && (
          <button
            type="button"
            aria-label="previous"
            disabled={candidates.findIndex(item => item.version === current?.version) <= 0}
            onClick={() => {
              const index = candidates.findIndex(item => item.version === current?.version)
              if (index > 0) setViewVersion(candidates[index - 1].version)
            }}
            className="bg-muted hover:opacity-80 mr-3.5 flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
          >
            <ChevronLeftIcon className="size-5" />
          </button>
        )}
        <BigVideo artifact={artifact} shotNumber={shot.number} title={shot.title} />
        {!single && (
          <button
            type="button"
            aria-label="next"
            disabled={candidates.findIndex(item => item.version === current?.version) >= candidates.length - 1}
            onClick={() => {
              const index = candidates.findIndex(item => item.version === current?.version)
              if (index >= 0 && index < candidates.length - 1) setViewVersion(candidates[index + 1].version)
            }}
            className="bg-muted hover:opacity-80 ml-3.5 flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
          >
            <ChevronRightIcon className="size-5" />
          </button>
        )}
      </div>

      {/* 胶片条：≥2 版才有（单版没有可裁决的对象，退化为纯放大）。 */}
      {!single && (
        <div className="mt-3 flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1">
            {candidates.map(candidate => {
              const viewing = current?.version === candidate.version
              const chosen = candidate.selected
              return (
                <button
                  key={candidate.artifactId}
                  type="button"
                  aria-pressed={viewing}
                  onClick={() => setViewVersion(candidate.version)}
                  className="shrink-0 text-left"
                >
                  <span className={cn(
                    'block overflow-hidden rounded-lg border-2',
                    viewing ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100',
                  )}>
                    <FilmThumb candidate={candidate} />
                  </span>
                  <span className={cn(
                    'mt-1 flex items-center justify-center gap-1 text-[11px] tabular-nums',
                    viewing ? 'text-foreground font-medium' : 'text-subtle-foreground',
                  )}>
                    {chosen && <CheckIcon className="text-success size-3" />}
                    {chosen ? t('shotboard.chosen') : `v${candidate.version}`}
                  </span>
                </button>
              )
            })}
          </div>
          {can('storyboard:write') && current && !current.selected && (
            <GuardedButton action="storyboard:write" variant="default" size="sm" disabled={busy} onClick={() => void choose(current)}>
              {t('shotboard.choose')}
            </GuardedButton>
          )}
          {current?.selected && (
            <Badge variant="success" className="shrink-0 font-normal">
              <CheckIcon className="size-3" />
              {t('shotboard.chosen')}
            </Badge>
          )}
          <span className="text-subtle-foreground hidden shrink-0 items-center gap-1 text-[11px] sm:flex">
            <kbd className="border-border/70 rounded border px-1 font-sans">←</kbd>
            <kbd className="border-border/70 rounded border px-1 font-sans">→</kbd>
            {t('workbench.reviewKbdHint')}
          </span>
        </div>
      )}
    </div>
  )
}

function BigVideo({ artifact, shotNumber, title }: { artifact: GenerationArtifact; shotNumber: number; title: string }) {
  const { url, failed, reload } = useArtifactUrl(artifact.downloadUrl)
  if (failed) {
    return (
      <button
        type="button"
        onClick={reload}
        className="border-destructive/40 bg-destructive/10 text-destructive-ink flex h-40 items-center gap-2 rounded-lg border px-4 text-xs"
      >
        {`#${shotNumber} ${title}`}
      </button>
    )
  }
  if (!url) return <div className="bg-muted/40 aspect-video w-[min(96vw,1100px)] animate-pulse rounded-xl" />
  return (
    <video
      key={artifact.id}
      src={url}
      controls
      aria-label={`#${shotNumber} ${title}`}
      className="aspect-video w-[min(96vw,1100px)] rounded-xl"
    />
  )
}

/** 胶片条缩略帧：preload=metadata 让浏览器用首帧当海报，不再另造缩略图接口。 */
function FilmThumb({ candidate }: { candidate: ShotVideoCandidate }) {
  const { url } = useArtifactUrl(`/artifacts/${candidate.artifactId}/content`)
  return (
    <video
      src={url ?? undefined}
      preload="metadata"
      muted
      tabIndex={-1}
      aria-hidden
      className="h-[54px] w-24 bg-muted/40 object-cover"
    />
  )
}
