import { describe, expect, it } from 'vitest'
import { buildEdl, buildFcpxml, type EditListInput } from '../src/index.js'

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
