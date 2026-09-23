/**
 * Node Registry for makemovie pipeline
 */

import {
  NodeType,
  NodeInput,
  NodeOutput,
  NodeConfig,
  PipelineNode,
  NodeDefinition,
} from './types.js';

/** Default inputs for each node type */
const defaultInputs: Record<NodeType, NodeInput[]> = {
  [NodeType.SOURCE_INPUT]: [],
  [NodeType.SCRIPT_UNDERSTANDING]: [
    { id: 'source', name: 'Source Document', required: true, type: 'text' },
  ],
  [NodeType.STORYBOARD]: [
    { id: 'script', name: 'Script', required: true, type: 'text' },
  ],
  [NodeType.ASSET_GENERATION]: [
    { id: 'storyboard', name: 'Storyboard', required: true, type: 'json' },
  ],
  [NodeType.FRAME_GENERATION]: [
    { id: 'assets', name: 'Assets', required: true, type: 'json' },
  ],
  [NodeType.VIDEO_GENERATION]: [
    { id: 'frames', name: 'Frames', required: true, type: 'json' },
    { id: 'voiceover', name: 'Voiceover', required: false, type: 'audio' },
  ],
  [NodeType.VOICE_GENERATION]: [
    { id: 'script', name: 'Script', required: true, type: 'text' },
  ],
  [NodeType.MUSIC_GENERATION]: [
    { id: 'duration', name: 'Duration', required: true, type: 'number' },
  ],
  [NodeType.COMPOSITION]: [
    { id: 'clips', name: 'Video Clips', required: true, type: 'json' },
    { id: 'voiceover', name: 'Voiceover', required: false, type: 'audio' },
    { id: 'music', name: 'Background Music', required: false, type: 'audio' },
  ],
};

/** Default outputs for each node type */
const defaultOutputs: Record<NodeType, NodeOutput[]> = {
  [NodeType.SOURCE_INPUT]: [
    { id: 'source', name: 'Source Document', type: 'text' },
  ],
  [NodeType.SCRIPT_UNDERSTANDING]: [
    { id: 'script', name: 'Script', type: 'text' },
    { id: 'metadata', name: 'Metadata', type: 'json' },
  ],
  [NodeType.STORYBOARD]: [
    { id: 'shots', name: 'Shots', type: 'json' },
    { id: 'shot_count', name: 'Shot Count', type: 'number' },
  ],
  [NodeType.ASSET_GENERATION]: [
    { id: 'characters', name: 'Characters', type: 'json' },
    { id: 'scenes', name: 'Scenes', type: 'json' },
  ],
  [NodeType.FRAME_GENERATION]: [
    { id: 'frames', name: 'Frames', type: 'json' },
  ],
  [NodeType.VIDEO_GENERATION]: [
    { id: 'clip', name: 'Video Clip', type: 'video' },
    { id: 'metadata', name: 'Clip Metadata', type: 'json' },
  ],
  [NodeType.VOICE_GENERATION]: [
    { id: 'audio', name: 'Audio', type: 'audio' },
    { id: 'duration', name: 'Duration', type: 'number' },
  ],
  [NodeType.MUSIC_GENERATION]: [
    { id: 'audio', name: 'Audio', type: 'audio' },
    { id: 'duration', name: 'Duration', type: 'number' },
  ],
  [NodeType.COMPOSITION]: [
    { id: 'video', name: 'Final Video', type: 'video' },
    { id: 'metadata', name: 'Output Metadata', type: 'json' },
  ],
};

/** Node metadata for official nodes */
const nodeMetadata: Record<NodeType, { name: string; description: string }> = {
  [NodeType.SOURCE_INPUT]: {
    name: 'Source Input',
    description: 'Raw source document input - accepts text, markdown, or URL content',
  },
  [NodeType.SCRIPT_UNDERSTANDING]: {
    name: 'Script Understanding',
    description: 'Analyze and convert source content into structured script',
  },
  [NodeType.STORYBOARD]: {
    name: 'Storyboard',
    description: 'Split script into individual shots with visual descriptions',
  },
  [NodeType.ASSET_GENERATION]: {
    name: 'Asset Generation',
    description: 'Generate character designs and scene backgrounds',
  },
  [NodeType.FRAME_GENERATION]: {
    name: 'Frame Generation',
    description: 'Generate thumbnail images for each shot',
  },
  [NodeType.VIDEO_GENERATION]: {
    name: 'Video Generation',
    description: 'Generate video clips from frames with optional voiceover',
  },
  [NodeType.VOICE_GENERATION]: {
    name: 'Voice Generation',
    description: 'Generate voiceover audio from script text',
  },
  [NodeType.MUSIC_GENERATION]: {
    name: 'Music Generation',
    description: 'Generate background music track',
  },
  [NodeType.COMPOSITION]: {
    name: 'Composition',
    description: 'Compose final video with clips, voiceover, and music',
  },
};

/** Create a pipeline node instance */
function createNode(type: NodeType, config?: NodeConfig): PipelineNode {
  const meta = nodeMetadata[type];
  return {
    id: `${type}_${Date.now()}`,
    type,
    name: meta.name,
    description: meta.description,
    inputs: defaultInputs[type] || [],
    outputs: defaultOutputs[type] || [],
    config,
  };
}

