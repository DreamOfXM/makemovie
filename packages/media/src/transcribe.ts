import { run } from './index.js'
import type { TechnicalFinding } from './quality-check.js'

/**
 * US-033 转写与音画检查的纯函数半层:期望台词 vs 适配器转写结果的差异,以及
 * ffmpeg volumedetect 的技术音频检查。不含任何 I/O 依赖之外的判断——落库、
 * severity 映射是路由的事。
 */

export interface TranscriptDiffItem {
  kind: 'missing' | 'extra' | 'mismatch'
  /** 台词里应念而没念出(或念成别样)的文本。 */
  expectedText?: string
  /** 转写里实际听到(但台词里没有)的文本。 */
  actualText?: string
  /** 定位到的段(毫秒);无 segments 时不伪造定位(FR-Q06)。 */
  startMs?: number
  endMs?: number
}

interface TranscriptSegmentLike {
  startMs: number
  endMs: number
  text: string
}

/** 归一:去空白、去中英标点、拉丁小写——trim/标点差异不算念错。 */
function normalizeForDiff(text: string): string {
  return Array.from(text)
    .map(char => char.toLowerCase())
    .filter(char => !/[\s，。！？、；：…．·,\.\!\?;:'"`“”‘’「」『』（）()【】《》<>—\-～~]/.test(char))
    .join('')
}

/** 按句读把台词切成子句(保留句尾标点——missing 条目引的是原文),不引入分词依赖。 */
function splitClauses(expected: string): string[] {
  return (expected.match(/[^。！？!?\n；;…]+[。！？!?；;…]*/g) ?? [])
    .map(clause => clause.replace(/\n/g, '').trim())
    .filter(clause => clause !== '')
}

/**
 * 期望台词与转写结果的差异。判定只做三件事:
 *  1. 整段等价(归一后)→ 无差异;
 *  2. 无 segments → 只报整段级差异(missing/extra/mismatch 单条),不伪造词级定位;
 *  3. 有 segments → 子句包含判断:未在任何段里找到的子句是 missing;不含任何
 *     子句的非空段是 extra;数量恰好一对一时合并成 mismatch(带段时间)。
 * 相似度只到「归一后包含」为止——它是免依赖的近似,不是对齐算法。
 */
export function diffTranscript(expected: string, actual: { transcript: string; segments?: TranscriptSegmentLike[] }): TranscriptDiffItem[] {
  const expectedNorm = normalizeForDiff(expected)
  const transcriptNorm = normalizeForDiff(actual.transcript)
  if (expectedNorm === transcriptNorm) return []

  const segments = (actual.segments ?? []).filter(segment => typeof segment?.text === 'string' && normalizeForDiff(segment.text) !== '')

  // FR-Q06:没有段信息时只报整段级,不猜词级时间。
  if (segments.length === 0) {
    if (expectedNorm === '') return [{ kind: 'extra', actualText: actual.transcript.trim() }]
    if (transcriptNorm === '') return [{ kind: 'missing', expectedText: expected.trim() }]
    return [{ kind: 'mismatch', expectedText: expected.trim(), actualText: actual.transcript.trim() }]
  }

  const clauses = splitClauses(expected)
  const clausesNorm = clauses.map(normalizeForDiff)
  const segmentsNorm = segments.map(segment => normalizeForDiff(segment.text))

  const clauseMatched = clausesNorm.map(clauseNorm => clauseNorm === '' || segmentsNorm.some(segmentNorm => segmentNorm.includes(clauseNorm)))
  const segmentMatched = segmentsNorm.map(segmentNorm => clausesNorm.some(clauseNorm => clauseNorm !== '' && segmentNorm.includes(clauseNorm)))

  const unmatchedClauses = clauses.filter((_, index) => !clauseMatched[index])
  const unmatchedSegments = segments.filter((_, index) => !segmentMatched[index])

  if (unmatchedClauses.length === 0 && unmatchedSegments.length === 0) {
    // 每句都找到了、每段都有着落,但整段仍不等价(如段内夹了未被切出的杂讯)——
    // 退回整段级报告,不硬造条目。
    return [{ kind: 'mismatch', expectedText: expected.trim(), actualText: actual.transcript.trim() }]
  }

  // 一对一时,missing+extra 合并成带定位的 mismatch 更接近人读的事实;
  // 数量不齐时不强行配对,各报各的(missing 无时间——不知道它该出现在哪)。
  if (unmatchedClauses.length === unmatchedSegments.length) {
    return unmatchedClauses.map((clause, index) => ({
      kind: 'mismatch' as const,
      expectedText: clause,
      actualText: unmatchedSegments[index]!.text.trim(),
      startMs: unmatchedSegments[index]!.startMs,
      endMs: unmatchedSegments[index]!.endMs,
    }))
  }

  return [
    ...unmatchedClauses.map(clause => ({ kind: 'missing' as const, expectedText: clause })),
    ...unmatchedSegments.map(segment => ({
      kind: 'extra' as const,
      actualText: segment.text.trim(),
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
  ]
}

/**
 * US-033 技术音频检查:ffmpeg volumedetect。
 *  - max_volume > -0.5dB → clipping 疑点(warning)——接近/达到满幅,可能已削波;
 *  - mean_volume < -60dB → 静音疑点(warning)——有效音频内容缺失。
 * 与 blackdetect 同一纪律:疑点检测失败不算阻塞,返回空。
 */
export async function checkAudioTechnicals(filePath: string): Promise<TechnicalFinding[]> {
  let stderr: string
  try {
    ;({ stderr } = await run('ffmpeg', ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-']))
  } catch {
    return []
  }
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
  const findings: TechnicalFinding[] = []
  if (max) {
    const maxVolume = Number(max[1])
    if (Number.isFinite(maxVolume) && maxVolume > -0.5) {
      findings.push({
        id: 'audio_clipping',
        severity: 'warning',
        dimension: 'audio',
        message: `suspected clipping: max volume ${max[1]} dB exceeds -0.5 dB`,
        evidenceTimeSeconds: null,
      })
    }
  }
  if (mean) {
    const meanVolume = Number(mean[1])
    if (Number.isFinite(meanVolume) && meanVolume < -60) {
      findings.push({
        id: 'audio_silence',
        severity: 'warning',
        dimension: 'audio',
        message: `audio near silence: mean volume ${mean[1]} dB below -60 dB`,
        evidenceTimeSeconds: null,
      })
    }
  }
  return findings
}
