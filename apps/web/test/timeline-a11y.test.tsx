import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TimelineEditorView, type TimelineState } from '@/components/shotboard/workbench/timeline-editor'
import type { EditClip, EditClipMaterial, EditTrackElement } from '@/lib/api'

/**
 * SD-100：时间线这一屏的图标按钮曾在无障碍树里全部是匿名 button（实拍读树：每行
 * 4~5 枚无 Name），越界的裁切终点输入框也只有红框、没有 aria-invalid——读屏既说不清
 * 「这是哪颗钮」，也听不到「这一格超出素材了」。
 *
 * 与 workbench-operations 同一套 node 环境 harness：renderToStaticMarkup + i18n mock
 * （t() 恒回键名，断言只钉结构与键，不随字典措辞漂移）。渲染的是独立导出的
 * TimelineEditorView——容器负责取数，静态渲染跑不了 effect，行级标记只有渲染层可测。
 */

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  translateEnum: (value: string) => value,
}))

function clip(over: Partial<EditClip> = {}): EditClip {
  return { clipId: 'clip-1', storyboardId: 'sb-1', artifactId: 'art-1', sourceInFrame: 0, sourceOutFrame: 50, ...over }
}

function material(over: Partial<EditClipMaterial> = {}): EditClipMaterial {
  return { clipId: 'clip-1', shotNumber: 2, artifactId: 'art-1', durationMs: 2000, maxFrame: 50, unresolved: false, ...over }
}

function track(over: Partial<EditTrackElement> = {}): EditTrackElement {
  return { elementId: 'el-1', sourceArtifactId: 'art-1', anchor: 'clip', clipId: 'clip-1', offsetFrame: 0, gain: 1, muted: false, locked: false, ...over }
}

const baseState: TimelineState = { clips: [clip(), clip({ clipId: 'clip-2', artifactId: 'art-2', sourceOutFrame: 999 })], tracks: [track(), track({ elementId: 'el-2', clipId: 'clip-2', muted: true })], fpsNum: 25, fpsDen: 1 }
const baseMaterials: Record<string, EditClipMaterial> = {
  'clip-1': material(),
  'clip-2': material({ clipId: 'clip-2', shotNumber: 3, artifactId: 'art-2', durationMs: 4040, maxFrame: 100 }),
}

function renderView(over: Partial<React.ComponentProps<typeof TimelineEditorView>> = {}) {
  return renderToStaticMarkup(
    <TimelineEditorView
      headRevision={6}
      state={baseState}
      materials={baseMaterials}
      dirty={false}
      saving={false}
      building={false}
      canUndo
      canRedo={false}
      onUndo={() => {}}
      onRedo={() => {}}
      onSave={() => {}}
      onBuildDefault={() => {}}
      onMoveClip={() => {}}
      onDuplicateClip={() => {}}
      onToggleHidden={() => {}}
      onTrimClip={() => {}}
      onTakeWholeClip={() => {}}
      onTakeWholeOvertrimmed={() => {}}
      onUpdateTrack={() => {}}
      {...over}
    />,
  )
}

describe('时间线图标按钮的可访问名（SD-100）', () => {
  it('头部撤销/重做与每行上移/下移/复制/隐藏、轨道静音钮都带 aria-label', () => {
    const html = renderView()
    expect(html).toContain('aria-label="timeline.undo"')
    expect(html).toContain('aria-label="timeline.redo"')
    expect(html).toContain('aria-label="timeline.muteTrack"')
    expect(html).toContain('aria-label="timeline.unmuteTrack"')
    // 两行 clip：四枚行钮各出现两次，而不是某一行的钮整排匿名。
    for (const key of ['timeline.moveUp', 'timeline.moveDown', 'timeline.duplicateClip', 'timeline.hideClip']) {
      expect(html.match(new RegExp(`aria-label="${key}"`, 'g')), key).toHaveLength(2)
    }
  })

  it('隐藏行的钮说的是恢复显示，不是继续隐藏', () => {
    const hidden = renderView({
      state: { ...baseState, clips: [clip({ clipId: '__hidden__clip-1' })], tracks: [] },
      materials: {},
    })
    expect(hidden).toContain('aria-label="timeline.showClip"')
    expect(hidden).not.toContain('aria-label="timeline.hideClip"')
  })
})

describe('越界裁切输入框的 aria-invalid（SD-100）', () => {
  it('裁切终点越过素材的行，输入框对读屏声明 invalid', () => {
    const html = renderView()
    // clip-2 终点 999 > 素材 100 帧——恰一一枚 true；在册的 clip-1 是显式 false，不是缺省。
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1)
    expect(html.match(/aria-invalid="false"/g)).toHaveLength(1)
  })

  it('没有越界时不亮 invalid=true，红框与 invalid 同进同退', () => {
    const html = renderView({
      state: { ...baseState, clips: [clip()], tracks: [] },
      materials: { 'clip-1': material() },
    })
    expect(html).not.toContain('aria-invalid="true"')
  })
})
