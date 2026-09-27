'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2Icon, ClapperboardIcon, LoaderCircleIcon, SaveIcon } from 'lucide-react'
import type { Asset } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { Badge } from '@/components/ui/badge'
import { HelpHint } from '@/components/ui/help-hint'
import { Textarea } from '@/components/ui/textarea'
import { GuardedButton } from '@/components/permission'

interface AssetEditorProps {
  episodeId: string
  asset: Asset
  /** 板上活绑定这一素材的镜头（编号+标题），点击跳回镜头页签那一镜。 */
  usages: { id: string; number: number; title: string }[]
  canWrite: boolean
  onOpenShot(shotId: string): void
  onSaved(): void
}

/**
 * 制作台右列 · 素材档案编辑（勘误低频，窄列够用）。后端契约只有描述可改——
 * 名字与种类是身份与唯一键，改它们等于换一个素材；而 AI 提取的描述出过错
 * （性别、年龄写反），这里就是用户纠正档案的入口，改完重跑参考图即生效。
 */
export function AssetEditor({ episodeId, asset, usages, canWrite, onOpenShot, onSaved }: AssetEditorProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [form, setForm] = useState(asset.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 换素材即换稿：不携带上一个素材的草稿。
  useEffect(() => {
    setForm(asset.description)
    setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id])

  const dirty = form !== asset.description
  const approved = asset.status === 'APPROVED'

  async function save() {
    const next = form.trim()
    if (!next) return
    setBusy(true)
    setError('')
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: next }),
      })
      toast.success(t('workbench.assetSaved', { name: asset.name }))
      onSaved()
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {asset.name}
          <HelpHint text={t('workbench.assetIdentityHint')} />
        </h2>
        <Badge variant="muted" className="h-5 px-1.5 text-[11px] font-normal">{t(`assets.kind.${asset.kind}`)}</Badge>
        {approved ? (
          <Badge variant="success" className="h-5 px-1.5 text-[11px] font-normal">
            <CheckCircle2Icon className="size-3" />
            {t('screening.approved')}
          </Badge>
        ) : (
          <Badge variant="warning" className="h-5 px-1.5 text-[11px] font-normal">{t('screening.pending')}</Badge>
        )}
        <span className="text-subtle-foreground text-xs tabular-nums">
          {t('workbench.assetUsage', { count: asset.usageCount ?? 0, versions: asset.versions.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div>
          <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            {t('workbench.appearancesLabel')}
            <HelpHint text={t('workbench.appearancesHint')} />
          </p>
          {usages.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {usages.map(shot => (
                <button
                  key={shot.id}
                  type="button"
                  onClick={() => onOpenShot(shot.id)}
                  className="bg-muted/30 hover:bg-accent inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1.5 text-xs"
                >
                  <ClapperboardIcon className="text-muted-foreground size-3" />
                  <span className="font-mono">#{shot.number}</span>
                  <span className="text-muted-foreground">{shot.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">{t('workbench.appearancesEmpty')}</span>
          )}
        </div>

        <label className="block">
          <span className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
            {t('workbench.assetDescription')}
            <HelpHint text={t('workbench.assetDescriptionHint')} />
          </span>
          <Textarea
            rows={6}
            value={form}
            disabled={!canWrite}
            onChange={event => setForm(event.target.value)}
          />
        </label>

        {error && <p className="text-destructive-ink text-xs">{error}</p>}
      </div>

      <div className="border-border/60 flex items-center gap-2 border-t px-4 py-2.5">
        {dirty && <span className="text-warning-ink text-[11px]">{t('workbench.dirty')}</span>}
        <div className="ml-auto flex items-center gap-2">
          {canWrite && (
            <GuardedButton action="episode:write" variant="outline" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
              {t('workbench.save')}
            </GuardedButton>
          )}
          {/* 只读访客也看得到档案，但没有可保存的东西——不放死按钮。 */}
          {!canWrite && <span className="text-subtle-foreground text-[11px]">{t('workbench.readonlyHint')}</span>}
        </div>
      </div>
    </div>
  )
}
