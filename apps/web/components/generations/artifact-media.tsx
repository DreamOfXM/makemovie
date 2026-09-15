'use client'

import { useEffect, useState } from 'react'
import { DownloadIcon } from 'lucide-react'
import { artifactHref, type GenerationArtifact } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { ArtifactLightbox } from '@/components/artifact-lightbox'

/**
 * Media elements cannot send the bearer token, so artifacts are fetched with the
 * session header and exposed as revocable blob URLs.
 */
export function useArtifactUrl(downloadUrl: string | null): string | null {
  const { token } = useSession()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!downloadUrl || !token) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const response = await fetch(artifactHref(downloadUrl), { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) return
        const next = URL.createObjectURL(await response.blob())
        if (cancelled) {
          URL.revokeObjectURL(next)
          return
        }
        objectUrl = next
        setUrl(next)
      } catch {
        // A missing preview is not worth interrupting the console over.
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [downloadUrl, token])

  return url
}

interface ArtifactMediaProps {
  artifact: GenerationArtifact
  /** What the file is for — a shot title reads better in the alt text than an id. */
  label?: string
  /** Size belongs to the caller: a table cell and a shot card want different heights. */
  className?: string
}

/**
 * One renderer for every artifact the console can show: picture, clip, voice, or a
 * download link for anything a browser will not play inline (the cue sheet).
 */
export function ArtifactMedia({ artifact, label, className }: ArtifactMediaProps) {
  const { t } = useI18n()
  const href = useArtifactUrl(artifact.downloadUrl)
  const [zoomed, setZoomed] = useState(false)
  const alt = label ?? artifact.id

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
          onClick={() => setZoomed(true)}
          className={cn('max-h-24 cursor-zoom-in rounded border object-cover', className)}
        />
        {zoomed && <ArtifactLightbox src={href} alt={alt} onClose={() => setZoomed(false)} />}
      </>
    )
  }
  if (artifact.mimeType.startsWith('video/')) {
    return <video src={href} controls preload="metadata" aria-label={alt} className={cn('max-h-24 rounded border', className)} />
  }
  if (artifact.mimeType.startsWith('audio/')) {
    return <audio src={href} controls preload="metadata" aria-label={alt} className={cn('h-10 max-w-56', className)} />
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
