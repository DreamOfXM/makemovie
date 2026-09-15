'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { ImagesIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { ApiError, type Asset, type AssetVersion, type AssetsResponse } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton } from '@/components/permission'
import { LineageBadge } from '@/components/lineage-badge'
import { ArtifactMedia } from '@/components/generations/artifact-media'

/** Kinds the authoring form offers as presets; the API itself accepts free text. */
const assetKinds = ['character', 'prop', 'scene'] as const
type AssetKind = (typeof assetKinds)[number]

const EMPTY: AssetsResponse = { assets: [] }

/** Asset rows carry the SCREAMING workflow enum; StatusBadge speaks lowercase tones. */
function toneFor(status: string): string {
  return status.toLowerCase()
}

interface AssetsPanelProps {
  episodeId: string | null
}

export function AssetsPanel({ episodeId }: AssetsPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()

  const [kind, setKind] = useState<AssetKind>('character')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // Identifies the single row mutation in flight, e.g. `approve-asset-<id>-2`.
  const [busy, setBusy] = useState<string | null>(null)

  const loadAssets = useCallback(
    () =>
      episodeId
        ? api<AssetsResponse>(`/episodes/${episodeId}/assets`)
        : Promise.resolve<AssetsResponse>(EMPTY),
    // organizationId is not in the path but scopes the session token behind `api`.
    [api, episodeId, organizationId],
  )
  const assets = useAsync<AssetsResponse>(loadAssets, EMPTY)
  const { reload } = assets

  async function create() {
    if (!episodeId) return
    setCreating(true)
    setCreateError(null)
    try {
      await api<{ asset: Asset }>(`/episodes/${episodeId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ kind, name, description }),
      })
      toast.success(t('assets.created', { name }))
      setName('')
      setDescription('')
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'assets:duplicate') {
        setCreateError(t('assets.duplicateError'))
      } else {
        setCreateError(error instanceof Error ? error.message : t('error.generic'))
      }
    } finally {
      setCreating(false)
    }
  }

  async function approve(asset: Asset, version: AssetVersion) {
    if (!episodeId) return
    setBusy(`approve-asset-${asset.id}-${version.version}`)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}/versions/${version.version}/approve`, {
        method: 'POST',
      })
      toast.success(t('assets.approved', { name: asset.name, version: version.version }))
      reload()
    } catch (error) {
      toast.error(friendlyError(error, t('assets.alreadyApproved'), 'assets:alreadyApproved'))
      reload()
    } finally {
      setBusy(null)
    }
  }

  function friendlyError(error: unknown, mapped: string, code: string): string {
    if (error instanceof ApiError && error.message === code) return mapped
    return error instanceof Error ? error.message : t('error.generic')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImagesIcon className="text-muted-foreground size-4" />
          {t('assets.title')}
        </CardTitle>
        <CardDescription>{t('assets.subtitle')}</CardDescription>
        {episodeId && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={reload} disabled={assets.loading}>
              <RefreshCwIcon className={cn(assets.loading && 'animate-spin')} />
              {t('common.refresh')}
            </Button>
          </CardAction>
        )}
      </CardHeader>

      {!episodeId ? (
        <CardContent>
          <EmptyState icon={<ImagesIcon />} title={t('assets.selectEpisode')} />
        </CardContent>
      ) : assets.error ? (
        <CardContent>
          <ErrorState message={assets.error} onRetry={reload} />
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          <div className="space-y-3 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">{t('assets.manualTitle')}</p>
              <p className="text-muted-foreground text-xs">{t('assets.manualHint')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Field label={t('assets.kindLabel')} htmlFor="assetKind">
                <Select value={kind} onValueChange={value => setKind(value as AssetKind)}>
                  <SelectTrigger id="assetKind" className="w-full" aria-label={t('assets.kindLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assetKinds.map(item => (
                      <SelectItem key={item} value={item}>
                        {translateEnum(t, 'assets.kind', item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('assets.nameLabel')} htmlFor="assetName" error={createError ?? undefined}>
                <Input
                  id="assetName"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder={t('assets.namePlaceholder')}
                  aria-invalid={createError !== null}
                />
              </Field>
            </div>
            <Field label={t('assets.descriptionLabel')} htmlFor="assetDescription">
              <Textarea
                id="assetDescription"
                rows={2}
                value={description}
                onChange={event => setDescription(event.target.value)}
                placeholder={t('assets.descriptionPlaceholder')}
              />
            </Field>
            <div className="flex justify-end">
              <GuardedButton
                action="episode:write"
                size="sm"
                disabled={creating || !name.trim() || !description.trim()}
                onClick={() => void create()}
              >
                <PlusIcon />
                {creating ? t('assets.creating') : t('assets.create')}
              </GuardedButton>
            </div>
          </div>

          {assets.loading && assets.data.assets.length === 0 ? (
            <TableSkeleton rows={2} columns={4} />
          ) : assets.data.assets.length === 0 ? (
            <EmptyState icon={<ImagesIcon />} title={t('assets.noAssets')} description={t('assets.noAssetsHint')} />
          ) : (
            assets.data.assets.map(asset => (
              <AssetCard key={asset.id} asset={asset} busy={busy} onApprove={approve} />
            ))
          )}
        </CardContent>
      )}
    </Card>
  )
}

interface AssetCardProps {
  asset: Asset
  busy: string | null
  onApprove(asset: Asset, version: AssetVersion): Promise<void>
}

function AssetCard({ asset, busy, onApprove }: AssetCardProps) {
  const { t } = useI18n()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{translateEnum(t, 'assets.kind', asset.kind)}</Badge>
          {asset.name}
          <StatusBadge status={toneFor(asset.status)} label={t(`status.${toneFor(asset.status)}`)} />
          <LineageBadge taskId={asset.generationTaskId} />
        </CardTitle>
        <CardDescription>{t('assets.versions', { count: asset.versions.length })}</CardDescription>
      </CardHeader>
      {asset.versions.length > 0 && (
        <CardContent className="space-y-3 px-4">
          {asset.versions.map(version => {
            const busyKey = `approve-asset-${asset.id}-${version.version}`
            return (
              <div key={version.id} className="flex flex-wrap items-start gap-3 rounded-lg border p-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">v{version.version}</span>
                    <StatusBadge
                      status={toneFor(version.status)}
                      label={t(`status.${toneFor(version.status)}`)}
                    />
                  </div>
                  {version.description && <p className="text-muted-foreground text-xs">{version.description}</p>}
                  {version.artifact && (
                    <ArtifactMedia artifact={version.artifact} label={`${asset.name} · v${version.version}`} />
                  )}
                </div>
                {version.status !== 'APPROVED' && (
                  <GuardedButton
                    action="episode:write"
                    variant="ghost"
                    size="sm"
                    disabled={busy === busyKey}
                    onClick={() => void onApprove(asset, version)}
                  >
                    {busy === busyKey ? t('assets.approving') : t('assets.approve')}
                  </GuardedButton>
                )}
              </div>
            )
          })}
        </CardContent>
      )}
    </Card>
  )
}
