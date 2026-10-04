'use client'

import { useRef, useState } from 'react'
import { LoaderCircleIcon, MicIcon, UploadIcon } from 'lucide-react'
import type { Asset } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'

/**
 * 素材面板角色卡下方的"声音"行（r10 音频体系）。
 * 两态：已绑定（名称+解绑+试听）/ 空（录音/导入）。
 * 仅角色类型渲染——场景/道具没有声音。
 *
 * 导入 = 参考音频 + 它说了什么（transcript）。transcript 是克隆引擎的校准输入，
 * Voicebox 的样本端点把它列为必填；录音入口同样按这个契约走（浏览器 MediaRecorder
 * 产物直接喂上传端点）。
 */
export function AssetVoiceTrack({ asset, episodeId, onChanged }: { asset: Asset; episodeId: string; onChanged(): void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  // 选完文件先要 transcript：一步收集完再提交，不让上传请求缺校准文本。
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  if (asset.kind !== 'character') return null

  async function setVoice(artifactId: string | null) {
    setBusy(true)
    try {
      await api(`/episodes/${episodeId}/assets/${asset.id}/voice-bind`, {
        method: 'POST',
        body: JSON.stringify({ artifactId }),
      })
      onChanged()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function uploadVoice(file: File, spokenText: string) {
    setBusy(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('transcript', spokenText)
      await api(`/episodes/${episodeId}/assets/${asset.id}/voice-upload`, {
        method: 'POST',
        body: formData,
      })
      // voice-upload 落库即绑定，无需再调 voice-bind。
      setPendingFile(null)
      setTranscript('')
      onChanged()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function recordVoice() {
    setError(null)
    setRecording(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: BlobPart[] = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.start()
      // 录 8 秒参考样本：克隆引擎按短样本设计，长了反而稀释特征。
      await new Promise(resolve => setTimeout(resolve, 8000))
      recorder.stop()
      stream.getTracks().forEach(track => track.stop())
      const blob = await new Promise<Blob>(resolve => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
      })
      // 浏览器原生录音是我们自己的声音，transcript 由用户补；先进入同一确认步。
      setPendingFile(new File([blob], `recording-${Date.now()}.webm`, { type: blob.type }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRecording(false)
    }
  }

  return (
    <div className="border-border/60 mx-3 mb-2 rounded-lg border bg-background/50 px-3 py-2">
      <p className="text-muted-foreground mb-1.5 flex items-center gap-1 text-[10px] font-medium">
        <MicIcon className="size-3" />
        {t('assets.voiceTrack')}
      </p>
      {recording ? (
        <p className="text-primary flex items-center gap-1.5 text-[11px]">
          <span className="size-2 animate-pulse rounded-full bg-red-500" />
          {t('assets.voiceRecording', { seconds: 8 })}
        </p>
      ) : busy ? (
        <p className="text-primary flex items-center gap-1.5 text-[11px]">
          <LoaderCircleIcon className="size-3 animate-spin" />
          {t('assets.voiceUploading')}
        </p>
      ) : pendingFile ? (
        /* 选完文件/录完音的确认步：补 transcript 再提交 */
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium">{pendingFile.name}</p>
          <textarea
            value={transcript}
            onChange={event => setTranscript(event.target.value)}
            placeholder={t('assets.voiceTranscriptHint')}
            rows={2}
            className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[11px]"
          />
          <div className="flex gap-1">
            <Button variant="default" size="sm" className="h-6 flex-1 text-[10px]" disabled={transcript.trim() === ''} onClick={() => void uploadVoice(pendingFile, transcript.trim())}>
              {t('assets.voiceConfirmUpload')}
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setPendingFile(null); setTranscript('') }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
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
          {error ? <p className="text-destructive text-[10px]">{error}</p> : null}
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="h-6 flex-1 text-[10px]" disabled={busy} onClick={() => void recordVoice()}>
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
            accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0]
              if (file) {
                setError(null)
                setPendingFile(file)
              }
              event.target.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}
