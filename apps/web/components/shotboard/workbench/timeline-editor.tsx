'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLineIcon, ArrowUpToLineIcon, CopyIcon, EyeOffIcon, EyeIcon,
  LoaderCircleIcon, RedoIcon, SaveIcon, ScissorsIcon, UndoIcon, VolumeXIcon, Volume2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ApiError, buildEpisodeEditDefault, fetchEpisodeEdit, getToken, saveEpisodeEdit,
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
 * SD-101:超出素材的行不许落库——头部计数>0 时「保存编辑」禁用(服务端同样会拒),
 * 旁边给一键「全部取整段」收回区间;序列为空时给「构建默认序列」入口(此前端点、
 * 客户端函数与文案都在,全站零调用,空白时间线是条死路)。
 * SD-100:行内与头部的图标按钮全部带 aria-label(上移/下移/复制/隐藏/撤销/重做/
 * 静音),越界的裁切终点输入框带 aria-invalid——无障碍树里这些控件曾是匿名的,
 * 读屏说不出「这一格超出素材了」。
 */
export interface TimelineState {
  clips: EditClip[]
  tracks: EditTrackElement[]
  fpsNum: number
  fpsDen: number
}

interface TimelineEditorViewProps {
  headRevision: number
  state: TimelineState
  materials: Record<string, EditClipMaterial>
  dirty: boolean
  saving: boolean
  building: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onBuildDefault: () => void
  onMoveClip: (index: number, direction: -1 | 1) => void
  onDuplicateClip: (index: number) => void
  onToggleHidden: (index: number) => void
  onTrimClip: (index: number, field: 'sourceInFrame' | 'sourceOutFrame', value: number) => void
  onTakeWholeClip: (index: number) => void
  onTakeWholeOvertrimmed: () => void
  onUpdateTrack: (index: number, values: Partial<EditTrackElement>) => void
}

/**
 * 渲染层（SD-100 起独立导出）：只吃容器给的状态与回调，不再自取数据——
 * 本仓组件测试跑在 node 环境、走 renderToStaticMarkup，取数留在容器里，
 * 行级可访问名与 aria-invalid 才能被静态断言钉住。
 */
export function TimelineEditorView(props: TimelineEditorViewProps) {
  const { t } = useI18n()
  const {
    headRevision, state, materials, dirty, saving, building, canUndo, canRedo,
    onUndo, onRedo, onSave, onBuildDefault, onMoveClip, onDuplicateClip, onToggleHidden,
    onTrimClip, onTakeWholeClip, onTakeWholeOvertrimmed, onUpdateTrack,
  } = props

  const fps = state.fpsNum / state.fpsDen
  /** 裁切区间要素材的长度:in 不为 0、out 越过素材尽头、或引用没钉到实际会用到的成片。 */
  function wholeClipGap(clip: EditClip) {
    const material = materials[clip.clipId]
    if (!material || material.maxFrame === null) return null
    if (clip.sourceInFrame === 0 && clip.sourceOutFrame === material.maxFrame && clip.artifactId === material.artifactId) return null
    return material
  }
  // SD-101:头部计数只管「裁到素材之外」——徽章文案讲的就是这件事,而它也正好是服务端
  // 拒绝保存的那一类。素材引用失效另有行内徽章,不混进同一条计数,免得计数与钮两回事。
  const overCount = state.clips.filter(clip => {
    const material = materials[clip.clipId]
    return material != null && material.maxFrame !== null && clip.sourceOutFrame > material.maxFrame
  }).length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">{t('timeline.title')} · {fps}fps · rev {headRevision}{dirty ? ' *' : ''}</span>
          {overCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{t('timeline.brokenCount', { count: overCount })}</Badge>
              </TooltipTrigger>
              <TooltipContent>{t('timeline.brokenCountHint')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onUndo} disabled={!canUndo} aria-label={t('timeline.undo')}><UndoIcon className="size-3" /></Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onRedo} disabled={!canRedo} aria-label={t('timeline.redo')}><RedoIcon className="size-3" /></Button>
          {overCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={onTakeWholeOvertrimmed}>
                  <ScissorsIcon className="size-3" />
                  {t('timeline.wholeClipAll')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('timeline.wholeClipAllHint')}</TooltipContent>
            </Tooltip>
          )}
          {dirty && (overCount > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button size="sm" className="h-7 px-3 text-xs" disabled>
                    <SaveIcon className="size-3" />
                    {t('timeline.save')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('timeline.saveBlockedByOverMedia')}</TooltipContent>
            </Tooltip>
          ) : (
            <Button size="sm" className="h-7 px-3 text-xs" disabled={saving} onClick={onSave}>
              {saving ? <LoaderCircleIcon className="size-3 animate-spin" /> : <SaveIcon className="size-3" />}
              {t('timeline.save')}
            </Button>
          ))}
        </div>
      </div>

      {/* SD-101 空序列出口:0 行时这里过去是一片空白,端点与文案早就存在却没人调用。 */}
      {state.clips.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed px-3 py-2">
          <span className="text-muted-foreground text-xs">{t('timeline.emptyNoShots')}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 px-3 text-xs" disabled={building} onClick={onBuildDefault}>
            {building ? <LoaderCircleIcon className="size-3 animate-spin" /> : <ScissorsIcon className="size-3" />}
            {t('timeline.buildDefault')}
          </Button>
        </div>
      )}

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
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => onMoveClip(index, -1)} disabled={index === 0} aria-label={t('timeline.moveUp')}><ArrowUpToLineIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => onMoveClip(index, 1)} disabled={index === state.clips.length - 1} aria-label={t('timeline.moveDown')}><ArrowDownToLineIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => onDuplicateClip(index)} aria-label={t('timeline.duplicateClip')}><CopyIcon className="size-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => onToggleHidden(index)} aria-label={hidden ? t('timeline.showClip') : t('timeline.hideClip')}>{hidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}</Button>
              <ScissorsIcon className="text-muted-foreground ml-1 size-3" />
              <Input type="number" className="h-6 w-16 text-xs" value={clip.sourceInFrame} onChange={e => onTrimClip(index, 'sourceInFrame', Number(e.target.value))} />
              <span className="text-muted-foreground">→</span>
              <Input type="number" aria-invalid={over} className={`h-6 w-16 text-xs ${over ? 'border-destructive' : ''}`} value={clip.sourceOutFrame} onChange={e => onTrimClip(index, 'sourceOutFrame', Number(e.target.value))} />
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
                    <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => onTakeWholeClip(index)}>{t('timeline.wholeClip')}</Button>
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
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => onUpdateTrack(index, { muted: !track.muted })} aria-label={track.muted ? t('timeline.unmuteTrack') : t('timeline.muteTrack')}>
                  {track.muted ? <VolumeXIcon className="size-3 text-muted-foreground" /> : <Volume2Icon className="size-3" />}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="w-14">
                      <Input type="number" className="h-6 text-xs" value={track.offsetFrame} onChange={e => onUpdateTrack(index, { offsetFrame: Number(e.target.value) })} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('timeline.offset')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="w-14">
                      <Input type="number" step="0.1" min="0" max="2" className="h-6 text-xs" value={track.gain} onChange={e => onUpdateTrack(index, { gain: Number(e.target.value) })} />
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

