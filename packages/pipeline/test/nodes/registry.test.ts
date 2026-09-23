/**
 * Node Registry 单元测试
 *
 * 测试节点注册表的核心功能：
 * - 获取官方节点
 * - 根据类型获取节点
 * - 注册自定义节点
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  getNode,
  listNodes,
  getNodeDefinition,
  registerCustomNode,
  unregisterCustomNode,
  OFFICIAL_NODES,
  NodeType,
} from '../../src/nodes/index.js'

describe('NodeRegistry', () => {
  describe('getNode', () => {
    it('should return node for valid type', () => {
      const node = getNode('script_understanding')
      expect(node).toBeDefined()
      expect(node.type).toBe('script_understanding')
    })

    it('should throw for invalid type', () => {
      expect(() => getNode('invalid_type')).toThrow('Unknown node type')
    })

    it('should return all official nodes', () => {
      const allNodes = listNodes()
      expect(allNodes.length).toBeGreaterThan(0)
    })
  })

  describe('listNodes', () => {
    it('should list all official node types', () => {
      const nodes = listNodes()
      expect(nodes).toContain('source_input')
      expect(nodes).toContain('script_understanding')
      expect(nodes).toContain('storyboard')
      expect(nodes).toContain('video_generation')
    })
  })

  describe('getNodeDefinition', () => {
    it('should return definition for valid type', () => {
      const def = getNodeDefinition('storyboard')
      expect(def).toBeDefined()
      expect(def?.type).toBe('storyboard')
    })

    it('should return undefined for invalid type', () => {
      const def = getNodeDefinition('invalid_type')
      expect(def).toBeUndefined()
    })
  })

  describe('OFFICIAL_NODES', () => {
    it('should have 9 official nodes', () => {
      expect(Object.keys(OFFICIAL_NODES).length).toBe(9)
    })

    it('should have all required node types', () => {
      const requiredTypes = [
        'source_input',
        'script_understanding',
        'storyboard',
        'asset_generation',
        'frame_generation',
        'video_generation',
        'voice_generation',
        'music_generation',
        'composition',
      ]

      requiredTypes.forEach(type => {
        expect(OFFICIAL_NODES[type as NodeType]).toBeDefined()
      })
    })

    it('should have required fields for each node', () => {
      Object.values(OFFICIAL_NODES).forEach(node => {
        expect(node.type).toBeDefined()
        expect(node.name).toBeDefined()
        expect(node.description).toBeDefined()
        expect(node.defaultInputs).toBeDefined()
        expect(node.defaultOutputs).toBeDefined()
        expect(node.create).toBeDefined()
      })
    })
  })

  describe('Custom Node Registration', () => {
    const customNode = {
      type: 'custom_test_node' as const,
      name: 'Custom Test Node',
      description: 'A test node for unit testing',
      defaultInputs: [],
      defaultOutputs: [],
      create: () => ({
        id: 'test',
        type: 'custom_test_node',
        name: 'Custom Test Node',
        description: 'A test node',
        inputs: [],
        outputs: [],
      }),
    }

    afterEach(() => {
      unregisterCustomNode('custom_test_node')
    })

    it('should register custom node', () => {
      registerCustomNode(customNode)
      const def = getNodeDefinition('custom_test_node')
      expect(def).toBeDefined()
      expect(def?.name).toBe('Custom Test Node')
    })

    it('should return custom node in listNodes', () => {
      registerCustomNode(customNode)
      const allNodes = listNodes()
      expect(allNodes).toContain('custom_test_node')
    })

    it('should unregister custom node', () => {
      registerCustomNode(customNode)
      const result = unregisterCustomNode('custom_test_node')
      expect(result).toBe(true)
      expect(getNodeDefinition('custom_test_node')).toBeUndefined()
    })

    it('should return false when unregistering non-existent node', () => {
      const result = unregisterCustomNode('non_existent_node')
      expect(result).toBe(false)
    })

    it('should throw when overriding official node', () => {
      expect(() => registerCustomNode({
        ...customNode,
        type: 'storyboard' as const,
      })).toThrow('Cannot override official node type')
    })
  })

  describe('Node Structure', () => {
    it('should have proper inputs/outputs structure', () => {
      const node = getNode('storyboard')
      expect(node.inputs).toBeDefined()
      expect(node.outputs).toBeDefined()
      expect(Array.isArray(node.inputs)).toBe(true)
      expect(Array.isArray(node.outputs)).toBe(true)
    })

    it('should have proper config structure', () => {
      const node = getNode('script_understanding', { custom: 'value' })
      expect(node.config).toBeDefined()
    })
  })
})
