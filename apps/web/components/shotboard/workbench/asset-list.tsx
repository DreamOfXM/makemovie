'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangleIcon, CheckCircle2Icon, ChevronDownIcon, ImageIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react'
import type { Asset, AssetsResponse, AssetVersion } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia, useArtifactUrl } from '@/components/generations/artifact-media'

const KIND_ORDER = ['character', 'scene', 'prop'] as const

/**
 * 制作台左列 · 素材页签：角色/场景/道具一行一档的紧凑读法。
 * 审批/重跑参考图就地完成；完整管理（描述勘误、版本废弃删除）仍在流程页素材区——
 * 这里只回答「这集有什么素材、定没定稿、卡没卡首帧」。
 */
export function AssetList({
  episodeId,
  focusAssetId,
  onFocusHandled,
  onChanged,
}: {
  episodeId: string
  /** 编辑器点绑定 chip 跳过来时展开这个素材。 */
  focusAssetId: string | null
  onFocusHandled(): void
  onChanged(): void
}) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(() => api<AssetsResponse>(`/episodes/${episodeId}/assets`), [api, episodeId])
  const assets = useAsync<AssetsResponse>(load, { assets: [] })

  useEffect(() => {
    if (focusAssetId) {
      setExpandedId(focusAssetId)
      onFocusHandled()
    }
  }, [focusAssetId, onFocusHandled])

  async function approve(asset: Asset, version: AssetVersion) {
    setBusy(`approve-${asset.id}-${version.version}`)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}/versions/${version.version}/approve`, { method: 'POST' })
      toast.success(t('assets.approved', { name: asset.name, version: version.version }))
      assets.reload()
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  /** 与流程页素材区同一语义：0 版本=首次生成（不重烧），有版本=重跑加一版。 */
  async function regenerate(asset: Asset, note?: string) {
    setBusy(`regen-${asset.id}`)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({
          stage: 'ASSET',
          assetIds: [asset.id],
          ...(asset.versions.length > 0 ? { regenerate: true } : {}),
          promptNote: note?.trim() || undefined,
        }),
      })
      toast.success(t(asset.versions.length > 0 ? 'assets.regenerated' : 'assets.generated', { name: asset.name }))
      assets.reload()
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  const byKind = KIND_ORDER.map(kind => ({ kind, items: assets.data.assets.filter(asset => asset.kind === kind) }))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
      {byKind.map(({ kind, items }) => (
        <div key={kind}>
          <p className="text-subtle-foreground flex items-center gap-2 px-2 pb-1 pt-3 text-[11.5px] font-semibold">
            {t(`assets.kind.${kind}`)}
            <span className="font-normal">
              · {t('workbench.assetApproved', { done: items.filter(asset => asset.status === 'APPROVED').length, total: items.length })}
            </span>
          </p>
          {items.map(asset => {
            const latest = asset.versions[asset.versions.length - 1] ?? null
            const approved = asset.status === 'APPROVED'
            const expanded = expandedId === asset.id
            return (
              <div key={asset.id} className="mb-0.5">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : asset.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                    expanded ? 'border-primary/45 bg-primary/10' : 'border-transparent hover:bg-accent',
                  )}
                >
                  <AssetThumb version={latest} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{asset.name}</span>
                      {approved ? (
                        <Badge variant="success" className="h-4 px-1.5 text-[10.5px] font-normal">
                          <CheckCircle2Icon className="size-3" />
                          {t('screening.approved')}
                        </Badge>
                      ) : (
                        <Badge variant="warning" className="h-4 px-1.5 text-[10.5px] font-normal">{t('screening.pending')}</Badge>
                      )}
                    </span>
                    <span className="text-subtle-foreground mt-0.5 block truncate text-[11px]">
                      {t('workbench.assetUsage', { count: asset.usageCount ?? 0, versions: asset.versions.length })}
                      {asset.run && asset.run.status !== 'FAILED' && (
                        <span className="text-primary"> · {t('workbench.assetRunning')}</span>
                      )}
                      {asset.run?.status === 'FAILED' && (
                        <span className="text-destructive-ink"> · {t('workbench.assetFailed')}</span>
                      )}
                    </span>
                  </span>
                  <ChevronDownIcon className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform', expanded && 'rotate-180')} />
                </button>

                {expanded && (
                  <div className="border-border/60 mx-2 mb-1 mt-1 rounded-lg border bg-card px-2.5 py-2">
                    {asset.versions.length === 0 && (
                      <p className="text-muted-foreground text-[11.5px]">{t('workbench.assetNoVersions')}</p>
                    )}
                    {asset.versions.slice().reverse().map(version => (
                        <div key={version.version} className="flex items-center gap-2.5 py-1.5">
                          <div className="w-20 shrink-0">
                            {version.artifact ? (
                              <ArtifactMedia artifact={version.artifact} label={`v${version.version}`} interactive={false} className="h-12 w-full rounded" />
                            ) : (
                              <div className="border-border/60 flex h-12 w-full items-center justify-center rounded border border-dashed">
                                <ImageIcon className="text-muted-foreground size-3.5" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-xs font-medium">
                              v{version.version}
                              {version.status === 'APPROVED' ? (
                                <Badge variant="success" className="h-4 px-1.5 text-[10px] font-normal">{t('screening.approved')}</Badge>
                              ) : version.status === 'DEPRECATED' ? (
                                <Badge variant="muted" className="h-4 px-1.5 text-[10px] font-normal">{t('workbench.assetDeprecated')}</Badge>
                              ) : (
                                <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">{t('storyboards.statusDraft')}</Badge>
                              )}
                            </p>
                          </div>
                          {can('episode:write') && version.status !== 'APPROVED' && version.status !== 'DEPRECATED' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={busy !== null}
                              onClick={() => void approve(asset, version)}
                            >
                              {busy === `approve-${asset.id}-${version.version}` ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
                              {t('assets.approve')}
                            </Button>
                          )}
                        </div>
                      ))}
                    {asset.run?.status === 'FAILED' && asset.run.error && (
                      <p className="text-destructive-ink mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed">
                        <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                        {asset.run.error}
                      </p>
                    )}
                    {can('episode:write') && (
                      <div className="mt-2 space-y-1.5">
                        <input
                          type="text"
                          value={noteDraft}
                          onChange={event => setNoteDraft(event.target.value)}
                          placeholder={t('workbench.notePlaceholder')}
                          aria-label={t('workbench.noteLabel')}
                          className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-xs"
                        />
                        {asset.versions.length > 0 ? (
                          <GuardedButton action="episode:write" variant="outline" size="sm" disabled={busy !== null} onClick={() => void regenerate(asset, noteDraft)}>
                            {busy === `regen-${asset.id}` ? <LoaderCircleIcon className="animate-spin" /> : <ImageIcon />}
                            {t('workbench.rerunReference')}
                          </GuardedButton>
                        ) : (
                          <GuardedButton action="episode:write" variant="outline" size="sm" disabled={busy !== null} onClick={() => void regenerate(asset, noteDraft)}>
                            {busy === `regen-${asset.id}` ? <LoaderCircleIcon className="animate-spin" /> : <ImageIcon />}
                            {t('workbench.generateReference')}
                          </GuardedButton>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {items.length === 0 && (
            <p className="text-muted-foreground px-3 py-2 text-[11.5px]">{t('assets.groupEmpty')}</p>
          )}
        </div>
      ))}

      {assets.loading && assets.data.assets.length === 0 && (
        <div className="space-y-2 p-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {can('episode:write') && (
        <div className="px-1 pt-2 pb-1">
          <Button variant="outline" size="sm" className="w-full" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            {t('assets.addManual')}
          </Button>
        </div>
      )}

      <AddAssetDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        episodeId={episodeId}
        onDone={() => {
          assets.reload()
          onChanged()
        }}
      />
    </div>
  )
}

function AssetThumb({ version }: { version: AssetVersion | null }) {
  const { t } = useI18n()
  const { url, failed, reload } = useArtifactUrl(version?.artifact ? version.artifact.downloadUrl : null)
  if (!version || !version.artifact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="border-border flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed">
            <ImageIcon className="text-muted-foreground size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('screening.noPhoto')}</TooltipContent>
      </Tooltip>
    )
  }
  if (failed) {
    return (
      <button
        type="button"
        aria-label={t('generations.loadFailed')}
        onClick={reload}
        className="flex size-9 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10"
      >
        <AlertTriangleIcon className="text-destructive-ink size-3.5" />
      </button>
    )
  }
  if (!url) return <Skeleton className="size-9 shrink-0 rounded-md" />
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={`v${version.version}`} loading="lazy" className="size-9 shrink-0 rounded-md border object-cover" />
}

function AddAssetDialog({
  open,
  onOpenChange,
  episodeId,
  onDone,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  episodeId: string
  onDone(): void
}) {
  const { t } = useI18n()
  const { api } = useSession()
  const [kind, setKind] = useState('character')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError('')
    try {
      await api(`/episodes/${episodeId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ kind, name: name.trim(), description: description.trim() || undefined }),
      })
      toast.success(t('assets.created', { name: name.trim() }))
      setName('')
      setDescription('')
      onOpenChange(false)
      onDone()
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('assets.manualTitle')}</DialogTitle>
          <DialogDescription>{t('assets.manualHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('workbench.assetKind')} htmlFor="assetKind" required>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="assetKind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_ORDER.map(item => (
                  <SelectItem key={item} value={item}>{t(`assets.kind.${item}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('workbench.assetName')} htmlFor="assetName" required error={error}>
            <Input id="assetName" value={name} onChange={event => setName(event.target.value)} required />
          </Field>
          <Field label={t('workbench.assetDescription')} htmlFor="assetDescription" hint={t('workbench.assetDescriptionHint')}>
            <Textarea id="assetDescription" rows={3} value={description} onChange={event => setDescription(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <LoaderCircleIcon className="animate-spin" />}
              {t('assets.addManual')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
