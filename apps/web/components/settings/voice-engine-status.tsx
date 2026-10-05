'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2Icon, CloudIcon, DownloadIcon, LoaderCircleIcon, MicIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'

/**
 * 语音引擎状态条（r10 路径 2 的下载引导入口）。
 *
 * 按定稿触发矩阵渲染，只在语音相关表面出现（设置弹窗语音区、素材声音行）：
 *   - 内嵌引擎就绪 → 绿点，什么都不推
 *   - 安装中 → 进度（阶段+已下载量），轮询 install-status
 *   - Voicebox 在线（未装内嵌）→ 白嫖徽标，不推下载
 *   - 无引擎+系统达标 → 下载按钮（约 2.4GB，一次安装）
 *   - 无引擎+系统不达标 → 原因列表 + 云端降级说明，不给下载按钮
 */
interface Capability {
  embedded: { installed: boolean; installing: boolean; modelId: string | null; phase: string }
  voiceboxOnline: boolean
  localInference: { supported: boolean; memoryGB: number; diskFreeGB: number; chip: string; reasons: string[] }
  recommendation: 'embedded' | 'voicebox' | 'download' | 'cloud_only'
}

interface InstallState {
  phase: 'idle' | 'venv' | 'model' | 'done' | 'error'
  detail: string
  error: string | null
  running: boolean
}

export function VoiceEngineStatus({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n()
  const { api } = useSession()
  const [cap, setCap] = useState<Capability | null>(null)
  const [install, setInstall] = useState<InstallState | null>(null)
  const [starting, setStarting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const capability = await api<Capability>('/system/tts-capability')
      setCap(capability)
      if (capability.embedded.installing) {
        setInstall(await api<InstallState>('/system/tts-engine/install-status'))
      }
    } catch {
      setCap(null)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 安装中每 2.5s 轮询，直到 done/error。
  useEffect(() => {
    if (!cap?.embedded.installing) return
    const timer = setInterval(() => { void refresh() }, 2500)
    return () => clearInterval(timer)
  }, [cap?.embedded.installing, refresh])

  async function startInstall() {
    setStarting(true)
    try {
      await api('/system/tts-engine/install', { method: 'POST' })
      setInstall({ phase: 'venv', detail: '', error: null, running: true })
      await refresh()
    } catch (error) {
      setInstall({ phase: 'error', detail: '', error: String(error), running: false })
    } finally {
      setStarting(false)
    }
  }

  if (!cap) return null

  const line = 'flex items-center gap-1.5 text-[11px]'
  const dot = 'size-1.5 shrink-0 rounded-full'

  // 引擎就绪：绿灯，不打扰。
  if (cap.embedded.installed) {
    return (
      <p className={line}>
        <CheckCircle2Icon className="text-success-ink size-3.5 shrink-0" />
        {t('voiceEngine.ready')}
      </p>
    )
  }

  // 安装中：阶段进度。
  if (cap.embedded.installing && install) {
    return (
      <p className={line}>
        <LoaderCircleIcon className="text-primary size-3.5 shrink-0 animate-spin" />
        {install.phase === 'model' && install.detail ? install.detail : t(`voiceEngine.phase.${install.phase}`)}
        {install.error ? <span className="text-destructive">{install.error}</span> : null}
      </p>
    )
  }

  // Voicebox 在线（未装内嵌）：白嫖徽标，不推下载。
  if (cap.recommendation === 'voicebox') {
    return (
      <p className={line}>
        <MicIcon className="text-primary size-3.5 shrink-0" />
        {t('voiceEngine.voiceboxOnline')}
      </p>
    )
  }

  // 无引擎 + 系统达标：下载按钮（唯一推下载的场景）。
  if (cap.recommendation === 'download') {
    return (
      <div className="space-y-1.5">
        <p className={line}>
          <DownloadIcon className="text-muted-foreground size-3.5 shrink-0" />
          {t('voiceEngine.downloadHint')}
        </p>
        <Button variant="outline" size="sm" className="h-6 text-[10px]" disabled={starting} onClick={() => void startInstall()}>
          {starting && <LoaderCircleIcon className="size-3 animate-spin" />}
          {t('voiceEngine.downloadAction')}
        </Button>
      </div>
    )
  }

  // 无引擎 + 系统不达标：原因 + 云端降级，不给按钮。
  return (
    <div className="space-y-1">
      <p className={line}>
        <CloudIcon className="text-muted-foreground size-3.5 shrink-0" />
        {t('voiceEngine.cloudOnly')}
      </p>
      {!compact && cap.localInference.reasons.length > 0 ? (
        <ul className="text-subtle-foreground list-disc pl-5 text-[10px] leading-relaxed">
          {cap.localInference.reasons.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
    </div>
  )
}