export function TimelineEditor({ episodeId }: { episodeId: string }) {
  const { t } = useI18n()
  const [headRevision, setHeadRevision] = useState(0)
  const [state, setState] = useState<TimelineState | null>(null)
  const [materials, setMaterials] = useState<Record<string, EditClipMaterial>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [building, setBuilding] = useState(false)
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
      // 冲突判 HTTP 状态码:version_conflict 的报文是中文整句,旧判据 `message.includes('409')`
      // 永不成立,真冲突时草稿留在一个注定再失败的 revision 上。服务端的其它拒绝
      // (如 SD-101 越界裁切)走 else——留稿,只报原因。
      if (error instanceof ApiError && error.status === 409) {
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

  /** SD-101 空序列出口:端点/客户端函数/文案早已齐备,但全站没有调用点,
   *  「有分镜却还没序列」的用户只能刷新页面。 */
  async function buildDefault() {
    setBuilding(true)
    try {
      const result = await buildEpisodeEditDefault(getToken(), episodeId)
      if (result.rebuilt) toast.success(t('timeline.builtDefault'))
      await load()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) toast.info(t('timeline.manualEditsPresent'))
      else if (error instanceof ApiError && error.status === 400) toast.error(t('timeline.noShotsToBuild'))
      else toast.error(apiErrorMessage(error, t))
    } finally {
      setBuilding(false)
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

  /** SD-101 批量收回:只动「裁到素材之外」的行(有可信上限的那些),其余行的手工裁切一律不碰。 */
  function takeWholeOvertrimmedClips() {
    if (!state) return
    let touched = false
    const clips = state.clips.map(clip => {
      const material = materials[clip.clipId]
      if (!material || material.maxFrame === null || clip.sourceOutFrame <= material.maxFrame) return clip
      touched = true
      return { ...clip, artifactId: material.artifactId, sourceInFrame: 0, sourceOutFrame: material.maxFrame }
    })
    if (touched) commit({ ...state, clips })
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

  return (
    <TimelineEditorView
      headRevision={headRevision}
      state={state}
      materials={materials}
      dirty={dirty}
      saving={saving}
      building={building}
      canUndo={history.current.length > 0}
      canRedo={future.current.length > 0}
      onUndo={undo}
      onRedo={redo}
      onSave={() => void save()}
      onBuildDefault={() => void buildDefault()}
      onMoveClip={moveClip}
      onDuplicateClip={duplicateClip}
      onToggleHidden={toggleHidden}
      onTrimClip={trimClip}
      onTakeWholeClip={takeWholeClip}
      onTakeWholeOvertrimmed={takeWholeOvertrimmedClips}
      onUpdateTrack={updateTrack}
    />
  )
}
