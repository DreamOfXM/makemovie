'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangleIcon, CheckCircle2Icon, ImageIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react'
import type { Asset, AssetVersion } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'
import { useSession } from '@/lib/session'
import { usePermission } from '@/components/permission'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useArtifactUrl } from '@/components/generations/artifact-media'

const KIND_ORDER = ['character', 'scene', 'prop'] as const

/**
 * 制作台左列 · 素材页签：纯清单。行=选择——中列跟着开档案编辑（描述勘误），
 * 右列跟着开参考图检查（大图/版本/批准/重跑）。「一行一档」的档不再挤在
 * 18.5rem 的展开条里；缩略图保持 pointer-events-none，点击整行去选中。
 */
export function AssetList({
  episodeId,
  assets,
  loading,
  selectedId,
  onSelect,
  onAdded,
}: {
  episodeId: string
  assets: Asset[]
  loading: boolean
  selectedId: string | null
  onSelect(assetId: string): void
  /** 新建素材落地后让容器重读素材与镜头板（门禁/待办跟着变）。 */
  onAdded(): void
}) {
  const { t } = useI18n()
  const { can } = usePermission()
  const [addOpen, setAddOpen] = useState(false)

  const byKind = KIND_ORDER.map(kind => ({ kind, items: assets.filter(asset => asset.kind === kind) }))

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
            // 接口按版本号倒序返回，[0] 才是最新一版——行缩略图要跟着最新走。
            const latest = asset.versions[0] ?? null
            const approved = asset.status === 'APPROVED'
            const selected = selectedId === asset.id
            return (
              <button
                key={asset.id}
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(asset.id)}
                className={cn(
                  'mb-0.5 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                  selected ? 'border-primary/45 bg-primary/10' : 'border-transparent hover:bg-accent',
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
                    {asset.run?.status === 'FAILED' && asset.status !== 'APPROVED' && (
                      <span className="text-destructive-ink"> · {t('workbench.assetFailed')}</span>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
          {items.length === 0 && (
            <p className="text-muted-foreground px-3 py-2 text-[11.5px]">{t('assets.groupEmpty')}</p>
          )}
        </div>
      ))}

      {loading && assets.length === 0 && (
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
        onDone={onAdded}
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
