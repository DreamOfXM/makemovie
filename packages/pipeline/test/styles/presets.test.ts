/**
 * Style Presets 单元测试
 *
 * 测试风格预设系统的核心功能：
 * - 获取官方风格列表
 * - 根据 ID 获取风格
 * - 验证风格 ID
 * - 获取风格视觉描述
 * - 获取风格氛围语气
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  getOfficialStyles,
  getStyleById,
  isValidStyleId,
  getStyleVisualDirective,
  getStyleToneDirective,
  registerCustomStyle,
  unregisterCustomStyle,
  getAllStyles,
  StylePreset,
} from '../../src/styles/index.js'

describe('StylePreset', () => {
  describe('getOfficialStyles', () => {
    it('should return all official styles', () => {
      const styles = getOfficialStyles()
      expect(styles.length).toBe(8)
    })

    it('should contain expected style IDs', () => {
      const styles = getOfficialStyles()
      const ids = styles.map(s => s.id)
      expect(ids).toContain('realistic')
      expect(ids).toContain('cinematic')
      expect(ids).toContain('animation')
      expect(ids).toContain('anime')
      expect(ids).toContain('noir')
      expect(ids).toContain('sci-fi')
      expect(ids).toContain('fantasy')
      expect(ids).toContain('commercial')
    })

    it('should have all styles marked as official', () => {
      const styles = getOfficialStyles()
      styles.forEach(style => {
        expect(style.isOfficial).toBe(true)
      })
    })

    it('should have required fields for each style', () => {
      const styles = getOfficialStyles()
      styles.forEach(style => {
        expect(style.id).toBeDefined()
        expect(style.name).toBeDefined()
        expect(style.description).toBeDefined()
        expect(style.isOfficial).toBe(true)
        expect(style.visualStyle).toBeDefined()
        expect(style.tone).toBeDefined()
      })
    })
  })

  describe('getStyleById', () => {
    it('should return style for valid ID', () => {
      const style = getStyleById('cinematic')
      expect(style).toBeDefined()
      expect(style?.name).toBe('电影感')
    })

    it('should return undefined for invalid ID', () => {
      const style = getStyleById('non-existent-style')
      expect(style).toBeUndefined()
    })

    it('should return correct visual style', () => {
      const style = getStyleById('anime')
      expect(style?.visualStyle).toContain('anime style')
      expect(style?.visualStyle).toContain('Studio Ghibli')
    })

    it('should return correct tone', () => {
      const style = getStyleById('noir')
      expect(style?.tone).toContain('神秘')
      expect(style?.tone).toContain('复古')
    })

    it('should return correct color palette when defined', () => {
      const style = getStyleById('anime')
      expect(style?.colorPalette).toBeDefined()
      expect(style?.colorPalette).toContain('anime color palette')
    })

    it('should return correct camera style when defined', () => {
      const style = getStyleById('cinematic')
      expect(style?.cameraStyle).toBeDefined()
      expect(style?.cameraStyle).toContain('cinematic composition')
    })

    it('should return extra prompt when defined', () => {
      const style = getStyleById('sci-fi')
      expect(style?.extraPrompt).toBeDefined()
      expect(style?.extraPrompt).toContain('futuristic')
    })
  })

  describe('isValidStyleId', () => {
    it('should return true for official style IDs', () => {
      expect(isValidStyleId('realistic')).toBe(true)
      expect(isValidStyleId('cinematic')).toBe(true)
      expect(isValidStyleId('anime')).toBe(true)
    })

    it('should return false for invalid IDs', () => {
      expect(isValidStyleId('invalid')).toBe(false)
      expect(isValidStyleId('')).toBe(false)
      expect(isValidStyleId('REALISTIC')).toBe(false) // case sensitive
    })

    it('should return false for custom style before registration', () => {
      // 确保测试隔离：先清理可能存在的自定义风格
      unregisterCustomStyle('test-custom-style')
      expect(isValidStyleId('test-custom-style')).toBe(false)
    })

    it('should return true for registered custom style', () => {
      const customStyle: StylePreset = {
        id: 'test-custom-style',
        name: '测试风格',
        description: '用于测试的自定义风格',
        isOfficial: false,
        visualStyle: 'test style',
        tone: '测试氛围',
      }

      registerCustomStyle(customStyle)
      expect(isValidStyleId('test-custom-style')).toBe(true)

      // 清理
      unregisterCustomStyle('test-custom-style')
    })
  })

  describe('getStyleVisualDirective', () => {
    it('should return visual style for IMAGE stage', () => {
      const style = getStyleById('cinematic')!
      const directive = getStyleVisualDirective(style, 'IMAGE')
      expect(directive).toContain('cinematic')
      expect(directive).toContain('film grain')
    })

    it('should return visual style for VIDEO stage', () => {
      const style = getStyleById('anime')!
      const directive = getStyleVisualDirective(style, 'VIDEO')
      expect(directive).toContain('anime style')
    })

    it('should include color palette when defined', () => {
      const style = getStyleById('sci-fi')!
      const directive = getStyleVisualDirective(style, 'IMAGE')
      expect(directive).toContain('neon')
      expect(directive).toContain('cyberpunk colors')
    })

    it('should include camera style when defined', () => {
      const style = getStyleById('commercial')!
      const directive = getStyleVisualDirective(style, 'VIDEO')
      expect(directive).toContain('commercial cinematography')
      expect(directive).toContain('studio quality')
    })

    it('should include extra prompt when defined', () => {
      const style = getStyleById('fantasy')!
      const directive = getStyleVisualDirective(style, 'IMAGE')
      expect(directive).toContain('epic fantasy')
      expect(directive).toContain('mystical lighting')
    })

    it('should return at least visual style for styles without optional fields', () => {
      // realistic 应该有所有可选字段
      const style = getStyleById('realistic')!
      const directive = getStyleVisualDirective(style, 'IMAGE')
      expect(directive).toContain('photorealistic')
    })
  })

  describe('getStyleToneDirective', () => {
    it('should return tone for each style', () => {
      const noir = getStyleById('noir')!
      expect(getStyleToneDirective(noir)).toContain('神秘')

      const animation = getStyleById('animation')!
      expect(getStyleToneDirective(animation)).toContain('活泼')
    })
  })

  describe('Custom Style Registration', () => {
    const testStyle: StylePreset = {
      id: 'test-register-style',
      name: '测试注册',
      description: '测试用风格',
      isOfficial: false,
      visualStyle: 'test visual',
      tone: 'test tone',
      colorPalette: 'test colors',
    }

    afterEach(() => {
      // 清理测试数据
      unregisterCustomStyle('test-register-style')
    })

    it('should register custom style', () => {
      registerCustomStyle(testStyle)
      const style = getStyleById('test-register-style')
      expect(style).toBeDefined()
      expect(style?.name).toBe('测试注册')
    })

    it('should get custom style via getAllStyles', () => {
      registerCustomStyle(testStyle)
      const allStyles = getAllStyles()
      const customStyle = allStyles.find(s => s.id === 'test-register-style')
      expect(customStyle).toBeDefined()
    })

    it('should throw when registering duplicate ID', () => {
      registerCustomStyle(testStyle)
      expect(() => registerCustomStyle(testStyle)).toThrow('already exists')
    })

    it('should unregister custom style', () => {
      registerCustomStyle(testStyle)
      const result = unregisterCustomStyle('test-register-style')
      expect(result).toBe(true)
      expect(getStyleById('test-register-style')).toBeUndefined()
    })

    it('should return false when unregistering non-existent style', () => {
      const result = unregisterCustomStyle('non-existent')
      expect(result).toBe(false)
    })

    it('should allow re-registering after unregister', () => {
      registerCustomStyle(testStyle)
      unregisterCustomStyle('test-register-style')
      expect(() => registerCustomStyle(testStyle)).not.toThrow()
    })
  })

  describe('StylePreset Interface', () => {
    it('should have 8 official styles with unique IDs', () => {
      const styles = getOfficialStyles()
      const ids = styles.map(s => s.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })

    it('should have styles covering different use cases', () => {
      const realistic = getStyleById('realistic')
      const cinematic = getStyleById('cinematic')
      const anime = getStyleById('anime')
      const commercial = getStyleById('commercial')

      expect(realistic?.description).toContain('纪录片')
      expect(cinematic?.description).toContain('剧情片')
      expect(anime?.description).toContain('二次元')
      expect(commercial?.description).toContain('品牌')
    })
  })
})
