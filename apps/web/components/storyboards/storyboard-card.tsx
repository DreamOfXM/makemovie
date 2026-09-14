'use client'

import { useState } from 'react'
import { FilmIcon, PencilIcon, WorkflowIcon } from 'lucide-react'
import { toWorkflowStatus, type GenerationArtifact, type Storyboard } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { ArtifactLightbox } from '@/components/artifact-lightbox'
import { useArtifactUrl } from '@/components/generations/generations-panel'

interface StoryboardCardProps {
  storyboard: Storyboard
  canWrite: boolean
  onEdit(): void
  onChangeStatus(): void
}

/**
 * A content-first storyboard: the full shot script, the source excerpt it came
 * from, and the generated first frame / video inline, rather than a one-line
 * row in a table.
 */
export function StoryboardCard({ storyboard, canWrite, onEdit, onChangeStatus }: StoryboardCardProps) {
  const { t } = useI18n()
  const status = toWorkflowStatus(storyboard.status)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            #{storyboard.number}
          </Badge>
          <span className="text-base">{storyboard.title}</span>
          <StatusBadge status={status} label={t(`status.${status}`)} />
          <span className="text-muted-foreground text-xs font-normal">{formatDuration(storyboard.durationMs)}</span>
        </CardTitle>
        <CardAction>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t('storyboards.editTitle')} disabled={!canWrite} onClick={onEdit}>
              <PencilIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t('storyboards.changeStatus')} onClick={onChangeStatus}>
              <WorkflowIcon />
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {(storyboard.firstFrame || storyboard.video) && (
          <div className="flex flex-wrap gap-3">
            {storyboard.firstFrame && (
              <StoryboardMedia artifact={storyboard.firstFrame} label={`${storyboard.title} · ${t('storyboards.firstFrame')}`} />
            )}
            {storyboard.video && (
              <StoryboardMedia artifact={storyboard.video} label={`${storyboard.title} · ${t('storyboards.video')}`} />
            )}
          </div>
        )}

        <div>
          <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.description')}</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{storyboard.description}</p>
        </div>

        {storyboard.sourceExcerpt.trim() !== '' && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.sourceExcerpt')}</p>
            <blockquote className="border-muted-foreground/30 text-muted-foreground border-l-2 pl-3 text-sm italic">
              {storyboard.sourceExcerpt}
            </blockquote>
          </div>
        )}

        {(storyboard.continuityIn.trim() !== '' || storyboard.continuityOut.trim() !== '') && (
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {storyboard.continuityIn.trim() !== '' && (
              <span>
                {t('storyboards.continuityIn')}: {storyboard.continuityIn}
              </span>
            )}
            {storyboard.continuityOut.trim() !== '' && (
              <span>
                {t('storyboards.continuityOut')}: {storyboard.continuityOut}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StoryboardMedia({ artifact, label }: { artifact: GenerationArtifact; label: string }) {
  const href = useArtifactUrl(artifact.downloadUrl)
  const [zoomed, setZoomed] = useState(false)

  if (!href) return <Skeleton className="h-44 w-72 rounded-lg" />
  if (artifact.mimeType.startsWith('image/')) {
    return (
      <>
        {/* Previews are blob URLs from the API origin, so next/image cannot optimize them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={href}
          alt={label}
          loading="lazy"
          onClick={() => setZoomed(true)}
          className="max-h-56 cursor-zoom-in rounded-lg border object-cover"
        />
        {zoomed && <ArtifactLightbox src={href} alt={label} onClose={() => setZoomed(false)} />}
      </>
    )
  }
  if (artifact.mimeType.startsWith('video/')) {
    return <video src={href} controls preload="metadata" className="max-h-56 rounded-lg border" />
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
      <FilmIcon className="size-3.5" />
      {label}
    </span>
  )
}
