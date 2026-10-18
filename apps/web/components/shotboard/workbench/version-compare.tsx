'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckIcon, Columns2Icon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { getToken, request } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface ArtifactOption {
  id: string
  version: number
  mimeType: string
  createdAt?: string
  downloadUrl: string
}

/**
 * US-018 双版本比较与采用:并排播放两个候选,同步播放/暂停/进度,各自独立静音;
 * 「采用此版」走选版接口(带锁定提示)。选版后另一版保留为候选,可随时换回。
 */
export function VersionCompare({ storyboardId, artifacts, onAdopted }: {
  storyboardId: string
  artifacts: ArtifactOption[]
  onAdopted?: (artifactId: string) => void
}) {
  const { t } = useI18n()
  const [leftId, setLeftId] = useState(artifacts[0]?.id ?? '')
  const [rightId, setRightId] = useState(artifacts[1]?.id ?? '')
  const [playing, setPlaying] = useState(false)
  const [leftMuted, setLeftMuted] = useState(false)
  const [rightMuted, setRightMuted] = useState(true)
  const [adopting, setAdopting] = useState<string | null>(null)
  const leftRef = useRef<HTMLVideoElement>(null)
  const rightRef = useRef<HTMLVideoElement>(null)

  useEffect(() => { setPlaying(false) }, [leftId, rightId])

  function togglePlay() {
    const next = !playing
    setPlaying(next)
    for (const video of [leftRef.current, rightRef.current]) {
      if (!video) continue
      if (next) void video.play()
      else video.pause()
    }
  }

  // 同步进度:左视频为 master,右视频跟随。
  function onLeftTimeUpdate() {
    if (leftRef.current && rightRef.current) {
      const delta = Math.abs(leftRef.current.currentTime - rightRef.current.currentTime)
      if (delta > 0.3) rightRef.current.currentTime = leftRef.current.currentTime
    }
  }

  async function adopt(artifactId: string) {
    setAdopting(artifactId)
    try {
      await request(`/storyboards/${storyboardId}/video-selection`, {
        token: getToken(),
        method: 'POST',
        body: JSON.stringify({ artifactId }),
        headers: { 'content-type': 'application/json' },
      })
      toast.success(t('compare.adopted'))
      onAdopted?.(artifactId)
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setAdopting(null)
    }
  }

  if (artifacts.length < 2) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
          <Columns2Icon className="size-3.5" />
          {t('compare.title')}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={togglePlay} className="h-7 px-2 text-xs">
            {playing ? '⏸' : '▶'} {playing ? t('compare.pause') : t('compare.play')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {([['left', leftId, leftMuted, setLeftMuted, leftRef], ['right', rightId, rightMuted, setRightMuted, rightRef]] as const).map(([side, id, muted, setMuted, ref]) => {
          const artifact = artifacts.find(option => option.id === id)
          if (!artifact) return null
          return (
            <div key={side} className="space-y-1">
              <div className="relative overflow-hidden rounded-md border">
                <video
                  ref={ref}
                  src={artifact.downloadUrl}
                  muted={muted}
                  className="aspect-[9/16] w-full"
                  onTimeUpdate={side === 'left' ? onLeftTimeUpdate : undefined}
                  controls={false}
                />
                <button
                  type="button"
                  onClick={() => setMuted(!muted)}
                  className="bg-background/80 absolute right-1 top-1 rounded p-1 text-xs"
                  aria-label={muted ? t('compare.unmute') : t('compare.mute')}
                >
                  {muted ? '🔇' : '🔊'}
                </button>
                <Badge variant="outline" className="absolute left-1 top-1 text-[10px]">
                  v{artifact.version}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <select
                  value={id}
                  onChange={event => (side === 'left' ? setLeftId(event.target.value) : setRightId(event.target.value))}
                  className="bg-background border-input rounded border px-1 py-0.5 text-xs"
                >
                  {artifacts.map(option => (
                    <option key={option.id} value={option.id}>v{option.version}</option>
                  ))}
                </select>
                <Button
                  size="sm" variant="outline" className="h-6 px-2 text-xs"
                  disabled={adopting !== null}
                  onClick={() => void adopt(id)}
                >
                  {adopting === id ? <LoaderCircleIcon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
                  {t('compare.adopt')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
