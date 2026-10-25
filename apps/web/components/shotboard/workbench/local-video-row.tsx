'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { LoaderCircleIcon, UploadIcon } from 'lucide-react'
import type { ShotboardShot } from '@/lib/api'
import { productionWord } from '@/lib/shot-verdict'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { HelpHint } from '@/components/ui/help-hint'
import { usePermission } from '@/components/permission'

/**
 * 手工制作镜（字卡 / 界面 / 屏幕录制 / 合成）的画面入口。
 *
 * 这四档镜头平台不排模型调用，此前界面上一个入口都没有：用户点进这一镜只看到
 * 「手工制作」的徽章和一句「没有导入画面的入口」，整集合成时后端直接抛缺片段。
 * 这里给两条真路——字卡由本机 ffmpeg 画出来，其余三档由人交一段视频，两者都
 * 上传即选中，走与模型片段完全相同的钦定/合成链路（三账上零计费单位）。
 */
export function LocalVideoRow({ shot, onChanged }: { shot: ShotboardShot; onChanged: () => void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const editable = can('storyboard:write')
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'render' | 'import' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // 默认沿用卡上已有的那句话。这里不能退回 shot.title：分镜表里的镜号（「镜头7」）是占位名，
  // 点一下「重新渲染」就把真文案覆盖成了镜号。没有已渲染的卡就留空，按钮随之禁用。
  const [text, setText] = useState(() =>
    shot.videoCandidates.find(candidate => candidate.selected && candidate.origin === 'local_render')?.cardText ?? '',
  )
  const isCard = shot.production === 'title-card'
  // 已有画面时动词要说清覆盖语义（全站口径：生成=补缺，重跑/替换=覆盖）。
  const hasPicture = shot.video !== null

  async function renderCard() {
    if (text.trim() === '') return
    setBusy('render')
    setFailed(null)
    try {
      await api(`/storyboards/${shot.id}/title-card`, { method: 'POST', body: JSON.stringify({ text: text.trim() }) })
      toast.success(t('localVideo.rendered'))
      onChanged()
    } catch (error) {
      setFailed(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function upload(file: File) {
    setBusy('import')
    setFailed(null)
    const body = new FormData()
    body.append('file', file)
    try {
      await api(`/storyboards/${shot.id}/video-import`, { method: 'POST', body })
      toast.success(t('localVideo.imported'))
      onChanged()
    } catch (error) {
      setFailed(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-border/60 mt-2 rounded-md border px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <p className="text-muted-foreground text-xs">{t('localVideo.title')}</p>
        <HelpHint
          text={
            isCard
              ? t('localVideo.cardHint')
              : shot.production === 'video'
                ? t('localVideo.importModelHint')
                : t('localVideo.importHint', { kind: productionWord(t, shot.production) })
          }
        />
      </div>

      {isCard ? (
        <>
          <textarea
            rows={2}
            value={text}
            disabled={!editable || busy !== null}
            placeholder={t('localVideo.textPlaceholder')}
            aria-label={t('localVideo.text')}
            onChange={event => setText(event.target.value)}
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full resize-y rounded-md border px-2 py-1.5 text-xs"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              className="h-7 text-[11px]"
              disabled={!editable || busy !== null || text.trim() === ''}
              onClick={() => void renderCard()}
            >
              {busy === 'render' ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
              {hasPicture ? t('localVideo.rerender') : t('localVideo.render')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              disabled={!editable || busy !== null}
              onClick={() => fileRef.current?.click()}
            >
              {busy === 'import' ? <LoaderCircleIcon className="size-3 animate-spin" /> : <UploadIcon className="size-3" />}
              {hasPicture ? t('localVideo.replace') : t('localVideo.import')}
            </Button>
            <span className="text-faint-foreground text-[11px]">{t('localVideo.localCostNote')}</span>
            <span className="text-faint-foreground text-[11px]">{t('localVideo.formatsNote')}</span>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="h-7 text-[11px]"
            disabled={!editable || busy !== null}
            onClick={() => fileRef.current?.click()}
          >
            {busy === 'import' ? <LoaderCircleIcon className="size-3 animate-spin" /> : <UploadIcon className="size-3" />}
            {hasPicture ? t('localVideo.replace') : t('localVideo.import')}
          </Button>
          <span className="text-faint-foreground text-[11px]">{t('localVideo.formatsNote')}</span>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file)
        }}
      />

      {failed && (
        <p className="border-destructive/30 bg-destructive/5 text-destructive-ink mt-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
          {failed}
        </p>
      )}
    </div>
  )
}
