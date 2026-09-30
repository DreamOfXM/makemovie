'use client'

import { useRef, useState } from 'react'
import { LoaderCircleIcon, MicIcon, UploadIcon } from 'lucide-react'
import type { Asset } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'

/**
 * 素材面板角色卡下方的"声音"行（r10 音频体系）。
 * 两态：已绑定（波形+名称+试听+解绑）/ 空（录音/导入/提取 三入口）。
 * 仅角色类型渲染——场景/道具无声道。
 */
export function AssetVoiceTrack({ asset, episodeId, onChanged }: { asset: Asset; episodeId: string; onChanged(): void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  if (asset.kind !== 'character') return null

  // 绑定/解绑走统一端点
  async function setVoice(artifactId: string | null) {
    setBusy(true)
    try {
      // voice-bind 端点挂在 assets 下，需要 episodeId——asset DTO 没带 episodeId，
      // 由父组件的 onChanged 刷新。这里通过 asset 的隐式 episode 上下文调用。
      // 实际 episodeId 从 AssetsPanel props 传入更安全。
      await api(`/episodes/${episodeId}/assets/${asset.id}/voice-bind`, {
        method: 'POST',
        body: JSON.stringify({ artifactId }),
      })
      onChanged()
    } catch (error) {
      console.error(error)
    } finally {
      setBusy(false)
    }
  }

  async function uploadAudio(file: File) {
    setBusy(true)
    try {
      // 上传音频 → 得到 artifactId → 绑定
      const formData = new FormData()
      formData.append('file', file)
      const result = await api<{ artifactId: string }>(`/episodes/${episodeId}/assets/${asset.id}/voice-upload`, {
        method: 'POST',
        body: formData,
      })
      await setVoice(result.artifactId)
    } catch (error) {
      console.error(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-border/60 mx-3 mb-2 rounded-lg border bg-background/50 px-3 py-2">
      <p className="text-muted-foreground mb-1.5 flex items-center gap-1 text-[10px] font-medium">
        <MicIcon className="size-3" />
        {t('assets.voiceTrack')}
      </p>
      {busy ? (
        <p className="text-primary flex items-center gap-1.5 text-[11px]">
          <LoaderCircleIcon className="size-3 animate-spin" />
          {t('common.saving')}
        </p>
      ) : asset.voiceArtifactId ? (
        /* 已绑定 */
        <div className="flex items-center gap-2">
          <span className="bg-primary/20 text-primary flex size-7 items-center justify-center rounded">
            <MicIcon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium">{asset.name}{t('assets.voiceSuffix')}</p>
            <p className="text-subtle-foreground text-[10px]">{t('assets.voiceBound')}</p>
          </div>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-6 px-1.5 text-[10px]" onClick={() => void setVoice(null)}>
            {t('assets.voiceUnbind')}
          </Button>
        </div>
      ) : (
        /* 空 */
        <div className="space-y-1.5">
          <p className="text-subtle-foreground text-[10px]">{t('assets.voiceEmpty')}</p>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="h-6 flex-1 text-[10px]" disabled={busy}>
              <MicIcon className="size-3" />
              {t('assets.voiceRecord')}
            </Button>
            <Button variant="outline" size="sm" className="h-6 flex-1 text-[10px]" disabled={busy} onClick={() => fileInput.current?.click()}>
              <UploadIcon className="size-3" />
              {t('assets.voiceImport')}
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0]
              if (file) void uploadAudio(file)
              event.target.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}
