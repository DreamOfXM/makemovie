'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { PauseIcon, PlayIcon } from 'lucide-react'
import { artifactHref, type GenerationArtifact } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { cn, formatDuration } from '@/lib/utils'
import { ArtifactMedia } from '@/components/generations/artifact-media'
import { Button } from '@/components/ui/button'


/**
 * 条数不写死：按轨道实际像素宽度定，一根条 3px + 2px 间距。
 * 写死 44 根是按 390px 手机最窄那档定的，搬到桌面 480px 轨道上就成了 9px 宽的砖墙。
 */
const BAR_PITCH = 5
const BAR_MIN = 24
const BAR_MAX = 200
/** 峰值只解一次码，按这个高分辨率抽；换宽度时从这里降采样，不重新 fetch/decode。 */
const PEAK_RES = 256

interface AudioWaveformProps {
  artifact: GenerationArtifact
  /**
   * 这一镜画面的长度。轨道总宽按 max(音频, 画面) 铺，于是「音频短于画面」画成尾巴上
   * 一段没有条的空档，「音频长于画面」画成越过刻度的条——两种不一致不读文字也看得见。
   */
  pictureMs?: number | null
  className?: string
}

/**
 * 音频的人工检阅面。`<audio controls>` 能证明文件在，证明不了声音落在画面的哪一段，
 * 而这一镜的字幕要不要改恰恰取决于此。解码失败（浏览器不认这个编码）就退回原生播放器，
 * 不假装画得出来。
 */
