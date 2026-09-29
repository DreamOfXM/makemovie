'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, SaveIcon, WorkflowIcon } from 'lucide-react'
import type { Asset, ShotboardShot, Storyboard } from '@/lib/api'
import { toWorkflowStatus } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatDuration } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HelpHint } from '@/components/ui/help-hint'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/ui/status-badge'
import { GuardedButton } from '@/components/permission'

interface ShotEditorProps {
  shot: ShotboardShot
  episodeAssets: Asset[]
  canWrite: boolean
  onBindAssets(storyboardId: string, assets: { assetId: string; role: string }[]): Promise<void>
  /** 打开页面持有的状态流转弹窗（映射出 StatusDialog 需要的最小字段）。 */
  onChangeStatus(shot: Pick<Storyboard, 'id' | 'number' | 'title' | 'status'>): void
  /** 跳去流程页这一镜的上下文。 */
  onOpenShot(shotId: string): void
  /** 编辑器点绑定 chip → 左列切到素材页签并展开。 */
  onOpenAsset(assetId: string): void
  /** 保存成功后的外层刷新（镜头列表/轮询数据）。 */
  onSaved(): void
}

/**
 * 制作台中列 · 单镜编辑：字段与 PATCH 载荷一一对应（分镜没有"视频提示词"字段——
 * 提示词由 worker 用画面描述+绑定素材外观自动拼，方向控制走重跑时携带的调整要求）。
 */
