'use client'

import { useState } from 'react'
import { ArchiveIcon, PencilIcon, WorkflowIcon } from 'lucide-react'
import { isLiveStoryboard, toWorkflowStatus, type Asset, type Storyboard } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LineageBadge } from '@/components/lineage-badge'
import { ArtifactMedia } from '@/components/generations/artifact-media'

interface StoryboardCardProps {
  storyboard: Storyboard
  canWrite: boolean
  episodeAssets: Asset[]
  onBindAssets(storyboardId: string, assets: { assetId: string; role: string }[]): Promise<void>
  onEdit(): void
  onChangeStatus(): void
}

/**
 * A content-first storyboard: the full shot script, the source excerpt it came
 * from, and the generated first frame / video inline, rather than a one-line
 * row in a table. A superseded shot renders the same content as read-only history,
 * because the first frames and video it carries were paid for.
 */
export function StoryboardCard({ storyboard, canWrite, episodeAssets, onBindAssets, onEdit, onChangeStatus }: StoryboardCardProps) {
  const { t } = useI18n()
  const status = toWorkflowStatus(storyboard.status)
  const [savingAsset, setSavingAsset] = useState<string | null>(null)

  const superseded = !isLiveStoryboard(storyboard)
  const editable = canWrite && !superseded
  const links = storyboard.assets ?? []
  const boundIds = new Set(links.map(link => link.assetId))

  async function toggleAsset(assetId: string) {
    const next = boundIds.has(assetId)
      ? links.filter(link => link.assetId !== assetId)
      : [...links, { storyboardId: storyboard.id, assetId, role: 'appears' }]
    setSavingAsset(assetId)
    try {
      await onBindAssets(storyboard.id, next.map(link => ({ assetId: link.assetId, role: link.role })))
    } finally {
      setSavingAsset(null)
    }
  }

  return (
    <Card className={cn(superseded && 'border-dashed bg-muted/30 shadow-none')}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            #{storyboard.number}
          </Badge>
          <span className="text-base">{storyboard.title}</span>
          <StatusBadge status={status} label={t(`status.${status}`)} />
          {superseded && <SupersededBadge revision={storyboard.revision ?? 1} />}
          <LineageBadge taskId={storyboard.generationTaskId} />
          <span className="text-muted-foreground text-xs font-normal">{formatDuration(storyboard.durationMs)}</span>
        </CardTitle>
        {!superseded && (
          <CardAction>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={t('storyboards.editTitle')} disabled={!editable} onClick={onEdit}>
                <PencilIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t('storyboards.changeStatus')} onClick={onChangeStatus}>
                <WorkflowIcon />
              </Button>
            </div>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {(storyboard.firstFrame || storyboard.video) && (
          <div className="flex flex-wrap gap-3">
            {storyboard.firstFrame && (
              <ArtifactMedia
                artifact={storyboard.firstFrame}
                label={`${storyboard.title} · ${t('storyboards.firstFrame')}`}
                className="max-h-56 rounded-lg"
              />
            )}
            {storyboard.video && (
              <ArtifactMedia
                artifact={storyboard.video}
                label={`${storyboard.title} · ${t('storyboards.video')}`}
                className="max-h-56 rounded-lg"
              />
            )}
          </div>
        )}

        <div>
          <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.assets')}</p>
          {!editable ? (
            boundIds.size === 0 ? (
              <p className="text-muted-foreground text-xs">{t('storyboards.noAssets')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {links.map(link => {
                  const asset = episodeAssets.find(item => item.id === link.assetId)
                  return (
                    <Badge key={link.assetId} variant="secondary">
                      {asset ? `${translateEnum(t, 'assets.kind', asset.kind)} · ${asset.name}` : link.assetId}
                    </Badge>
                  )
                })}
              </div>
            )
          ) : episodeAssets.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('storyboards.noEpisodeAssets')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {episodeAssets.map(asset => {
                const bound = boundIds.has(asset.id)
                return (
                  <button
                    key={asset.id}
                    type="button"
                    aria-pressed={bound}
                    aria-label={`${translateEnum(t, 'assets.kind', asset.kind)} ${asset.name}`}
                    disabled={savingAsset !== null}
                    onClick={() => void toggleAsset(asset.id)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
                      bound
                        ? 'border-transparent bg-primary text-primary-foreground'
                        : 'border-dashed text-muted-foreground hover:bg-accent hover:text-foreground',
                      savingAsset === asset.id && 'opacity-60',
                    )}
                  >
                    {savingAsset === asset.id ? t('common.loading') : `${translateEnum(t, 'assets.kind', asset.kind)} · ${asset.name}`}
                  </button>
                )
              })}
              <span className="text-muted-foreground text-xs">{t('storyboards.assetsHint')}</span>
            </div>
          )}
        </div>

        <div>
          <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.description')}</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{storyboard.description}</p>
        </div>

        {storyboard.dialogue.trim() !== '' && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">{t('storyboards.dialogue')}</p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {storyboard.speaker && <span className="text-muted-foreground mr-1.5 font-medium">[{storyboard.speaker}]</span>}
              {storyboard.dialogue}
            </p>
            {/* The line is only half the story once it has been voiced: a human listens to
                what the model actually said before it reaches the master. */}
            {storyboard.voice && (
              <div className="mt-2">
                <ArtifactMedia artifact={storyboard.voice} label={`${storyboard.title} · ${t('generations.stage.AUDIO')}`} />
              </div>
            )}
          </div>
        )}

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

function SupersededBadge({ revision }: { revision: number }) {
  const { t } = useI18n()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          <Badge variant="outline" className="text-muted-foreground gap-1 font-normal">
            <ArchiveIcon />
            {t('storyboards.superseded')} · {t('storyboards.revision', { revision })}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('storyboards.supersededHint')}</TooltipContent>
    </Tooltip>
  )
}
