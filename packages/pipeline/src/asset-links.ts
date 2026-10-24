/**
 * 镜头 ↔ 素材绑定规则。
 *
 * 绑定是首帧一致性的地基：没有绑定，模型既拿不到外观描述，也拿不到定妆照参考。
 * 原先这套匹配只写在分镜落库那一刻，素材晚于分镜创建（人工补场景、补道具）时
 * 就再也绑不上——本集 63 镜里 58 镜零绑定，首帧全是纯文生图。
 *
 * 这里把它抽成纯函数，落库时与每次触发 IMAGE/VIDEO 前共用同一套规则，避免
 * 「生成时绑一次、后来补的素材永远缺席」。
 */

export interface LinkableShot {
  id: string
  title: string
  description: string
  dialogue: string
  speaker?: string | null
  location?: string | null
}

export interface LinkableAsset {
  id: string
  name: string
  kind: string
}

export interface ShotAssetLink {
  storyboardId: string
  assetId: string
  role: string
}

/** 括号注记是修辞不是身份：「林小雨(主角)」与「林小雨」是同一个人。 */
export function normalizeAssetName(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
}

/**
 * 不是实景的地点。字卡/黑屏是排版，空间/播放器/新项目/真实 UI 是合成画面：
 * 它们不该有「场景主帧」，也不该去匹配场景素材。
 */
const NON_SET_LOCATIONS = new Set(['黑屏', '字卡', '空间', '播放器', '新项目', '真实ui'])

function locationKey(location: string): string {
  return location.toLowerCase().replace(/\s+/g, '')
}

export function isSetLocation(location: string | null | undefined): boolean {
  const key = locationKey(location?.trim() ?? '')
  return key !== '' && !NON_SET_LOCATIONS.has(key)
}

function locationMatches(location: string, assetName: string): boolean {
  if (!isSetLocation(location)) return false
  const place = locationKey(location)
  const name = locationKey(assetName)
  return name.length >= 2 && (place.includes(name) || name.includes(place))
}

const PRONOUN = /[他她]/

/**
 * 按「点名 > 地点 > 单角色代词」建立绑定。返回的每一对 (镜头, 素材) 只出现一次。
 *
 * - 名字：台词与说话人也算——说话的人就是出场的人（[小满] 的台词该绑小满）。
 * - 地点：剧本分镜表的场景列（卧室/楼道/字卡…）命中场景素材名。这是分镜表
 *   已经写死的事实，比在描述里碰运气找地名可靠。
 * - 代词：画面文本用「他/她」、全集又只有一个角色时，指代没有第二种解释。
 *   多角色剧本不猜。
 */
export function matchShotAssetLinks(shots: LinkableShot[], assets: LinkableAsset[]): ShotAssetLink[] {
  const named = assets
    .map(asset => ({ ...asset, normalizedName: normalizeAssetName(asset.name) }))
    .filter(asset => asset.normalizedName.length >= 2)
  const characters = named.filter(asset => asset.kind === 'character')
  const soleCharacter = characters.length === 1 ? characters[0]! : null

  const links: ShotAssetLink[] = []
  for (const shot of shots) {
    const visual = `${shot.title} ${shot.description}`
    const all = `${visual} ${shot.dialogue} ${shot.speaker ?? ''}`
    const location = shot.location?.trim() ?? ''
    const seen = new Set<string>()
    for (const asset of named) {
      if (seen.has(asset.id)) continue
      const byName = all.includes(asset.normalizedName)
      const matched = asset.kind === 'scene'
        ? byName || locationMatches(location, asset.normalizedName)
        : asset.kind === 'character'
          ? byName || (PRONOUN.test(visual) && soleCharacter?.id === asset.id)
          : byName
      if (!matched) continue
      seen.add(asset.id)
      links.push({ storyboardId: shot.id, assetId: asset.id, role: asset.kind })
    }
  }
  return links
}

/**
 * 这一镜的画面该不该带上这个素材。场景是基调恒可见；角色/道具按画面文本
 * （标题+描述）点名；单角色剧目允许「他/她」回退。只在台词/说话人里出现的
 * 角色是画外音——送了定妆照反而会诱导模型把不入场的人画进画面。
 *
 * 与 matchShotAssetLinks 的分工：那边决定「这一镜和谁有关」，这边决定
 * 「这一帧里会看到谁」。绑定可以因为台词发生，参考图不能。
 */
export function isShotVisible(asset: LinkableAsset, visualText: string, soleCharacterId: string | null): boolean {
  if (asset.kind === 'scene') return true
  if (visualText.includes(normalizeAssetName(asset.name))) return true
  return asset.kind === 'character' && soleCharacterId === asset.id && PRONOUN.test(visualText)
}
