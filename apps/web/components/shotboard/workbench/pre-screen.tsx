'use client'

import { useEffect, useRef, useState } from 'react'
import { PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react'
import type { ShotboardShot } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArtifactLoadError, useArtifactUrl } from '@/components/generations/artifact-media'

/** 预映:拿现有素材按镜头顺序粗排。只读——不触发任何图片/视频模型调用。 */
export function PreScreenDialog({ shots, open, onClose }: { shots: ShotboardShot[]; open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (open) {
      setIndex(0)
      setPlaying(false)
    }
  }, [open])

  const shot = shots[index] ?? null
  const finished = playing === false && index >= shots.length - 1 && shots.length > 0

  useEffect(() => {
    if (!playing || !shot || open === false) return
    // 有可放片段时由 onEnded 推进;占位帧按规划时长走。
    if (shot.slot === 'chosen' || shot.slot === 'video') return
    const timer = setTimeout(() => advance(), Math.max(shot.durationMs ?? 2000, 1200))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, open])

  function advance() {
    if (index + 1 < shots.length) {
      setIndex(index + 1)
    } else {
      setPlaying(false)
    }
  }

  function slotLabel(s: ShotboardShot): string {
    if (s.slot === 'chosen') return t('shotboard.strip.chosen')
    if (s.slot === 'video') return t('shotboard.strip.hasclip')
    if (s.slot === 'running') return t('shotboard.strip.running')
    if (s.slot === 'frame') return t('shotboard.strip.frameOnly')
    return t('shotboard.strip.missing')
  }

  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('screening.preScreen')}</DialogTitle>
          <DialogDescription>{t('screening.preScreenHint')}</DialogDescription>
        </DialogHeader>

        {shot && <PreScreenStage key={shot.id} shot={shot} playing={playing} onEnded={advance} />}

        {shot && (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                <span className="text-muted-foreground font-mono">#{shot.number}</span> {shot.title}
              </p>
              <p className="text-subtle-foreground text-[11px] tabular-nums">
                {slotLabel(shot)} · {formatDuration(shot.durationMs)} · {index + 1}/{shots.length}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {playing ? (
                <Button variant="outline" size="sm" onClick={() => setPlaying(false)}>
                  <PauseIcon />
                  {t('screening.pause')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => { if (finished) setIndex(0); setPlaying(true) }}>
                  {finished ? <RotateCcwIcon /> : <PlayIcon />}
                  {finished ? t('screening.replay') : t('screening.play')}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="bg-muted/20 flex gap-px overflow-x-auto rounded-md border p-1">
          {shots.map((s, i) => (
            <Tooltip key={s.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`#${s.number} ${s.title} · ${slotLabel(s)}`}
                  onClick={() => { setIndex(i); setPlaying(false) }}
                  style={{ flexGrow: Math.max(s.durationMs, 500), flexBasis: 0, minWidth: 10 }}
                  className={cn(
                    'h-2 cursor-pointer rounded-sm',
                    i === index ? 'bg-primary' : s.slot === 'chosen' || s.slot === 'video' ? 'bg-success/50' : s.slot === 'running' ? 'bg-info/60' : 'bg-muted-foreground/25',
                  )}
                />
              </TooltipTrigger>
              {/* 8px 高的色条说不出自己是第几镜，这句是它唯一的名字 */}
              <TooltipContent>{`#${s.number} ${s.title} · ${slotLabel(s)}`}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreScreenStage({ shot, playing, onEnded }: { shot: ShotboardShot; playing: boolean; onEnded(): void }) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const playable = (shot.slot === 'chosen' || shot.slot === 'video') && shot.video !== null
  const { url, failed: videoFailed, reload: reloadVideo } = useArtifactUrl(playable && shot.video ? shot.video.downloadUrl : null)
  const wantsFrame = !playable && shot.slot === 'frame' && shot.firstFrame !== null
  const { url: frameUrl, failed: frameFailed, reload: reloadFrame } = useArtifactUrl(wantsFrame && shot.firstFrame ? shot.firstFrame.downloadUrl : null)

  // autoPlay 只在挂载时生效；暂停/恢复必须有人按下播放键这件事真正落到元素上。
  useEffect(() => {
    if (playing && playable && url) void videoRef.current?.play().catch(() => undefined)
    if (!playing) videoRef.current?.pause()
  }, [playing, playable, url])

  return (
    <div className="bg-black relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md">
      {playable && videoFailed ? (
        // 「这一镜的成片读不出来」以前和「还在读」是同一行字：舞台会永远停在
        // 「加载中」。黑色舞台用 destructive 本身而不是浅底 ink 色。
        <ArtifactLoadError className="text-destructive mx-4 max-w-72 bg-destructive/15" onRetry={reloadVideo} />
      ) : playable && url ? (
        <video ref={videoRef} src={url} playsInline onEnded={onEnded} className="h-full w-full object-contain" />
      ) : playable ? (
        <p className="text-muted-foreground text-xs">{t('screening.loading')}</p>
      ) : frameFailed ? (
        <ArtifactLoadError className="text-destructive mx-4 max-w-72 bg-destructive/15" onRetry={reloadFrame} />
      ) : shot.slot === 'frame' && frameUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={frameUrl} alt={`#${shot.number} ${shot.title}`} className="h-full w-full object-contain" />
      ) : shot.slot === 'running' ? (
        <p className="text-muted-foreground animate-pulse text-sm">{t('shotboard.strip.running')}</p>
      ) : (
        <div className="text-center">
          <p className="text-muted-foreground font-mono text-sm">#{shot.number}</p>
          <p className="text-faint-foreground text-xs">{t('shotboard.strip.missing')}</p>
        </div>
      )}
      {shot.slot === 'frame' && !playable && (
        <span className="text-faint-foreground absolute bottom-2 right-3 text-[10px]">{t('screening.placeholderBadge')}</span>
      )}
    </div>
  )
}