export function ShotEditor({
  shot,
  episodeAssets,
  canWrite,
  onBindAssets,
  onChangeStatus,
  onOpenShot,
  onOpenAsset,
  onSaved,
}: ShotEditorProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [form, setForm] = useState(pickFields(shot))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savingAsset, setSavingAsset] = useState<string | null>(null)

  // 换镜即换稿：不跟随上一镜的草稿。
  useEffect(() => {
    setForm(pickFields(shot))
    setError('')
  }, [shot.id])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(pickFields(shot)), [form, shot])

  function field<K extends keyof ReturnType<typeof pickFields>>(key: K, value: ReturnType<typeof pickFields>[K]) {
    setForm(current => ({ ...current, [key]: value }))
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await api(`/storyboards/${shot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: form.title,
          durationMs: form.durationMs,
          description: form.description,
          dialogue: form.dialogue,
          speaker: form.speaker,
          sourceExcerpt: form.sourceExcerpt,
          continuityIn: form.continuityIn,
          continuityOut: form.continuityOut,
        }),
      })
      toast.success(t('workbench.shotSaved', { number: shot.number }))
      onSaved()
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  const boundIds = new Set(shot.assets.map(link => link.id))
  const status = toWorkflowStatus(shot.status)

  async function toggleAsset(assetId: string) {
    const next = boundIds.has(assetId)
      ? shot.assets.filter(link => link.id !== assetId).map(link => ({ assetId: link.id, role: link.role }))
      : [...shot.assets.map(link => ({ assetId: link.id, role: link.role })), { assetId, role: 'appears' }]
    setSavingAsset(assetId)
    try {
      await onBindAssets(shot.id, next)
    } finally {
      setSavingAsset(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="text-base font-semibold">
          <span className="text-muted-foreground font-mono text-sm">#{shot.number}</span> {shot.title}
        </h2>
        {/* r06·A：场次归属——本场首镜的钦定首帧是全场的画面基准（场景主帧）。 */}
        {shot.sceneNumber != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-subtle-foreground cursor-help rounded border px-1.5 py-0.5 text-[10.5px]">
                {t('workbench.sceneChip', { number: shot.sceneNumber })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('workbench.sceneChipHint')}</TooltipContent>
          </Tooltip>
        )}
        <StatusBadge status={status} label={t(`status.${status}`)} className="h-5 px-1.5 text-[11px]" />
        <span className="text-subtle-foreground text-xs tabular-nums">{formatDuration(shot.durationMs)}</span>
        <div className="ml-auto flex items-center gap-1">
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => onChangeStatus({ id: shot.id, number: shot.number, title: shot.title, status: shot.status as Storyboard['status'] })}>
              <WorkflowIcon />
              {t('storyboards.changeStatus')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenShot(shot.id)}>
            {t('shotboard.openInFlow')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div>
          <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            {t('storyboards.assets')}
            <HelpHint text={t('workbench.bindHint')} />
            {canWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="ml-auto h-6 text-[11px]">
                    {t('workbench.bindManage')}
                    <ChevronDownIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
                  <DropdownMenuLabel>{t('workbench.bindManage')}</DropdownMenuLabel>
                  {episodeAssets.length === 0 && (
                    <p className="text-muted-foreground px-2 py-1.5 text-xs">{t('storyboards.noEpisodeAssets')}</p>
                  )}
                  {episodeAssets.map(asset => {
                    const bound = boundIds.has(asset.id)
                    return (
                      <DropdownMenuItem
                        key={asset.id}
                        disabled={savingAsset !== null}
                        onClick={() => void toggleAsset(asset.id)}
                      >
                        {savingAsset === asset.id ? (
                          <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                          <span className={cn('flex size-4 items-center justify-center rounded border', bound ? 'bg-primary border-primary text-primary-foreground' : 'border-input')}>
                            {bound && <CheckIcon className="size-3" />}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                        <span className="text-muted-foreground text-[10.5px]">{t(`assets.kind.${asset.kind}`)}</span>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {shot.assets.map(link => (
              <button
                key={link.id}
                type="button"
                onClick={() => onOpenAsset(link.id)}
                className="bg-muted/30 hover:bg-accent inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1.5 text-xs"
              >
                <span className={cn('size-1.5 rounded-full', link.status === 'APPROVED' ? 'bg-success' : 'bg-warning')} />
                <span className="font-medium">{link.name}</span>
                <span className="text-muted-foreground">{t(`assets.kind.${link.kind}`)}</span>
                <span className="text-muted-foreground/70 text-[10.5px]">{link.status === 'APPROVED' ? t('screening.approved') : t('screening.pending')}</span>
              </button>
            ))}
            {shot.assets.length === 0 && (
              <span className="text-muted-foreground text-xs">{t('storyboards.noAssets')}</span>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_9rem]">
          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs font-medium">{t('storyboards.titleLabel')}</span>
            <Input value={form.title} disabled={!canWrite} onChange={event => field('title', event.target.value)} />
          </label>
          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs font-medium">{t('workbench.durationSec')}</span>
            <Input
              type="number"
              min={1}
              step={0.5}
              value={form.durationMs / 1000}
              disabled={!canWrite}
              onChange={event => field('durationMs', Math.max(1, Math.round(Number(event.target.value) * 1000)))}
            />
          </label>
          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs font-medium">{t('storyboards.speaker')}</span>
            <Input value={form.speaker} disabled={!canWrite} onChange={event => field('speaker', event.target.value)} />
          </label>
        </div>

        <label className="block">
          <span className="text-muted-foreground mb-1 flex items-center justify-between text-xs font-medium">
            <span>{t('storyboards.description')}</span>
            {/* 整集重跑分镜的入口曾只住在流程页，用户在制作台找不到（2026-09-29）。 */}
            <button type="button" onClick={() => onOpenShot(shot.id)} className="text-primary hover:underline inline-flex items-center gap-1 font-medium">
              {t('storyboards.rewriteAllHint')}
              <span aria-hidden>↗</span>
            </button>
          </span>
          <Textarea rows={3} value={form.description} disabled={!canWrite} onChange={event => field('description', event.target.value)} />
        </label>

        <label className="block">
          <span className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
            {t('storyboards.dialogue')}
            <HelpHint text={t('storyboards.dialogueHint')} />
          </span>
          <Textarea rows={2} value={form.dialogue} disabled={!canWrite} onChange={event => field('dialogue', event.target.value)} />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs font-medium">{t('storyboards.continuityIn')}</span>
            <Input value={form.continuityIn} disabled={!canWrite} onChange={event => field('continuityIn', event.target.value)} />
          </label>
          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs font-medium">{t('storyboards.continuityOut')}</span>
            <Input value={form.continuityOut} disabled={!canWrite} onChange={event => field('continuityOut', event.target.value)} />
          </label>
        </div>

        <details className="group border-border/60 rounded-md border px-3 py-2">
          <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium">
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
            {t('storyboards.sourceExcerpt')}
          </summary>
          <Textarea
            rows={2}
            className="mt-2"
            value={form.sourceExcerpt}
            disabled={!canWrite}
            onChange={event => field('sourceExcerpt', event.target.value)}
          />
        </details>

        {error && <p className="text-destructive-ink text-xs">{error}</p>}
      </div>

      <div className="border-border/60 flex items-center gap-2 border-t px-4 py-2.5">
        {dirty && <span className="text-warning-ink text-[11px]">{t('workbench.dirty')}</span>}
        <div className="ml-auto flex items-center gap-2">
          {canWrite && (
            <GuardedButton action="storyboard:write" variant="outline" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
              {t('workbench.save')}
            </GuardedButton>
          )}
        </div>
      </div>
    </div>
  )
}

function pickFields(shot: ShotboardShot) {
  return {
    title: shot.title,
    durationMs: shot.durationMs,
    description: shot.description,
    dialogue: shot.dialogue,
    speaker: shot.speaker ?? '',
    sourceExcerpt: shot.sourceExcerpt,
    continuityIn: shot.continuityIn,
    continuityOut: shot.continuityOut,
  }
}