/** Official node definitions */
export const OFFICIAL_NODES: Record<NodeType, NodeDefinition> = {
  [NodeType.SOURCE_INPUT]: {
    type: NodeType.SOURCE_INPUT,
    name: nodeMetadata[NodeType.SOURCE_INPUT].name,
    description: nodeMetadata[NodeType.SOURCE_INPUT].description,
    defaultInputs: defaultInputs[NodeType.SOURCE_INPUT],
    defaultOutputs: defaultOutputs[NodeType.SOURCE_INPUT],
    create: (config) => createNode(NodeType.SOURCE_INPUT, config),
  },
  [NodeType.SCRIPT_UNDERSTANDING]: {
    type: NodeType.SCRIPT_UNDERSTANDING,
    name: nodeMetadata[NodeType.SCRIPT_UNDERSTANDING].name,
    description: nodeMetadata[NodeType.SCRIPT_UNDERSTANDING].description,
    defaultInputs: defaultInputs[NodeType.SCRIPT_UNDERSTANDING],
    defaultOutputs: defaultOutputs[NodeType.SCRIPT_UNDERSTANDING],
    create: (config) => createNode(NodeType.SCRIPT_UNDERSTANDING, config),
  },
  [NodeType.STORYBOARD]: {
    type: NodeType.STORYBOARD,
    name: nodeMetadata[NodeType.STORYBOARD].name,
    description: nodeMetadata[NodeType.STORYBOARD].description,
    defaultInputs: defaultInputs[NodeType.STORYBOARD],
    defaultOutputs: defaultOutputs[NodeType.STORYBOARD],
    create: (config) => createNode(NodeType.STORYBOARD, config),
  },
  [NodeType.ASSET_GENERATION]: {
    type: NodeType.ASSET_GENERATION,
    name: nodeMetadata[NodeType.ASSET_GENERATION].name,
    description: nodeMetadata[NodeType.ASSET_GENERATION].description,
    defaultInputs: defaultInputs[NodeType.ASSET_GENERATION],
    defaultOutputs: defaultOutputs[NodeType.ASSET_GENERATION],
    create: (config) => createNode(NodeType.ASSET_GENERATION, config),
  },
  [NodeType.FRAME_GENERATION]: {
    type: NodeType.FRAME_GENERATION,
    name: nodeMetadata[NodeType.FRAME_GENERATION].name,
    description: nodeMetadata[NodeType.FRAME_GENERATION].description,
    defaultInputs: defaultInputs[NodeType.FRAME_GENERATION],
    defaultOutputs: defaultOutputs[NodeType.FRAME_GENERATION],
    create: (config) => createNode(NodeType.FRAME_GENERATION, config),
  },
  [NodeType.VIDEO_GENERATION]: {
    type: NodeType.VIDEO_GENERATION,
    name: nodeMetadata[NodeType.VIDEO_GENERATION].name,
    description: nodeMetadata[NodeType.VIDEO_GENERATION].description,
    defaultInputs: defaultInputs[NodeType.VIDEO_GENERATION],
    defaultOutputs: defaultOutputs[NodeType.VIDEO_GENERATION],
    create: (config) => createNode(NodeType.VIDEO_GENERATION, config),
  },
  [NodeType.VOICE_GENERATION]: {
    type: NodeType.VOICE_GENERATION,
    name: nodeMetadata[NodeType.VOICE_GENERATION].name,
    description: nodeMetadata[NodeType.VOICE_GENERATION].description,
    defaultInputs: defaultInputs[NodeType.VOICE_GENERATION],
    defaultOutputs: defaultOutputs[NodeType.VOICE_GENERATION],
    create: (config) => createNode(NodeType.VOICE_GENERATION, config),
  },
  [NodeType.MUSIC_GENERATION]: {
    type: NodeType.MUSIC_GENERATION,
    name: nodeMetadata[NodeType.MUSIC_GENERATION].name,
    description: nodeMetadata[NodeType.MUSIC_GENERATION].description,
    defaultInputs: defaultInputs[NodeType.MUSIC_GENERATION],
    defaultOutputs: defaultOutputs[NodeType.MUSIC_GENERATION],
    create: (config) => createNode(NodeType.MUSIC_GENERATION, config),
  },
  [NodeType.COMPOSITION]: {
    type: NodeType.COMPOSITION,
    name: nodeMetadata[NodeType.COMPOSITION].name,
    description: nodeMetadata[NodeType.COMPOSITION].description,
    defaultInputs: defaultInputs[NodeType.COMPOSITION],
    defaultOutputs: defaultOutputs[NodeType.COMPOSITION],
    create: (config) => createNode(NodeType.COMPOSITION, config),
  },
};

/** Custom node registry */
const customNodes = new Map<string, NodeDefinition>();

/** Register a custom node */
export function registerCustomNode(definition: NodeDefinition): void {
  if (OFFICIAL_NODES[definition.type as NodeType]) {
    throw new Error(`Cannot override official node type: ${definition.type}`);
  }
  customNodes.set(definition.type, definition);
}

/** Get a node by type */
export function getNode(type: string, config?: NodeConfig): PipelineNode {
  const official = OFFICIAL_NODES[type as NodeType];
  if (official) {
    return official.create(config);
  }

  const custom = customNodes.get(type);
  if (custom) {
    return custom.create(config);
  }

  throw new Error(`Unknown node type: ${type}`);
}

/** List all available node types */
export function listNodes(): string[] {
  const official = Object.values(NodeType) as string[];
  const custom = Array.from(customNodes.keys());
  return [...official, ...custom];
}

/** Get node definition without creating an instance */
export function getNodeDefinition(type: string): NodeDefinition | undefined {
  const official = OFFICIAL_NODES[type as NodeType];
  if (official) return official;
  return customNodes.get(type);
}

/** Unregister a custom node */
export function unregisterCustomNode(type: string): boolean {
  if (!customNodes.has(type)) return false;
  return customNodes.delete(type);
}
