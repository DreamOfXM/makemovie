'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDownIcon, ChevronRightIcon, ImagesIcon, LoaderCircleIcon, MapPinIcon, PackageIcon, PencilIcon, PlusIcon, RefreshCwIcon, SparklesIcon, Trash2Icon, UserIcon } from 'lucide-react'
import { ApiError, type Asset, type AssetVersion, type AssetsResponse, type GenerationArtifact } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpHint } from '@/components/ui/help-hint'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { StatusBadge } from '@/components/ui/status-badge'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { LineageBadge } from '@/components/lineage-badge'
import { ArtifactMedia } from '@/components/generations/artifact-media'

/** Kinds the authoring form offers as presets; the API itself accepts free text. */
const assetKinds = ['character', 'prop', 'scene'] as const
type AssetKind = (typeof assetKinds)[number]

const EMPTY: AssetsResponse = { assets: [] }

function latestVersionOf(asset: Asset): AssetVersion | undefined {
  return asset.versions.reduce<AssetVersion | undefined>((max, version) => (!max || version.version > max.version ? version : max), undefined)
}

/** Asset rows carry the SCREAMING workflow enum; StatusBadge speaks lowercase tones. */
function toneFor(status: string): string {
  return status.toLowerCase()
}

interface AssetsPanelProps {
  episodeId: string | null
  projectId: string | null
}

