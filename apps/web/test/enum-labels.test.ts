import { describe, expect, it } from 'vitest'
import { capabilitySlots, contentLocales, generationStages, modelModalities, workflowStatuses } from '@studio/domain'
import { dictionaries, translateEnum, type Locale } from '@/lib/i18n'

/**
 * 枚举上屏的词根守卫（SD-077 / #254 同族）。
 * `translateEnum` 在字典缺条目时**原样返回枚举值**（i18n.tsx:4934），所以「槽位下拉里出现
 * `audio_transcribe`」这类泄漏不需要任何代码写错——只要新增一个枚举值时少写一门语言的文案，
 * 界面就自己把内部标识符画出来。台账 #254 怀疑就绪度面板漏了 `audio_transcribe`：本轮逐条
 * 数过，11 个槽位在中英两本字典里都有条目，**该次不成立**；但漏口的形状是真的，所以钉在这里。
 * 判据只锁「屏幕上的那串是不是原始枚举字面量」，不锁具体译法——改成别的说法不算红。
 */
const ENUM_ON_SCREEN: { prefix: string; values: readonly string[] }[] = [
  { prefix: 'slots', values: capabilitySlots },
  { prefix: 'generations.stage', values: generationStages },
  { prefix: 'status', values: workflowStatuses },
  { prefix: 'projects.contentLocale', values: contentLocales },
  { prefix: 'modality', values: modelModalities },
]

/** 小写英文蛇形（`audio_transcribe` 的形状）出现在中文界面上就是泄漏；`text→video` 不算。 */
const RAW_ENUM = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/

describe('枚举值上屏必须有译名，不许露原始标识符', () => {
  for (const { prefix, values } of ENUM_ON_SCREEN) {
    for (const locale of Object.keys(dictionaries) as Locale[]) {
      it(`${prefix} 的 ${values.length} 个值在 ${locale} 里都有非原文条目`, () => {
        for (const value of values) {
          const label = dictionaries[locale][`${prefix}.${value}`]
          // 缺条目 = translateEnum 回落成 `audio_transcribe` 这种内部标识符直接上屏。
          expect(label, `${prefix}.${value} missing from ${locale}`).toBeTruthy()
          if (locale === 'zh') expect(RAW_ENUM.test(label), `${prefix}.${value} renders raw enum "${label}" in Chinese`).toBe(false)
        }
      })
    }
  }

  it('守的是字典条目本身：少一门语言立刻红（闸门可失败性实证）', () => {
    // 这里不造假数据——直接借一条真实存在的键名反证：把前缀换成没人写过的，
    // translateEnum 就必须把枚举值原样吐回屏幕，而这正是本守卫要拦的形状。
    const leaked = translateEnum((key: string) => (dictionaries.zh[key] ?? key) as string, 'slots', 'no_such_slot_yet')
    expect(leaked).toBe('no_such_slot_yet')
    expect(RAW_ENUM.test(leaked)).toBe(true)
  })
})
