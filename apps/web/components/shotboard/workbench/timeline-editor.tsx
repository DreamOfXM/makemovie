'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLineIcon, ArrowUpToLineIcon, CopyIcon, EyeOffIcon, EyeIcon,
  LoaderCircleIcon, RedoIcon, SaveIcon, ScissorsIcon, UndoIcon, VolumeXIcon, Volume2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchEpisodeEdit, getToken, saveEpisodeEdit,
  type EditClip, type EditClipMaterial, type EditTrackElement,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * US-025 + US-026 时间线编辑器:镜头调序(上下移)、重复、隐藏、裁切(帧区间),
 * 声音轨道(偏移/增益/静音/锁定),撤销/重做,保存失败保留草稿。
 * 按 §10.2:sourceIn 含起/sourceOut 不含终,二者都是 editMedia 帧索引。
 * SD-099:每行同时报「裁了多长」与「素材实测多长」,并对裁到素材尽头之外的
 * 行给出「取整段」一键修正——合成按帧号硬裁,看不见实长就等于裁掉已付费画面。
 */
interface TimelineState {
  clips: EditClip[]
  tracks: EditTrackElement[]
  fpsNum: number
  fpsDen: number
}

export function TimelineEditor({ episodeId }: { episodeId: string }) {
  const { t } = useI18n()
  const [headRevision, setHeadRevision] = useState(0)
  const [state, setState] = useState<TimelineState | null>(null)
  const [materials, setMaterials] = useState<Record<string, EditClipMaterial>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const history = useRef<TimelineState[]>([])
  const future = useRef<TimelineState[]>([])

  const load = useCallback(async () => {
    try {
      const data = await fetchEpisodeEdit(getToken(), episodeId)
      setHeadRevision(data.headRevision)
      setState({ clips: data.revision.clips, tracks: data.revision.tracks, fpsNum: data.revision.fpsNum, fpsDen: data.revision.fpsDen })
      // 素材实长是只读富化:不进撤销栈、不回传服务端,所以刷新它不会让草稿变脏。
      setMaterials(Object.fromEntries((data.materials ?? []).map(item => [item.clipId, item])))
      setDirty(false)
      history.current = []
      future.current = []
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }, [episodeId, t])

  useEffect(() => { void load() }, [load])

  function commit(next: TimelineState) {
    if (state) history.current.push(state)
    future.current = []
    setState(next)
    setDirty(true)
  }

  function undo() {
    const prev = history.current.pop()
    if (prev && state) { future.current.push(state); setState(prev); setDirty(true) }
  }

  function redo() {
    const next = future.current.pop()
    if (next && state) { history.current.push(state); setState(next); setDirty(true) }
  }

  async function save() {
    if (!state || !dirty) return
    setSaving(true)
    try {
      const result = await saveEpisodeEdit(getToken(), episodeId, {
        expectedEditRevision: headRevision,
        fps: { fpsNum: state.fpsNum, fpsDen: state.fpsDen },
        clips: state.clips,
        tracks: state.tracks,
      })
      setHeadRevision(result.headRevision)
      setDirty(false)
      history.current = []
      future.current = []
      toast.success(t('timeline.saved'))
    } catch (error) {
      if (error instanceof Error && error.message.includes('409')) {
        toast.error(t('timeline.conflict'))
        await load()
      } else {
        // 保存失败:草稿保留(§10.2 FR-T01)。
        toast.error(apiErrorMessage(error, t))
      }
    } finally {
      setSaving(false)
    }
  }

  // 剪辑操作
  function moveClip(index: number, direction: -1 | 1) {
    if (!state) return
    const target = index + direction
    if (target < 0 || target >= state.clips.length) return
    const clips = [...state.clips]
    ;[clips[index], clips[target]] = [clips[target]!, clips[index]!]
    commit({ ...state, clips })
  }

  function duplicateClip(index: number) {
    if (!state) return
    const clips = [...state.clips]
    const source = clips[index]!
    const copy: EditClip = { ...source, clipId: `${source.clipId}-copy-${Date.now()}` }
    clips.splice(index + 1, 0, copy)
    commit({ ...state, clips })
  }

  function toggleHidden(index: number) {
    if (!state) return
    const clips = [...state.clips]
    const clip = clips[index]!
    clips[index] = { ...clip, artifactId: clip.artifactId === '' ? '' : clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame }
    // 隐藏 = clipId 前缀 __hidden__(渲染层跳过);恢复 = 去前缀。
    if (clip.clipId.startsWith('__hidden__')) clips[index]!.clipId = clip.clipId.slice(10)
    else clips[index]!.clipId = `__hidden__${clip.clipId}`
    commit({ ...state, clips })
  }

  function trimClip(index: number, field: 'sourceInFrame' | 'sourceOutFrame', value: number) {
    if (!state || !Number.isInteger(value) || value < 0) return
    const clips = [...state.clips]
    const clip = clips[index]!
    if (field === 'sourceInFrame' && value >= clip.sourceOutFrame) return
    if (field === 'sourceOutFrame' && value <= clip.sourceInFrame) return
    clips[index] = { ...clip, [field]: value }
    commit({ ...state, clips })
  }

  /** SD-099 一键回到素材真相:整段 = 0 起、实测帧数止,并把引用钉到合成真会用到的成片。 */
  function takeWholeClip(index: number) {
    if (!state) return
    const clip = state.clips[index]!
    const material = materials[clip.clipId]
    if (!material || material.maxFrame === null) return
    const clips = [...state.clips]
    clips[index] = { ...clip, artifactId: material.artifactId, sourceInFrame: 0, sourceOutFrame: material.maxFrame }
    commit({ ...state, clips })
  }

  // 轨道操作
  function updateTrack(index: number, values: Partial<EditTrackElement>) {
    if (!state) return
    const tracks = [...state.tracks]
    tracks[index] = { ...tracks[index]!, ...values }
    commit({ ...state, tracks })
  }

  if (state === null) {
    return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
  }

  const fps = state.fpsNum / state.fpsDen
  /** 裁切区间要素材的长度:in 不为 0、out 越过素材尽头、或引用没钉到实际会用到的成片。 */
  function wholeClipGap(clip: EditClip) {
    const material = materials[clip.clipId]
    if (!material || material.maxFrame === null) return null
    if (clip.sourceInFrame === 0 && clip.sourceOutFrame === material.maxFrame && clip.artifactId === material.artifactId) return null
    return material
  }
  const brokenCount = state.clips.filter(clip => {
    const material = materials[clip.clipId]
    if (!material) return false
    return material.unresolved || (material.maxFrame !== null && clip.sourceOutFrame > material.maxFrame)
  }).length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">{t('timeline.title')} · {fps}fps · rev {headRevision}{dirty ? ' *' : ''}</span>
          {brokenCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{t('timeline.brokenCount', { count: brokenCount })}</Badge>
              </TooltipTrigger>
              <TooltipContent>{t('timeline.brokenCountHint')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={undo} disabled={history.current.length === 0}><UndoIcon className="size-3" /></Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={redo} disabled={future.current.length === 0}><RedoIcon className="size-3" /></Button>
          {dirty && (
            <Button size="sm" className="h-7 px-3 text-xs" disabled={saving} onClick={() => void save()}>
              {saving ? <LoaderCircleIcon className="size-3 animate-spin" /> : <SaveIcon className="size-3" />}
              {t('timeline.save')}
            </Button>
          )}
        </div>
      </div>

      {/* 视频主轨 V1:每行报「裁了多长 / 素材实测多长」,超出素材的行给一键取整段。 */}
      <div className="space-y-1">
        {state.clips.map((clip, index) => {
          const hidden = clip.clipId.startsWith('__hidden__')
          const displayId = hidden ? clip.clipId.slice(10) : clip.clipId
          const material = materials[clip.clipId]
          const gap = wholeClipGap(clip)
          const maxFrame = material?.maxFrame ?? null
          const over = maxFrame !== null && clip.sourceOutFrame > maxFrame
          const label = material?.shotNumber != null ? `#${material.shotNumber}` : displayId
          return (
            <div key={clip.clipId} className={`flex flex-wrap items-center gap-1 rounded border px-2 py-1 text-xs ${hidden ? 'opacity-40' : ''}`}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="w-10 shrink-0 truncate font-mono">{label}</span>
                </TooltipTrigger>
                <TooltipContent>
                  {t('timeline.clipIdLabel', { id: displayId })}
                  {material?.durationMs != null ? ` · ${t('timeline.mediaMeasured', { ms: material.durationMs, frames: material.maxFrame ?? 0 })}` : ''}
                </TooltipContent>
              </Tooltip>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => moveClip(index, -1)} disabled={index === 0}><ArrowUpToLineIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => moveClip(index, 1)} disabled={index === state.clips.length - 1}><ArrowDownToLineIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => duplicateClip(index)}><CopyIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => toggleHidden(index)}>{hidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}</Button>
              <ScissorsIcon className="text-muted-foreground ml-1 size-3" />
              <Input type="number" className="h-6 w-16 text-xs" value={clip.sourceInFrame} onChange={e => trimClip(index, 'sourceInFrame', Number(e.target.value))} />
              <span className="text-muted-foreground">→</span>
              <Input type="number" className={`h-6 w-16 text-xs ${over ? 'border-destructive' : ''}`} value={clip.sourceOutFrame} onChange={e => trimClip(index, 'sourceOutFrame', Number(e.target.value))} />
              <span className="text-muted-foreground ml-1 shrink-0 tabular-nums">{((clip.sourceOutFrame - clip.sourceInFrame) / fps).toFixed(1)}s</span>
              {material && (
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  / {maxFrame === null ? (material.artifactId === '' ? t('timeline.mediaMissing') : t('timeline.mediaUnmeasured')) : t('timeline.mediaLength', { seconds: (maxFrame / fps).toFixed(1) })}
                </span>
              )}
              {material?.unresolved && <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{t('timeline.refBroken')}</Badge>}
              {over && <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{t('timeline.overMedia')}</Badge>}
              {gap && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => takeWholeClip(index)}>{t('timeline.wholeClip')}</Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('timeline.wholeClipHint', { frames: gap.maxFrame ?? 0 })}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>

      {/* 声音轨道 */}
      {state.tracks.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <span className="text-muted-foreground text-xs font-medium">{t('timeline.tracks')}</span>
          {state.tracks.map((track, index) => {
            const anchorShot = track.clipId ? materials[track.clipId]?.shotNumber : undefined
            return (
              <div key={track.elementId} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
                <span className="w-16 shrink-0 truncate">{track.anchor === 'clip' ? (anchorShot != null ? `#${anchorShot}` : track.clipId ?? '') : '⏱'}</span>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => updateTrack(index, { muted: !track.muted })}>
                  {track.muted ? <VolumeXIcon className="size-3 text-muted-foreground" /> : <Volume2Icon className="size-3" />}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="w-14">
                      <Input type="number" className="h-6 text-xs" value={track.offsetFrame} onChange={e => updateTrack(index, { offsetFrame: Number(e.target.value) })} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('timeline.offset')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="w-14">
                      <Input type="number" step="0.1" min="0" max="2" className="h-6 text-xs" value={track.gain} onChange={e => updateTrack(index, { gain: Number(e.target.value) })} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('timeline.gain')}</TooltipContent>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