export function AssetsPanel({ episodeId, projectId }: AssetsPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  // 本集素材是每集的工作视图;全局库是项目级的身份档案(角色中台),两者切换查看。
  const [view, setView] = useState<'episode' | 'library'>('episode')

  const [kind, setKind] = useState<AssetKind>('character')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // Manual asset entry is a rare, secondary action (AI extracts assets from the script),
  // so the form lives behind a button instead of squatting above the list.
  const [createOpen, setCreateOpen] = useState(false)
  const [regenDialog, setRegenDialog] = useState<{ asset: Asset } | null>(null)
  // 正在重生成的素材:卡片上显示"生成中"进度,新版本落库后清除。
  const [generatingAssetId, setGeneratingAssetId] = useState<string | null>(null)
  // 删除是危险操作,永远二次确认;区分"删版本"与"删整个素材"。
  const [deleteConfirm, setDeleteConfirm] = useState<
    { type: 'version'; asset: Asset; version: AssetVersion } | { type: 'asset'; asset: Asset } | null
  >(null)
  const [regenNote, setRegenNote] = useState('')
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<string>>(new Set())

  function toggleKind(kind: string) {
    setCollapsedKinds(current => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }
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
      setCreateOpen(false)
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

  async function approveGroup(kind: AssetKind) {
    if (!episodeId) return
    setBusy(`approve-all-${kind}`)
    try {
      // Approve the newest version of every asset in the group, skipping ones already signed off.
      for (const asset of assets.data.assets.filter(item => item.kind === kind)) {
        const latest = latestVersionOf(asset)
        if (!latest || latest.status === 'APPROVED') continue
        await api(`/episodes/${episodeId}/assets/${asset.id}/versions/${latest.version}/approve`, { method: 'POST' })
      }
      toast.success(t('assets.groupApproved'))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
      reload()
    } finally {
      setBusy(null)
    }
  }

  async function regenerateAsset(asset: Asset, note?: string) {
    if (!episodeId) return
    setBusy(`regen-asset-${asset.id}`)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'ASSET', regenerate: true, assetIds: [asset.id], promptNote: note?.trim() || undefined }),
      })
      toast.success(t('assets.regenerated', { name: asset.name }))
      setRegenDialog(null)
      setRegenNote('')
      // The request only queues the batch; the image takes 30-90s. Track it so the
      // asset card can show "generating" instead of silence.
      setGeneratingAssetId(asset.id)
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setBusy(null)
    }
  }

  // AI 提取的档案会写错(性别/年龄见过实错),描述是用户纠正的唯一入口——
  // 生成提示词与定妆照指令都读它,改完需要重生成定妆照才落到图上。
  async function editDescription(asset: Asset, description: string) {
    if (!episodeId) return
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description }),
      })
      toast.success(t('assets.descriptionSaved', { name: asset.name }))
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    }
  }

  // 废弃:已通过版本退回草稿,参考图解析不再选中它——宣布作废而不是删除,历史保留。
  async function deprecateVersion(asset: Asset, version: AssetVersion) {
    if (!episodeId) return
    setBusy(`dep-${asset.id}-${version.version}`)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}/versions/${version.version}/deprecate`, { method: 'POST' })
      toast.success(t('assets.versionDeprecated', { name: asset.name, version: version.version }))
      reload()
    } catch (error) {
      toast.error(friendlyError(error, t('assets.notApprovedError'), 'assets:notApproved'))
      reload()
    } finally {
      setBusy(null)
    }
  }

  function friendlyError(error: unknown, mapped: string, code: string): string {
    if (error instanceof ApiError && error.message === code) return mapped
    return error instanceof Error ? error.message : t('error.generic')
  }

  async function removeVersion(asset: Asset, version: AssetVersion) {
    if (!episodeId) return
    setBusy(`del-asset-${asset.id}-${version.version}`)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}/versions/${version.version}`, { method: 'DELETE' })
      toast.success(t('assets.versionDeleted'))
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'assets:versionApproved') toast.error(t('assets.versionApprovedError'))
      else if (error instanceof ApiError && error.message === 'assets:lastVersion') toast.error(t('assets.lastVersionError'))
      else toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setBusy(null)
      setDeleteConfirm(null)
    }
  }

  async function removeAsset(asset: Asset) {
    if (!episodeId) return
    setBusy(`del-asset-${asset.id}`)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}`, { method: 'DELETE' })
      toast.success(t('assets.deleted', { name: asset.name }))
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'assets:assetApproved') toast.error(t('assets.assetApprovedError'))
      else toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setBusy(null)
      setDeleteConfirm(null)
    }
  }

  // 重生成进行中:轮询素材列表,新版本落库(或批次失败)即结束进度并刷新。
  // 图片生成 30-90 秒,这段沉默必须可见,否则用户以为点了没反应。
  useEffect(() => {
    if (!generatingAssetId || !episodeId) return
    const startedVersions = assets.data.assets.find(asset => asset.id === generatingAssetId)?.versions.length ?? 0
    const timer = setInterval(() => {
      void api<{ assets: Asset[] }>(`/episodes/${episodeId}/assets`).then(result => {
        const current = result.assets.find(asset => asset.id === generatingAssetId)
        if (!current) return
        const batchFailed = current.versions.length === startedVersions && startedVersions > 0 && current.versions.every(v => v.status !== 'APPROVED') && false
        if (current.versions.length > startedVersions || batchFailed) {
          setGeneratingAssetId(null)
          reload()
        }
      }).catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [generatingAssetId, episodeId, assets.data, api, reload])

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
            <div className="flex items-center gap-2">
              {projectId && (
                <div className="flex items-center rounded-md border p-0.5">
                  {(['episode', 'library'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setView(mode)}
                      className={cn(
                        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                        (view === mode) || (mode === 'episode' && view !== 'library')
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {mode === 'episode' ? t('assets.viewEpisode') : t('assets.viewLibrary')}
                    </button>
                  ))}
                </div>
              )}
              {view === 'episode' && (
                <GuardedButton
                  action="episode:write"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCreateError(null)
                    setCreateOpen(true)
                  }}
                >
                  <PlusIcon />
                  {t('assets.addManual')}
                </GuardedButton>
              )}
              <Button variant="outline" size="sm" onClick={reload} disabled={assets.loading}>
                <RefreshCwIcon className={cn(assets.loading && 'animate-spin')} />
                {t('common.refresh')}
              </Button>
            </div>
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
      ) : view === 'library' && projectId ? (
        <CardContent>
          <ProjectLibraryView projectId={projectId} />
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          {assets.loading && assets.data.assets.length === 0 ? (
            <TableSkeleton rows={2} columns={4} />
          ) : assets.data.assets.length === 0 ? (
            <EmptyState icon={<ImagesIcon />} title={t('assets.noAssets')} description={t('assets.noAssetsHint')} />
          ) : (
            <div className="space-y-6">
              {(
                [
                  { kind: 'character' as const, icon: UserIcon },
                  { kind: 'prop' as const, icon: PackageIcon },
                  { kind: 'scene' as const, icon: MapPinIcon },
                ]
              ).map(group => {
                const items = assets.data.assets.filter(asset => asset.kind === group.kind)
                const collapsed = collapsedKinds.has(group.kind)
                const pending = items.filter(asset => latestVersionOf(asset)?.status !== 'APPROVED').length
                const GroupIcon = group.icon
                return (
                  <section key={group.kind} className="space-y-3">
                    <div className="flex items-center gap-2 border-b pb-2">
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-2 text-left"
                        onClick={() => toggleKind(group.kind)}
                        aria-expanded={!collapsed}
                      >
                        {collapsed ? <ChevronRightIcon className="text-muted-foreground size-4" /> : <ChevronDownIcon className="text-muted-foreground size-4" />}
                        <GroupIcon className="text-muted-foreground size-4" />
                        <h3 className="text-sm font-semibold">{translateEnum(t, 'assets.kind', group.kind)}</h3>
                        <Badge variant="muted">{items.length}</Badge>
                        {items.length > 0 && (
                          <Badge variant={pending === 0 ? 'secondary' : 'outline'} className="font-normal">
                            {t('assets.approvedGroup', { approved: items.length - pending, total: items.length })}
                          </Badge>
                        )}
                      </button>
                      {items.length > 0 && pending > 0 && (
                        <div className="flex items-center gap-1.5">
                          <GuardedButton
                            action="episode:write"
                            variant="outline"
                            size="sm"
                            disabled={busy === `approve-all-${group.kind}`}
                            onClick={() => void approveGroup(group.kind)}
                          >
                            {busy === `approve-all-${group.kind}` ? t('common.loading') : t('assets.approveAll')}
                          </GuardedButton>
                          <HelpHint text={t('assets.approveAllHint')} />
                        </div>
                      )}
                    </div>
                    {!collapsed && (items.length === 0 ? (
                      <p className="text-muted-foreground text-sm">{t('assets.groupEmpty')}</p>
                    ) : (
                      items.map(asset => (
                        <AssetCard
                          key={asset.id}
                          asset={asset}
                          busy={busy}
                          generating={generatingAssetId === asset.id}
                          onApprove={approve}
                          onRemoveVersion={(a, v) => setDeleteConfirm({ type: 'version', asset: a, version: v })}
                          onRemove={a => setDeleteConfirm({ type: 'asset', asset: a })}
                          onRegenerate={can('episode:write') && generatingAssetId !== asset.id ? () => { setRegenNote(''); setRegenDialog({ asset }) } : undefined}
                          onEditDescription={can('episode:write') ? editDescription : undefined}
                          onDeprecate={can('episode:write') ? deprecateVersion : undefined}
                        />
                      ))
                    ))}
                  </section>
                )
              })}
            </div>
          )}

          <Dialog open={createOpen} onOpenChange={open => { setCreateOpen(open); if (!open) setCreateError(null) }}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t('assets.manualTitle')}</DialogTitle>
                <DialogDescription>{t('assets.manualHint')}</DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={event => {
                  event.preventDefault()
                  void create()
                }}
              >
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
                      autoFocus
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
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={creating || !name.trim() || !description.trim()}>
                    {creating ? t('assets.creating') : t('assets.create')}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={regenDialog !== null} onOpenChange={open => { if (!open) setRegenDialog(null) }}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{t('assets.regenTitle')}</DialogTitle>
                <DialogDescription>{t('assets.regenHint')}</DialogDescription>
              </DialogHeader>
              <Field label={t('assets.regenNoteLabel')} htmlFor="regenNote">
                <Textarea
                  id="regenNote"
                  rows={3}
                  value={regenNote}
                  onChange={event => setRegenNote(event.target.value)}
                  placeholder={t('assets.regenNotePlaceholder')}
                />
              </Field>
              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setRegenDialog(null)} disabled={busy !== null}>
                  {t('common.cancel')}
                </Button>
                <GuardedButton
                  action="episode:write"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => { if (regenDialog) void regenerateAsset(regenDialog.asset, regenNote) }}
                >
                  {busy === `regen-${regenDialog?.asset.id}` ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
                  {busy === `regen-${regenDialog?.asset.id}` ? t('assets.regenerating') : t('assets.regenerate')}
                </GuardedButton>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog open={deleteConfirm !== null} onOpenChange={open => !open && setDeleteConfirm(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {deleteConfirm?.type === 'version' ? t('assets.deleteVersionTitle') : t('assets.deleteAssetTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {deleteConfirm?.type === 'version'
                    ? t('assets.deleteVersionBody', { version: deleteConfirm.version.version, name: deleteConfirm.asset.name })
                    : t('assets.deleteAssetBody', { name: deleteConfirm?.asset.name ?? '' })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={event => {
                    event.preventDefault()
                    if (deleteConfirm?.type === 'version') void removeVersion(deleteConfirm.asset, deleteConfirm.version)
                    else if (deleteConfirm?.type === 'asset') void removeAsset(deleteConfirm.asset)
                  }}
                >
                  {t('sources.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      )}
    </Card>
  )
}

interface AssetCardProps {
  asset: Asset
  busy: string | null
  /** True while a regeneration batch for this asset is in flight. */
  generating?: boolean
  onApprove(asset: Asset, version: AssetVersion): Promise<void>
  onRemoveVersion(asset: Asset, version: AssetVersion): void
  onRemove(asset: Asset): void
  /** Present when the viewer may trigger generations: re-runs the AI for this asset alone. */
  onRegenerate?(): void
  /** AI 提取的描述会写错(性别/年龄),这是用户纠正档案的入口。 */
  onEditDescription?(asset: Asset, description: string): Promise<void>
  /** 废弃当前已通过版本:退回草稿,参考图解析不再选中它。 */
  onDeprecate?(asset: Asset, version: AssetVersion): Promise<void>
}

/**
 * 素材一行一档:折叠行只给"认得出+看得懂状态"的最小集——缩略图、名字、审批状态、
 * 使用中版本、被几镜引用;定稿/废弃/编辑描述/重生成这些动作全部收进展开抽屉,
 * 因为一次评审通常只需要扫完十行、点开一两个。
 */
function AssetCard({ asset, busy, generating, onApprove, onRemoveVersion, onRemove, onRegenerate, onEditDescription, onDeprecate }: AssetCardProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editText, setEditText] = useState('')
  const [savingDescription, setSavingDescription] = useState(false)
  const [deprecateConfirm, setDeprecateConfirm] = useState<AssetVersion | null>(null)

  // 使用中的版本 = 最新一个已通过版本(参考图解析同此规则);缩略图优先拿它。
  const effective = asset.versions.find(version => version.status === 'APPROVED')
  const newest = latestVersionOf(asset)
  const thumb = effective?.artifact ?? newest?.artifact ?? null
  const pendingVersions = asset.versions.filter(version => version.status !== 'APPROVED').length

  return (
    <div className={cn('rounded-lg border transition-colors', open && 'bg-muted/20')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="hover:bg-accent/60 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
        )}
        <span className="shrink-0">
          {thumb ? (
            <ArtifactMedia artifact={thumb} label={asset.name} className="h-10 w-10 rounded object-cover" />
          ) : (
            <span className="bg-muted flex size-10 items-center justify-center rounded">
              <ImagesIcon className="text-muted-foreground size-4" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{asset.name}</span>
        <StatusBadge status={toneFor(asset.status)} label={t(`status.${toneFor(asset.status)}`)} className="h-5 shrink-0 px-1.5 text-[11px]" />
        {generating ? (
          <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t('assets.generating')}
          </span>
        ) : (
          <span className="text-muted-foreground hidden shrink-0 items-center gap-2 text-xs sm:flex">
            {effective && <span className="font-mono">{t('assets.inUse')} v{effective.version}</span>}
            <span className="font-mono">{t('assets.versionsShort', { count: asset.versions.length })}</span>
            {(asset.usageCount ?? 0) > 0 && (
              <span title={t('assets.usageHint')}>{t('assets.usageCount', { count: asset.usageCount! })}</span>
            )}
            {asset.projectAssetId && (
              <Badge variant="outline" className="font-normal">
                {t('assets.libraryBadge')}
              </Badge>
            )}
            {pendingVersions > 0 && <Badge variant="secondary" className="font-normal">{t('assets.pendingVersions', { count: pendingVersions })}</Badge>}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {onEditDescription && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setEditText(asset.description); setEditOpen(true) }}
              >
                <PencilIcon />
                {t('assets.editDescription')}
              </Button>
            )}
            {onRegenerate && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy === `regen-asset-${asset.id}`}
                onClick={onRegenerate}
              >
                {busy === `regen-asset-${asset.id}` ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
                {busy === `regen-asset-${asset.id}` ? t('assets.regenerating') : t('assets.regenerate')}
              </Button>
            )}
            {onRegenerate && asset.status !== 'APPROVED' && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive ml-auto"
                disabled={busy === `del-asset-${asset.id}`}
                onClick={() => onRemove(asset)}
                title={t('sources.delete')}
              >
                <Trash2Icon />
                {t('sources.delete')}
              </Button>
            )}
            <LineageBadge taskId={asset.generationTaskId} />
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">{asset.description}</p>

          {asset.versions.length > 0 && (
            <div className="space-y-3">
              {asset.versions.map(version => {
                const busyKey = `approve-asset-${asset.id}-${version.version}`
                const inUse = version.id === effective?.id
                return (
                  <div key={version.id} className="flex flex-wrap items-start gap-3 rounded-lg border bg-card p-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">v{version.version}</span>
                        <StatusBadge
                          status={toneFor(version.status)}
                          label={t(`status.${toneFor(version.status)}`)}
                        />
                        {inUse && <Badge variant="secondary" title={t('assets.inUseHint')}>{t('assets.inUse')}</Badge>}
                      </div>
                      {version.description && (
                        <p className="text-muted-foreground text-xs">{version.description.replace(/^(character|prop|scene)\s+\S+?\s*[:：]\s*/, '')}</p>
                      )}
                      {version.artifact && (
                        <div className="relative inline-block">
                          <ArtifactMedia
                            artifact={version.artifact}
                            label={`${asset.name} · v${version.version}`}
                            className={generating ? 'blur-sm' : undefined}
                          />
                          {/* 玻璃遮罩:重新生成期间旧图毛玻璃化,新图落位即清晰替换。 */}
                          {generating && (
                            <div className="bg-background/50 absolute inset-0 flex items-center justify-center rounded-lg backdrop-blur-sm">
                              <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
                                <LoaderCircleIcon className="size-3.5 animate-spin" />
                                {t('assets.generating')}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {version.status !== 'APPROVED' && (
                      <>
                        <GuardedButton
                          action="episode:write"
                          variant="outline"
                          size="sm"
                          disabled={busy === busyKey}
                          onClick={() => void onApprove(asset, version)}
                        >
                          {busy === busyKey ? t('assets.approving') : t('assets.approve')}
                        </GuardedButton>
                        <HelpHint text={t('assets.approveHint')} />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={busy === `del-asset-${asset.id}-${version.version}`}
                          onClick={() => onRemoveVersion(asset, version)}
                          title={t('sources.delete')}
                        >
                          <Trash2Icon />
                        </Button>
                      </>
                    )}
                    {version.status === 'APPROVED' && onDeprecate && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={busy === `dep-${asset.id}-${version.version}`}
                        onClick={() => setDeprecateConfirm(version)}
                        title={t('assets.deprecateHint')}
                      >
                        {t('assets.deprecate')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={open => { setEditOpen(open); if (!open) setSavingDescription(false) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('assets.editDescription')}</DialogTitle>
            <DialogDescription>{t('assets.editDescriptionHint')}</DialogDescription>
          </DialogHeader>
          <Field label={t('assets.descriptionLabel')} htmlFor={`asset-desc-${asset.id}`}>
            <Textarea
              id={`asset-desc-${asset.id}`}
              value={editText}
              onChange={event => setEditText(event.target.value)}
              rows={5}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={savingDescription || !editText.trim()}
              onClick={async () => {
                if (!onEditDescription) return
                setSavingDescription(true)
                try {
                  await onEditDescription(asset, editText)
                  setEditOpen(false)
                } finally {
                  setSavingDescription(false)
                }
              }}
            >
              {savingDescription ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deprecateConfirm !== null} onOpenChange={open => { if (!open) setDeprecateConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assets.deprecateTitle', { version: deprecateConfirm?.version ?? 0 })}</AlertDialogTitle>
            <AlertDialogDescription>{t('assets.deprecateConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deprecateConfirm || !onDeprecate) return
                await onDeprecate(asset, deprecateConfirm)
                setDeprecateConfirm(null)
              }}
            >
              {t('assets.deprecate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface LibraryVersion {
  id: string
  version: number
  description: string
  status: string
  artifact: GenerationArtifact | null
}

interface LibraryAsset {
  id: string
  kind: string
  name: string
  description: string
  status: string
  archivedAt: string | null
  versions: LibraryVersion[]
}

const LIBRARY_KINDS = [
  { kind: 'character', icon: UserIcon },
  { kind: 'prop', icon: PackageIcon },
  { kind: 'scene', icon: MapPinIcon },
] as const

/** 全局资产库视图:项目级身份档案 + 定妆照,跨集复用的那一层。 */
function ProjectLibraryView({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const { api } = useSession()

  const loadLibrary = useCallback(
    () => api<{ assets: LibraryAsset[] }>(`/projects/${projectId}/project-assets`).then(result => result.assets),
    [projectId, api],
  )
  const library = useAsync<LibraryAsset[]>(loadLibrary, [])

  if (library.error) return <ErrorState message={library.error} onRetry={library.reload} />

  return (
    <div className="space-y-6">
      {library.loading && library.data.length === 0 ? (
        <TableSkeleton rows={2} columns={4} />
      ) : library.data.length === 0 ? (
        <EmptyState icon={<ImagesIcon />} title={t('assets.libraryEmpty')} description={t('assets.libraryEmptyHint')} />
      ) : (
        LIBRARY_KINDS.map(group => {
          const items = library.data.filter(asset => asset.kind === group.kind)
          return (
            <section key={group.kind} className="space-y-3">
              <div className="flex items-center gap-2 border-b pb-2">
                <group.icon className="text-muted-foreground size-4" />
                <h3 className="text-sm font-semibold">{translateEnum(t, 'assets.kind', group.kind)}</h3>
                <Badge variant="muted">{items.length}</Badge>
              </div>
              {items.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('assets.groupEmpty')}</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map(asset => {
                    const latest = [...asset.versions].sort((a, b) => b.version - a.version)[0]
                    return (
                      <div key={asset.id} className="flex gap-3 rounded-lg border p-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{asset.name}</p>
                          <p className="text-muted-foreground line-clamp-3 text-xs">{asset.description}</p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {t('assets.versions', { count: asset.versions.length })}
                          </p>
                        </div>
                        <div className="shrink-0 self-center">
                          {latest?.artifact ? (
                            <ArtifactMedia artifact={latest.artifact} label={asset.name} />
                          ) : (
                            <span className="bg-muted flex h-16 w-16 items-center justify-center rounded">
                              <ImagesIcon className="text-muted-foreground size-4" />
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
