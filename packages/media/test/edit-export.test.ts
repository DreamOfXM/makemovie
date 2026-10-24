import { describe, expect, it } from 'vitest'
import { buildEdl, buildFcpxml, buildOtio, type EditListInput } from '../src/index.js'

const input: EditListInput = {
  title: 'EP1 雨夜 & "告别"',
  clips: [
    { number: 1, title: '巷口相遇', durationMs: 3000, sourceFile: 'org1/p1/e1/VIDEO/sb1/v1.mp4', measured: true },
    // 1239ms = 30.975 帧:导出必须四舍五入到整帧,不留亚帧漂移。
    { number: 2, title: '雨夜分别', durationMs: 1239, sourceFile: 'missing-shot-2', measured: false },
  ],
}

describe('buildEdl', () => {
  const edl = buildEdl(input)

  it('emits a CMX 3600 event per clip with accumulating record timecodes', () => {
    expect(edl).toContain('TITLE: EP1 雨夜 & "告别"')
    expect(edl).toContain('FCM: NON-DROP FRAME')
    // 75 帧 @25 = 00:00:03:00;第二镜 31 帧 = 00:00:01:06,record 出点 = 106 帧 = 00:00:04:06。
    expect(edl).toMatch(/^001 {2}AX {23}V {5}C {8}00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00$/m)
    expect(edl).toMatch(/^002 {2}AX {23}V {5}C {8}00:00:00:00 00:00:01:06 00:00:03:00 00:00:04:06$/m)
  })

  it('names each source and flags planned-duration fallbacks', () => {
    expect(edl).toContain('* FROM CLIP NAME: #1 巷口相遇')
    expect(edl).toContain('* SOURCE: org1/p1/e1/VIDEO/sb1/v1.mp4\n')
    expect(edl).toContain('* SOURCE: missing-shot-2 (planned duration, clip unmeasured)')
  })

  it('honours a custom frame rate', () => {
    const at24 = buildEdl({ ...input, fps: 24 })
    // 3000ms @24 = 72 帧整 = 00:00:03:00；1239ms @24 = 29.736 → 30 帧。
    expect(at24).toMatch(/^001 {2}AX {23}V {5}C {8}00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00$/m)
    expect(at24).toMatch(/^002 {2}AX {23}V {5}C {8}00:00:00:00 00:00:01:06 00:00:03:00 00:00:04:06$/m)
  })
})

describe('buildFcpxml', () => {
  const xml = buildFcpxml(input)

  it('describes a 25fps 9:16 sequence whose spine matches the master order', () => {
    expect(xml).toContain('<!DOCTYPE fcpxml>')
    expect(xml).toContain('<fcpxml version="1.10">')
    expect(xml).toContain('frameDuration="1/25s" width="1080" height="1920"')
    expect(xml).toContain('<asset id="x1"')
    expect(xml).toContain('duration="75/25s"')
    expect(xml).toContain('duration="31/25s"')
    expect(xml).toContain('tcDuration="106/25s"')
    expect(xml).toContain('ref="x2" offset="75/25s"')
  })

  it('takes the sequence frame from the caller instead of assuming vertical', () => {
    const wide = buildFcpxml({ ...input, frame: { width: 1920, height: 1080 } })
    expect(wide).toContain('frameDuration="1/25s" width="1920" height="1080"')
    // 横屏交付里竖屏默认一次都不该出现。
    expect(wide).not.toContain('width="1080"')
  })

  it('escapes XML in names and never leaks raw markup', () => {
    expect(xml).toContain('name="EP1 雨夜 &amp; &quot;告别&quot;"')
    expect(xml).toContain('#2 雨夜分别 (planned)')
    // 未转义的原文标题只允许出现在 EDL 里，XML 中一次都不该有。
    expect(xml).not.toContain('name="EP1 雨夜 & "')
    expect(xml).not.toContain('雨夜 & "告别"')
  })

  it('points src at the delivered clip object key', () => {
    expect(xml).toContain('src="file:///org1/p1/e1/VIDEO/sb1/v1.mp4"')
  })
})

describe('buildOtio', () => {
  interface OtioClip {
    name: string
    source_range: { duration: { rate: number; value: number } }
    media_reference: { target_url: string }
    metadata: { makemovie: { shot: number; measured_duration: boolean } }
  }
  interface OtioTrack {
    name: string
    kind: string
    children: OtioClip[]
  }
  interface OtioTimeline {
    OTIO_SCHEMA: string
    global_start_time: { rate: number; value: number }
    tracks: { children: OtioTrack[] }
  }

  it('builds a Timeline whose V1 clips carry the same frame math and fallback flags', () => {
    const timeline = JSON.parse(buildOtio(input)) as OtioTimeline
    expect(timeline.OTIO_SCHEMA).toBe('Timeline.1')
    expect(timeline.global_start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value: 0 })
    const [v1] = timeline.tracks.children
    expect(v1).toMatchObject({ OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video' })
    expect(v1.children).toHaveLength(2)
    // 与 EDL 同一份数学:3000ms@25=75 帧、1239ms=31 帧;planned 回退照实标注。
    expect(v1.children[0]!.name).toBe('#1 巷口相遇')
    expect(v1.children[0]!.source_range.duration).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value: 75 })
    expect(v1.children[1]!.source_range.duration.value).toBe(31)
    expect(v1.children[1]!.name).toContain('(planned)')
    expect(v1.children[0]!.media_reference.target_url).toBe('file:///org1/p1/e1/VIDEO/sb1/v1.mp4')
    expect(v1.children[0]!.metadata.makemovie).toEqual({ shot: 1, measured_duration: true })
  })

  it('adds the score as an A1 audio track only when one was mixed in', () => {
    const bare = JSON.parse(buildOtio(input)) as OtioTimeline
    expect(bare.tracks.children).toHaveLength(1)

    const withScore = JSON.parse(buildOtio({
      ...input,
      score: { sourceUrl: 'org1/p1/e1/music/master/v1.wav', durationMs: 9000 },
    })) as OtioTimeline
    const [v1, a1] = withScore.tracks.children
    expect(v1.name).toBe('V1')
    expect(a1).toMatchObject({ OTIO_SCHEMA: 'Track.1', name: 'A1', kind: 'Audio' })
    expect(a1.children[0]!.media_reference.target_url).toBe('file:///org1/p1/e1/music/master/v1.wav')
    // 音乐源虽有225帧,实际放置范围不得超过V1的75+31帧。
    expect(a1.children[0]!.source_range.duration.value).toBe(106)
  })
})
