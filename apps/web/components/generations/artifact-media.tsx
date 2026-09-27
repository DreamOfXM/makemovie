'use client'

import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'
import { AlertTriangleIcon, DownloadIcon, RotateCwIcon } from 'lucide-react'
import { artifactHref, type GenerationArtifact } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { ArtifactLightbox } from '@/components/artifact-lightbox'

export interface ArtifactLoad {
  url: string | null
  /** True only after a real failure. `url === null && !failed` means still fetching. */
  failed: boolean
  reload: () => void
}

/**
 * Media elements cannot send the bearer token, so artifacts are fetched with the
 * session header and exposed as revocable blob URLs.
 *
 * Failure has to be a third state, not a fourth way of returning null: callers that
 * render a skeleton while `url` is null will pulse forever on a 404, and "产物读不出来"
 * looked exactly like "产物还在路上" — which is the one thing a review surface may not do.
 */
export function useArtifactUrl(downloadUrl: string | null): ArtifactLoad {
  const { token } = useSession()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce(value => value + 1), [])

  useEffect(() => {
    if (!downloadUrl || !token) return
    let cancelled = false
    let objectUrl: string | null = null
    setFailed(false)
    void (async () => {
      try {
        const response = await fetch(artifactHref(downloadUrl), { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) {
          if (!cancelled) setFailed(true)
          return
        }
        const next = URL.createObjectURL(await response.blob())
        if (cancelled) {
          URL.revokeObjectURL(next)
          return
        }
        objectUrl = next
        setUrl(next)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [downloadUrl, token, nonce])

  return { url, failed, reload }
}

/**
 * The in-place failure block. It sits where the artifact would have sat, so the row
 * keeps its meaning, and it carries its own retry — a load failure is not a reason
 * to send the user back to the panel header to find a refresh button.
 */
export function ArtifactLoadError({ onRetry, className }: { onRetry: () => void; className?: string }) {
  const { t } = useI18n()
  return (
    <div
      role="alert"
      className={cn(
        'border-destructive/40 bg-destructive/10 text-destructive-ink flex min-h-10 items-center gap-2 rounded border px-2 py-1 text-xs',
        className,
      )}
    >
      <AlertTriangleIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t('generations.loadFailed')}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive-ink ml-auto h-6 shrink-0 gap-1 px-1.5 text-xs"
        onClick={onRetry}
      >
        <RotateCwIcon />
        {t('common.retry')}
      </Button>
    </div>
  )
}

interface ArtifactMediaProps {
  artifact: GenerationArtifact
  /** What the file is for — a shot title reads better in the alt text than an id. */
  label?: string
  /** Size belongs to the caller: a table cell and a shot card want different heights. */
  className?: string
  /** False for previews that live inside a clickable card: no controls, no zoom, no pointer capture. */
  interactive?: boolean
  /** Zoom-layer paging across sibling versions (image artifacts only). */
  zoomNav?: { prev(): void; next(): void }
  /**
   * The clip's real length, read off the media element. Most artifacts landed without a
   * duration in the database, so the player is the only witness left — callers that show a
   * duration must not render a dash while a file is actually playing.
   */
  onDurationMs?: (ms: number) => void
}

/**
 * One renderer for every artifact the console can show: picture, clip, voice, or a
 * download link for anything a browser will not play inline (the cue sheet).
 */
export function ArtifactMedia({ artifact, label, className, interactive = true, zoomNav, onDurationMs }: ArtifactMediaProps) {
  const { t } = useI18n()
  const { url: href, failed, reload } = useArtifactUrl(artifact.downloadUrl)
  const [zoomed, setZoomed] = useState(false)
  // A blob can arrive intact and still be refused by the element — wrong codec, truncated
  // file, Range rejection. That is a second failure layer, and it used to have no answer
  // at all: the player just sat there empty, which reads exactly like "still loading".
  const [rejected, setRejected] = useState(false)
  const alt = label ?? artifact.id

  useEffect(() => {
    setRejected(false)
  }, [href])

  const reportDuration = (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
    const seconds = event.currentTarget.duration
    if (Number.isFinite(seconds) && seconds > 0) onDurationMs?.(Math.round(seconds * 1000))
  }

  if (failed || rejected) {
    return (
      <ArtifactLoadError
        className={className}
        onRetry={() => {
          setRejected(false)
          reload()
        }}
      />
    )
  }
  if (!href) return <Skeleton className={cn('h-24 w-40 shrink-0', className)} />
  if (artifact.mimeType.startsWith('image/')) {
    return (
      <>
        {/* Previews are blob URLs fetched from the API origin, so next/image cannot optimize them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={href}
          alt={alt}
          loading="lazy"
          onError={() => setRejected(true)}
          onClick={interactive ? () => setZoomed(true) : undefined}
          className={cn('max-h-24 rounded border object-cover', interactive ? 'cursor-zoom-in' : 'pointer-events-none', className)}
        />
        {zoomed && (
          <ArtifactLightbox
            src={href}
            alt={alt}
            onClose={() => setZoomed(false)}
            onPrev={zoomNav?.prev}
            onNext={zoomNav?.next}
            caption={zoomNav ? alt : undefined}
          />
        )}
      </>
    )
  }
  if (artifact.mimeType.startsWith('video/')) {
    return (
      <video
        src={href}
        controls={interactive}
        preload="metadata"
        onLoadedMetadata={reportDuration}
        onError={() => setRejected(true)}
        aria-label={alt}
        className={cn('max-h-24 rounded border', !interactive && 'pointer-events-none', className)}
      />
    )
  }
  if (artifact.mimeType.startsWith('audio/')) {
    return (
      <audio
        src={href}
        controls
        preload="metadata"
        onLoadedMetadata={reportDuration}
        onError={() => setRejected(true)}
        aria-label={alt}
        className={cn('h-10 max-w-56', className)}
      />
    )
  }
  return (
    <a
      href={href}
      download
      className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
    >
      <DownloadIcon className="size-3.5" />
      {label ?? t('generations.download')}
    </a>
  )
}
