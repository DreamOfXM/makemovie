/**
 * Node System - Main Export
 *
 * @example
 * import { getNode, NodeType, registerCustomNode } from './nodes';
 *
 * // Get an official node
 * const node = getNode(NodeType.STORYBOARD);
 *
 * // Register custom node
 * registerCustomNode({
 *   type: 'my_custom_node',
 *   name: 'My Custom Node',
 *   description: 'A custom processing node',
 *   defaultInputs: [],
 *   defaultOutputs: [],
 *   create: (config) => ({ ... }),
 * });
 */

export {
  NodeType,
  NodeInput,
  NodeOutput,
  NodeConfig,
  PipelineNode,
  NodeFactory,
  NodeDefinition,
} from './types.js';

export {
  OFFICIAL_NODES,
  registerCustomNode,
  unregisterCustomNode,
  getNode,
  listNodes,
  getNodeDefinition,
} from './registry.js';
