import { describe, expect, it } from 'vitest'
import { ASSET_LAYOUT_BLOCKS_BY_KIND, ASSET_REFERENCE_SPECS_BY_KIND, assetLayoutChecklist, assetLayoutLock } from '../src/index.js'

/**
 * 素材板版式（SD-041 / SD-042）的单一真源：生成端把版式规格写进 prompt、把锁句压在
 * 自由文字之后，审核端从同一张表反查该核对哪些区块。2026-10-21 的一次调整要求把
 * 五区块角色板打回一张裸半身照，裸半身照与齐全的角色板又拿到同分同空 findings，
 * 两处都靠这份表兜住。这里的断言保证：清单逐条出自规格原文（不是另编一套）、
 * 认不出的 kind 不拿猜出来的清单拦人、锁句点名全部区块并限死调整要求的边界。
 */
describe('素材板版式清单与版式锁（SD-041 / SD-042）', () => {
  it('角色板五项逐字出自规格，场景/道具的版式项也都能在规格里找到', () => {
    // 角色板的五项是原文切片，连编号都能对回规格——2026-10-21 被打回裸半身照的就是这五项。
    for (const block of ASSET_LAYOUT_BLOCKS_BY_KIND.character!) expect(ASSET_REFERENCE_SPECS_BY_KIND.character).toContain(block)
    expect(ASSET_LAYOUT_BLOCKS_BY_KIND.character).toHaveLength(5)
    for (const kind of ['scene', 'prop'] as const) {
      const spec = ASSET_REFERENCE_SPECS_BY_KIND[kind]
      for (const block of ASSET_LAYOUT_BLOCKS_BY_KIND[kind]!) {
        // 文字/水印一条由生成时追加的文字规则兜住，规格行不一定复述；其余版式项必须出自规格。
        if (block.includes('文字')) continue
        for (const part of block.split('与')) expect(spec, `${kind}: ${block}`).toContain(part)
      }
    }
  })

  it('认不出的 kind 返回空清单，也不生成锁句', () => {
    expect(assetLayoutChecklist(null)).toEqual([])
    expect(assetLayoutChecklist(undefined)).toEqual([])
    expect(assetLayoutChecklist('costume')).toEqual([])
    expect(assetLayoutLock(null)).toBeNull()
    expect(assetLayoutLock('costume')).toBeNull()
  })

  it('锁句点名每一个区块，并把调整要求限制在内容与质感', () => {
    const lock = assetLayoutLock('character')
    expect(lock).toContain('版式锁定（最高优先级，不随调整要求改变）')
    expect(lock).toContain('仍是一张角色设定板')
    for (const block of ASSET_LAYOUT_BLOCKS_BY_KIND.character!) expect(lock).toContain(block)
    expect(lock).toContain('调整要求只允许改画面内容与质感')
    expect(lock).toContain('不得增删区块、不得改成单张剧照')
  })

  it('场景与道具各用自己那份规格，不共用角色板的五个区块', () => {
    const scene = assetLayoutLock('scene')!
    expect(scene).toContain('仍是一张场景概念图')
    expect(scene).not.toContain('全身三视图')
    const prop = assetLayoutLock('prop')!
    expect(prop).toContain('仍是一张道具设定图')
    expect(prop).toContain('单品居中')
    expect(prop).not.toContain('表情参考')
  })
})