export function AudioWaveform({ artifact, pictureMs, className }: AudioWaveformProps) {
  const { t } = useI18n()
  const { token } = useSession()
  const audioRef = useRef<HTMLAudioElement>(null)
  const barsRef = useRef<HTMLDivElement>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [barCount, setBarCount] = useState(BAR_MIN)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [audioMs, setAudioMs] = useState<number | null>(artifact.durationMs)
  const [progressMs, setProgressMs] = useState(0)
  const [playing, setPlaying] = useState(false)

  // 一次下载同时喂解码和播放：分两次拉的话，同一个文件要在网络上走两遍。
  useEffect(() => {
    if (!token) return
    let cancelled = false
    let objectUrl: string | null = null
    setPeaks(null)
    setFailed(false)
    setProgressMs(0)
    setPlaying(false)
    void (async () => {
      try {
        const response = await fetch(artifactHref(artifact.downloadUrl), { headers: { authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const bytes = await response.arrayBuffer()
        if (cancelled) return
        // Blob 必须在 decodeAudioData 之前建：解码可能把这块 ArrayBuffer detach 掉，
        // 而且 type 不能省——空类型的 blob: 地址会被媒体元素按 Range 请求拒掉
        // （net::ERR_REQUEST_RANGE_NOT_SATISFIABLE → MEDIA_ELEMENT_ERROR 4），
        // 表现就是波形画得出来、点播放却没声音。
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: artifact.mimeType }))
        setSrc(objectUrl)
        const Ctor: typeof AudioContext = window.AudioContext
          ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctor()
        let decoded: AudioBuffer
        try {
          decoded = await ctx.decodeAudioData(bytes)
        } finally {
          void ctx.close()
        }
        if (cancelled) return
        setPeaks(extractPeaks(decoded.getChannelData(0), PEAK_RES))
        setAudioMs(Math.round(decoded.duration * 1000))
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [artifact.downloadUrl, artifact.mimeType, token])

  // 条数跟着轨道的实际像素宽度走：弹窗宽、屏幕窄都只改这一个数。
  useEffect(() => {
    const element = barsRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width === 0) return
      setBarCount(Math.max(BAR_MIN, Math.min(BAR_MAX, Math.floor(width / BAR_PITCH))))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  if (failed) return <ArtifactMedia artifact={artifact} label={artifact.id} className={className} />

  const scaleMs = Math.max(audioMs ?? 0, pictureMs ?? 0)
  // 轨道坐标：0 = 这一镜第一帧，1 = 画面与音频里更长的那个结束。
  const audioRatio = scaleMs > 0 && audioMs ? Math.min(1, audioMs / scaleMs) : 1
  const picture = pictureMs ?? null
  const pictureRatio = scaleMs > 0 && picture ? Math.min(1, picture / scaleMs) : 1
  // 200ms 以下不吭声：合成层判定「台词溢出到值得补帧」用的也是 0.2s（media/index.ts
  // needsFrameHold），提示的门槛不该比真正会改变成片的门槛更敏感。
  const mismatch = picture !== null && audioMs !== null && Math.abs(picture - audioMs) > 200
  const playhead = scaleMs > 0 ? Math.min(1, progressMs / scaleMs) : 0
  const bars = peaks ? downsample(peaks, barCount) : Array.from({ length: barCount }, () => 0)

  function seekToMs(ms: number) {
    const element = audioRef.current
    if (!element || !audioMs) return
    element.currentTime = Math.min(Math.max(ms, 0), audioMs / 1000)
  }

  function onClickTrack(event: MouseEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || !scaleMs) return
    seekToMs(((event.clientX - box.left) / box.width) * scaleMs)
  }

  function onKeyTrack(event: KeyboardEvent<HTMLDivElement>) {
    const stepMs = (event.shiftKey ? 5 : 1) * 1000
    if (event.key === 'ArrowRight') seekToMs(progressMs + stepMs)
    else if (event.key === 'ArrowLeft') seekToMs(progressMs - stepMs)
    else if (event.key === 'Home') seekToMs(0)
    else if (event.key === 'End') seekToMs(scaleMs)
    else return
    event.preventDefault()
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        variant="outline"
        size="icon"
        className="size-7 shrink-0"
        aria-label={playing ? t('shotboard.audio.pause') : t('shotboard.audio.play')}
        onClick={() => {
          const element = audioRef.current
          if (!element) return
          // 播不出来就退回原生播放器，而不是静默把失败咽掉：
          // 上一版这里 catch 完只改了 playing，点着没声音也不吭声，毛病藏了一整轮。
          if (element.paused) void element.play().catch(() => setFailed(true))
          else element.pause()
        }}
      >
        {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
      </Button>

      <div
        role="slider"
        tabIndex={0}
        aria-label={t('shotboard.audio.trackAria')}
        aria-valuemin={0}
        aria-valuemax={Math.round(scaleMs / 1000)}
        aria-valuenow={Math.round(Math.min(progressMs, scaleMs) / 1000)}
        aria-valuetext={`${formatDuration(progressMs)} / ${formatDuration(audioMs ?? 0)}`}
        className="focus-visible:ring-ring relative h-9 min-w-0 flex-1 cursor-pointer rounded outline-none focus-visible:ring-2"
        onClick={onClickTrack}
        onKeyDown={onKeyTrack}
      >
        <div ref={barsRef} className="absolute inset-y-0 left-0 flex items-center gap-[2px]" style={{ width: `${audioRatio * 100}%` }}>
          {bars.map((peak, index) => {
            const at = (index / bars.length) * audioRatio
            const pastPicture = picture !== null && at > pictureRatio
            return (
              <span
                key={index}
                className={cn(
                  'w-full',
                  peaks === null ? 'bg-muted-foreground/15'
                    : pastPicture ? 'bg-warning/70'
                      : at <= playhead ? 'bg-primary' : 'bg-muted-foreground/50',
                )}
                style={{ height: `${peaks === null ? 30 : Math.max(8, Math.round(peak * 100))}%` }}
              />
            )
          })}
        </div>
        {mismatch && (
          <span className="bg-warning/70 absolute inset-y-1 w-px" style={{ left: `${pictureRatio * 100}%` }} aria-hidden />
        )}
      </div>

      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
        {formatDuration(audioMs ?? 0)}
        {mismatch && picture !== null ? ` / ${formatDuration(picture)}` : ''}
      </span>

      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload="metadata"
        className="hidden"
        onTimeUpdate={event => setProgressMs(event.currentTarget.currentTime * 1000)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function extractPeaks(samples: Float32Array, count: number): number[] {
  const peaks = new Array<number>(count).fill(0)
  if (samples.length === 0) return peaks
  const bucket = Math.max(1, Math.floor(samples.length / count))
  let ceiling = 0
  for (const [index, sample] of samples.entries()) {
    const slot = Math.min(count - 1, Math.floor(index / bucket))
    const value = Math.abs(sample)
    if (value > peaks[slot]!) peaks[slot] = value
    if (value > ceiling) ceiling = value
  }
  // 归一到本条自身的峰值：波形在这里回答「声音落在哪一段」，不是「这条有多响」。
  return peaks.map(peak => Math.min(1, peak / Math.max(ceiling, 0.02)))
}

/** 从高分辨率峰值降到当前要画的根数，取每段最大值——变窄不能把已经画出来的声音抹掉。 */
function downsample(peaks: number[], count: number): number[] {
  if (count >= peaks.length) return peaks
  const out = new Array<number>(count).fill(0)
  for (const [index, peak] of peaks.entries()) {
    const slot = Math.min(count - 1, Math.floor((index * count) / peaks.length))
    if (peak > out[slot]!) out[slot] = peak
  }
  return out
}
