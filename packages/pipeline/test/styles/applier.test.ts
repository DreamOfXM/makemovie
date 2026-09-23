/**
 * Style Applier 单元测试
 *
 * 测试风格如何应用到各环节的 prompt
 */

import { describe, it, expect } from 'vitest'
import {
  isStageAffectedByStyle,
  applyStyleToPrompt,
  applyStyleToPrompts,
  getStyleDisplayName,
  validateStyle,
} from '../../src/styles/index.js'

describe('StyleApplier', () => {
  describe('isStageAffectedByStyle', () => {
    it('should return true for STORYBOARD stage', () => {
      expect(isStageAffectedByStyle('STORYBOARD')).toBe(true)
    })

    it('should return true for IMAGE stage', () => {
      expect(isStageAffectedByStyle('IMAGE')).toBe(true)
    })

    it('should return true for VIDEO stage', () => {
      expect(isStageAffectedByStyle('VIDEO')).toBe(true)
    })

    it('should return false for SCRIPT stage', () => {
      expect(isStageAffectedByStyle('SCRIPT')).toBe(false)
    })

    it('should return false for ASSET stage', () => {
      expect(isStageAffectedByStyle('ASSET')).toBe(false)
    })

    it('should return false for AUDIO stage', () => {
      expect(isStageAffectedByStyle('AUDIO')).toBe(false)
    })

    it('should return false for MUSIC stage', () => {
      expect(isStageAffectedByStyle('MUSIC')).toBe(false)
    })
  })

  describe('applyStyleToPrompt', () => {
    const originalPrompt = '这是一个测试 prompt'

    it('should add tone directive to STORYBOARD stage', () => {
      const result = applyStyleToPrompt('STORYBOARD', originalPrompt, {
        id: 'cinematic',
        name: '电影感',
        nameEn: 'Cinematic',
        description: '电影级别',
        isOfficial: true,
        visualStyle: 'cinematic, film grain',
        tone: '戏剧化、有张力',
      })

      expect(result).toContain(originalPrompt)
      expect(result).toContain('风格要求：')
      expect(result).toContain('戏剧化')
    })

    it('should add visual directive to IMAGE stage', () => {
      const result = applyStyleToPrompt('IMAGE', originalPrompt, {
        id: 'anime',
        name: '动漫风',
        nameEn: 'Anime',
        description: '日式动漫',
        isOfficial: true,
        visualStyle: 'anime style, Studio Ghibli',
        tone: '情感细腻',
      })

      expect(result).toContain(originalPrompt)
      expect(result).toContain('视觉风格：')
      expect(result).toContain('anime style')
    })

    it('should add visual directive to VIDEO stage', () => {
      const result = applyStyleToPrompt('VIDEO', originalPrompt, {
        id: 'sci-fi',
        name: '科幻风',
        nameEn: 'Sci-Fi',
        description: '未来科技',
        isOfficial: true,
        visualStyle: 'sci-fi, cyberpunk, neon',
        tone: '未来感',
      })

      expect(result).toContain(originalPrompt)
      expect(result).toContain('视觉风格：')
      expect(result).toContain('sci-fi')
    })

    it('should not modify prompt for non-affected stages', () => {
      const result = applyStyleToPrompt('SCRIPT', originalPrompt, {
        id: 'cinematic',
        name: '电影感',
        nameEn: 'Cinematic',
        description: '电影级别',
        isOfficial: true,
        visualStyle: 'cinematic',
        tone: '戏剧化',
      })

      expect(result).toBe(originalPrompt)
    })

    it('should include color palette when defined', () => {
      const result = applyStyleToPrompt('IMAGE', originalPrompt, {
        id: 'noir',
        name: '黑白',
        nameEn: 'Noir',
        description: '黑白电影',
        isOfficial: true,
        visualStyle: 'black and white',
        tone: '神秘',
        colorPalette: 'high contrast',
      })

      expect(result).toContain('high contrast')
    })

    it('should include camera style when defined', () => {
      const result = applyStyleToPrompt('VIDEO', originalPrompt, {
        id: 'commercial',
        name: '商业广告',
        nameEn: 'Commercial',
        description: '商业级别',
        isOfficial: true,
        visualStyle: 'commercial quality',
        tone: '专业',
        cameraStyle: 'studio lighting',
      })

      expect(result).toContain('studio lighting')
    })

    it('should include extra prompt when defined', () => {
      const result = applyStyleToPrompt('IMAGE', originalPrompt, {
        id: 'fantasy',
        name: '奇幻风',
        nameEn: 'Fantasy',
        description: '魔法与奇幻',
        isOfficial: true,
        visualStyle: 'fantasy art',
        tone: '史诗感',
        extraPrompt: 'magical atmosphere',
      })

      expect(result).toContain('magical atmosphere')
    })
  })

  describe('applyStyleToPrompts', () => {
    it('should apply style to multiple stages', () => {
      const prompts = {
        SCRIPT: '原始剧本 prompt',
        STORYBOARD: '原始分镜 prompt',
        IMAGE: '原始图像 prompt',
        VIDEO: '原始视频 prompt',
        AUDIO: '原始配音 prompt',
      }

      const result = applyStyleToPrompts(prompts, {
        id: 'cinematic',
        name: '电影感',
        nameEn: 'Cinematic',
        description: '电影级别',
        isOfficial: true,
        visualStyle: 'cinematic style',
        tone: '戏剧化',
      })

      // SCRIPT 不受影响
      expect(result.SCRIPT).toBe('原始剧本 prompt')

      // STORYBOARD 追加了风格
      expect(result.STORYBOARD).toContain('风格要求：')

      // IMAGE 追加了风格
      expect(result.IMAGE).toContain('视觉风格：')

      // VIDEO 追加了风格
      expect(result.VIDEO).toContain('视觉风格：')

      // AUDIO 不受影响
      expect(result.AUDIO).toBe('原始配音 prompt')
    })

    it('should handle partial prompts', () => {
      const prompts = {
        STORYBOARD: '分镜 prompt',
        VIDEO: '视频 prompt',
      }

      const result = applyStyleToPrompts(prompts, {
        id: 'anime',
        name: '动漫风',
        nameEn: 'Anime',
        description: '日式动漫',
        isOfficial: true,
        visualStyle: 'anime style',
        tone: '情感细腻',
      })

      expect(Object.keys(result)).toHaveLength(2)
      expect(result.STORYBOARD).toContain('情感细腻')
      expect(result.VIDEO).toContain('anime style')
    })
  })

  describe('getStyleDisplayName', () => {
    it('should return style name for valid ID', () => {
      expect(getStyleDisplayName('cinematic')).toBe('电影感')
    })

    it('should return ID for invalid style', () => {
      expect(getStyleDisplayName('invalid-style')).toBe('invalid-style')
    })
  })

  describe('validateStyle', () => {
    it('should return style for valid ID', () => {
      const result = validateStyle('cinematic')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('cinematic')
    })

    it('should return null for invalid ID', () => {
      const result = validateStyle('invalid-style')
      expect(result).toBeNull()
    })

    it('should throw for invalid ID when throwIfInvalid is true', () => {
      expect(() => validateStyle('invalid-style', true)).toThrow('Invalid style')
    })

    it('should not throw for valid ID', () => {
      expect(() => validateStyle('anime', true)).not.toThrow()
    })
  })
})
