/**
 * 剧本分镜表的「生成方式」列回答一个问题：这一镜的画面要不要模型产出。
 *
 * 作者写「视频」的镜头由首帧/视频阶段生成；「字卡」「屏幕录制」「合成」「UI」
 * 这几类由人在剪辑里做，平台替它们排队只会买回一堆没人用的图。空值与认不出的
 * 写法一律按视频处理——旧剧本没有这一列，不能因为归档数据缺字段就把整集跳过。
 */
export type ShotProduction = 'video' | 'ui' | 'title-card' | 'composition' | 'screen-recording'

export function shotProduction(method: string | null | undefined): ShotProduction {
  const value = (method ?? '').trim().toLowerCase()
  // 「视频」优先：合成/视频、UI/视频 这类复合写法里，视频是唯一需要模型产出的部分。
  if (value.includes('视频') || value.includes('video')) return 'video'
  if (value.includes('字卡') || value.includes('title')) return 'title-card'
  if (value.includes('屏幕录制') || value.includes('录屏') || value.includes('screen')) return 'screen-recording'
  if (value.includes('合成') || value.includes('composite') || value.includes('composition')) return 'composition'
  if (value.includes('ui') || value.includes('界面')) return 'ui'
  return 'video'
}

/** 界面换档时写回 `method` 的字面值，与上面每个识别词一一对应：人在界面上选了什么，
 *  读回来就必须是那一档，不能靠自由文本碰运气。 */
export const METHOD_WORDS: Record<ShotProduction, string> = {
  video: '视频',
  'title-card': '字卡',
  'screen-recording': '屏幕录制',
  composition: '合成',
  ui: '界面',
}

/**
 * 人写的「生成方式」只认五个档位词（空值=模型产出）。自由文本是模型那一侧的口径，
 * 人在界面上改档时不许往里塞一个读不出来的写法——认不出的写法一律回落视频，
 * 那意味着一次改档静默变成「什么都没改」。
 */
export type MethodInput = { ok: true; value: string | null } | { ok: false }

export function parseMethod(value: unknown): MethodInput {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true, value: null }
  return (Object.values(METHOD_WORDS) as string[]).includes(trimmed) ? { ok: true, value: trimmed } : { ok: false }
}

/** 这一镜要不要进 IMAGE/VIDEO 的计费队列。AUDIO 不看它：本机镜头也可能有台词。 */
export function needsGeneratedMedia(method: string | null | undefined): boolean {
  return shotProduction(method) === 'video'
}
