'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLineIcon, ArrowUpToLineIcon, CopyIcon, EyeOffIcon, EyeIcon,
  LoaderCircleIcon, RedoIcon, SaveIcon, ScissorsIcon, UndoIcon, VolumeXIcon, Volume2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchEpisodeEdit, getToken, saveEpisodeEdit,
  type EditClip, type EditTrackElement,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * US-025 + US-026 时间线编辑器:镜头调序(上下移)、重复、隐藏、裁切(帧区间),
 * 声音轨道(偏移/增益/静音/锁定),撤销/重做,保存失败保留草稿。
 * 按 §10.2:sourceIn 含起/sourceOut 不含终,二者都是 editMedia 帧索引。
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
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const history = useRef<TimelineState[]>([])
  const future = useRef<TimelineState[]>([])

  const load = useCallback(async () => {
    try {
      const data = await fetchEpisodeEdit(getToken(), episodeId)
      setHeadRevision(data.headRevision)
      setState({ clips: data.revision.clips, tracks: data.revision.tracks, fpsNum: data.revision.fpsNum, fpsDen: data.revision.fpsDen })
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium">{t('timeline.title')} · {fps}fps · rev {headRevision}{dirty ? ' *' : ''}</span>
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

      {/* 视频主轨 V1 */}
      <div className="space-y-1">
        {state.clips.map((clip, index) => {
          const hidden = clip.clipId.startsWith('__hidden__')
          const displayId = hidden ? clip.clipId.slice(10) : clip.clipId
          return (
            <div key={clip.clipId} className={`flex items-center gap-1 rounded border px-2 py-1 text-xs ${hidden ? 'opacity-40' : ''}`}>
              <span className="w-16 shrink-0 truncate font-mono">{displayId}</span>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => moveClip(index, -1)} disabled={index === 0}><ArrowUpToLineIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => moveClip(index, 1)} disabled={index === state.clips.length - 1}><ArrowDownToLineIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => duplicateClip(index)}><CopyIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => toggleHidden(index)}>{hidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}</Button>
              <ScissorsIcon className="text-muted-foreground ml-1 size-3" />
              <Input type="number" className="h-6 w-16 text-xs" value={clip.sourceInFrame} onChange={e => trimClip(index, 'sourceInFrame', Number(e.target.value))} />
              <span className="text-muted-foreground">→</span>
              <Input type="number" className="h-6 w-16 text-xs" value={clip.sourceOutFrame} onChange={e => trimClip(index, 'sourceOutFrame', Number(e.target.value))} />
              <span className="text-muted-foreground ml-1">{(clip.sourceOutFrame - clip.sourceInFrame) / fps}s</span>
            </div>
          )
        })}
      </div>

      {/* 声音轨道 */}
      {state.tracks.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <span className="text-muted-foreground text-xs font-medium">{t('timeline.tracks')}</span>
          {state.tracks.map((track, index) => (
            <div key={track.elementId} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
              <span className="w-16 shrink-0 truncate">{track.anchor === 'clip' ? `↔${track.clipId ?? ''}` : '⏱'}</span>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => updateTrack(index, { muted: !track.muted })}>
                {track.muted ? <VolumeXIcon className="size-3 text-muted-foreground" /> : <Volume2Icon className="size-3" />}
              </Button>
              <Input type="number" className="h-6 w-14 text-xs" value={track.offsetFrame} onChange={e => updateTrack(index, { offsetFrame: Number(e.target.value) })} title={t('timeline.offset')} />
              <Input type="number" step="0.1" min="0" max="2" className="h-6 w-14 text-xs" value={track.gain} onChange={e => updateTrack(index, { gain: Number(e.target.value) })} title={t('timeline.gain')} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
