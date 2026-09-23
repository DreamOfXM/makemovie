/**
 * 官方风格幂等种子
 * 确保 8 个官方风格存在于数据库，满足 Project.stylePresetId 外键约束
 */

import type { PrismaClient } from '@studio/db'
import { OFFICIAL_STYLES } from './styles/index.js'

export async function seedOfficialStyles(db: PrismaClient): Promise<void> {
  for (const style of OFFICIAL_STYLES) {
    await db.stylePreset.upsert({
      where: { id: style.id },
      update: {},
      create: {
        id: style.id,
        name: style.name,
        description: style.description,
        visualStyle: style.visualStyle,
        tone: style.tone ?? null,
        colorPalette: style.colorPalette ?? null,
        cameraStyle: style.cameraStyle ?? null,
        extraPrompt: style.extraPrompt ?? null,
        isOfficial: true,
        organizationId: null,
      },
    })
  }
}
