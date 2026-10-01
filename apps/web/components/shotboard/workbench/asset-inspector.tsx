'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangleIcon, CheckCircle2Icon, ImageIcon, LoaderCircleIcon } from 'lucide-react'
import type { Asset, AssetVersion } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { assetFailureCopy } from '@/lib/failure-cause'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { HelpHint } from '@/components/ui/help-hint'
import { Button } from '@/components/ui/button'
import { GuardedButton, usePermission } from '@/components/permission'
import { ArtifactMedia } from '@/components/generations/artifact-media'
import { AssetVoiceTrack } from '@/components/assets/asset-voice-track'

/**
 * 制作台中列 · 素材检查器：审图是素材页签的主任务，宽列给图——左列选中谁，
 * 这里放大的就是谁的参考图。大图点击进 lightbox，←/→ 在版本间翻（审图要的是
 * 对比，不是开开关关）；批准/重跑/调整要求跟着图走。档案勘误住右列（低频，窄列够用）。
 */
export function AssetInspector({ episodeId, asset, onChanged }: { episodeId: string; asset: Asset; onChanged(): void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const canWrite = can('episode:write')
  const [busy, setBusy] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /** 手选的版本号；null=默认视图（已定稿版，否则最新一版有图的）。 */
  const [picked, setPicked] = useState<number | null>(null)

  const inflight = Boolean(asset.run && asset.run.status !== 'FAILED')
  const withArtifacts = asset.versions.filter(version => version.artifact)
  const current: AssetVersion | null = picked !== null
    ? asset.versions.find(version => version.version === picked) ?? null
    : asset.versions.find(version => version.status === 'APPROVED' && version.artifact)
      ?? withArtifacts[0]
      ?? asset.versions[0]
      ?? null

  // lightbox 只翻有图的版本；翻页同时驱动大图（picked），两处看的是同一版。
  const zoomIndex = current?.artifact ? withArtifacts.findIndex(version => version.version === current.version) : -1
  const zoomNav = withArtifacts.length > 1 && zoomIndex >= 0
    ? {
        prev: () => setPicked(withArtifacts[Math.max(0, zoomIndex - 1)].version),
        next: () => setPicked(withArtifacts[Math.min(withArtifacts.length - 1, zoomIndex + 1)].version),
      }
    : undefined

  async function approve(version: AssetVersion) {
    setBusy(`approve-${asset.id}-${version.version}`)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}/versions/${version.version}/approve`, { method: 'POST' })
      toast.success(t('assets.approved', { name: asset.name, version: version.version }))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  /** 与流程页素材区同一语义：0 版本=首次生成（不重烧），有版本=重跑加一版。 */
  async function regenerate() {
    setBusy(`regen-${asset.id}`)
    try {
      await api(`/episodes/${episodeId}/generations`, {
        method: 'POST',
        body: JSON.stringify({
          stage: 'ASSET',
          assetIds: [asset.id],
          ...(asset.versions.length > 0 ? { regenerate: true } : {}),
          promptNote: noteDraft.trim() || undefined,
        }),
      })
      toast.success(t(asset.versions.length > 0 ? 'assets.regenerated' : 'assets.generated', { name: asset.name }))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <p className="text-muted-foreground truncate text-xs font-medium">
          {asset.name} · {t('workbench.referenceReview')}
        </p>
        <span className="text-subtle-foreground ml-auto shrink-0 text-[11px] tabular-nums">
          {t('workbench.assetVersions', { count: asset.versions.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {/* 常驻大图：这一版定没定、脸对不对，在这里看，不在 36px 缩略图里猜。
            宽列里按高度取尺寸——竖版角色板受高约束、横版场景受宽约束，contain 都不吃亏。 */}
        <div className="bg-muted/30 flex h-72 shrink-0 items-center justify-center overflow-hidden rounded-lg border lg:h-80">
          {current?.artifact ? (
            <ArtifactMedia
              artifact={current.artifact}
              label={`v${current.version} · ${asset.name}`}
              className="h-full max-h-none w-full object-contain"
              zoomNav={zoomNav}
            />
          ) : inflight ? (
            <span className="text-primary flex flex-col items-center gap-1.5 text-xs">
              <LoaderCircleIcon className="size-5 animate-spin" />
              {t('generations.cellGenerating')}
            </span>
          ) : (
            <span className="text-muted-foreground flex flex-col items-center gap-1.5 px-4 text-center text-xs leading-snug">
              <ImageIcon className="size-5" />
              {t('workbench.assetNoVersions')}
            </span>
          )}
        </div>

        {/* 运行段反馈：任务态驱动，不靠按钮 busy——请求返回后格子照样要说话。 */}
        {inflight && (
          <p className="text-primary flex items-center gap-1.5 text-[11px]">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t('workbench.assetRunning')}
          </p>
        )}
        {/* 已定稿＝人已裁决，旧任务的失败信号退场——定稿版本才是现在的事实。 */}
        {asset.run?.status === 'FAILED' && asset.status !== 'APPROVED' && asset.run.error && (
          <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs">
            {/* 人话行说因去哪修（内容审查→改描述、额度→账上）；原文缩成小字留给排查。 */}
            <p className="text-destructive-ink flex items-start gap-1.5 leading-relaxed">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {assetFailureCopy(t, asset.run.error)}
            </p>
            <p className="text-faint-foreground mt-1.5 break-words">
              {t('shotboard.rawError')}: {asset.run.error}
            </p>
          </div>
        )}

        {/* 版本条：行=切换上图；批准就地。最新一版在最上。 */}
        {asset.versions.length > 0 && (
          <div className="space-y-1">
            <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              {t('workbench.selectVersionShort')}
              <HelpHint text={t('workbench.selectVersionHint')} />
            </p>
            {asset.versions.map(version => {
              const active = current?.version === version.version
              return (
                <div
                  key={version.version}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md border p-1.5',
                    active ? 'border-primary/45 bg-primary/5' : 'border-border/60',
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPicked(version.version)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span className="w-20 shrink-0">
                      {version.artifact ? (
                        <ArtifactMedia artifact={version.artifact} label={`v${version.version}`} interactive={false} className="h-12 w-full rounded" />
                      ) : (
                        <span className="border-border/60 flex h-12 w-full items-center justify-center rounded border border-dashed">
                          <ImageIcon className="text-muted-foreground size-3.5" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        v{version.version}
                        {version.status === 'APPROVED' ? (
                          <Badge variant="success" className="h-4 px-1.5 text-[10px] font-normal">
                            <CheckCircle2Icon className="size-3" />
                            {t('screening.approved')}
                          </Badge>
                        ) : version.status === 'DEPRECATED' ? (
                          <Badge variant="muted" className="h-4 px-1.5 text-[10px] font-normal">{t('workbench.assetDeprecated')}</Badge>
                        ) : (
                          <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">{t('status.draft')}</Badge>
                        )}
                      </span>
                    </span>
                  </button>
                  {canWrite && version.status !== 'APPROVED' && version.status !== 'DEPRECATED' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[11px]"
                      disabled={busy !== null}
                      onClick={() => void approve(version)}
                    >
                      {busy === `approve-${asset.id}-${version.version}` ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
                      {t('assets.approve')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 声音行（r10 音频体系）：角色卡的声音绑定入口。从视频提取/录音/导入。 */}
        {asset.kind === 'character' && (
          <AssetVoiceTrack asset={asset} episodeId={episodeId} onChanged={onChanged} />
        )}

        {/* 花钱动作全屏只此一枚（实心）：重跑/生成「参考图」。禁止无方向盲抽。 */}
        {can('generation:trigger') && (
          <div className="space-y-1.5">
            <input
              type="text"
              value={noteDraft}
              onChange={event => setNoteDraft(event.target.value)}
              placeholder={t('workbench.notePlaceholder')}
              aria-label={t('workbench.noteLabel')}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2.5 py-1.5 text-xs"
            />
            <GuardedButton
              action="generation:trigger"
              variant="default"
              size="sm"
              disabled={busy !== null}
              onClick={() => void regenerate()}
            >
              {busy === `regen-${asset.id}` ? <LoaderCircleIcon className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
              {asset.versions.length > 0 ? t('workbench.rerunReference') : t('workbench.generateReference')}
            </GuardedButton>
          </div>
        )}
      </div>
    </div>
  )
}
