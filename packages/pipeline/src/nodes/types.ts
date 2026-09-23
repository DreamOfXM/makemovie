/**
 * Pipeline Node Types and Interfaces
 */

/** Official node types in the makemovie pipeline */
export enum NodeType {
  SOURCE_INPUT = 'source_input',
  SCRIPT_UNDERSTANDING = 'script_understanding',
  STORYBOARD = 'storyboard',
  ASSET_GENERATION = 'asset_generation',
  FRAME_GENERATION = 'frame_generation',
  VIDEO_GENERATION = 'video_generation',
  VOICE_GENERATION = 'voice_generation',
  MUSIC_GENERATION = 'music_generation',
  COMPOSITION = 'composition',
}

/** Input port for a node */
export interface NodeInput {
  id: string;
  name: string;
  description?: string;
  required: boolean;
  type: string; // e.g., 'text', 'image', 'audio', 'video'
}

/** Output port for a node */
export interface NodeOutput {
  id: string;
  name: string;
  description?: string;
  type: string;
}

/** Node configuration options */
export interface NodeConfig {
  [key: string]: string | number | boolean | object | null | undefined;
}

/** Core pipeline node interface */
export interface PipelineNode {
  id: string;
  type: NodeType | string;
  name: string;
  description: string;
  inputs: NodeInput[];
  outputs: NodeOutput[];
  config?: NodeConfig;
}

/** Factory function type for creating nodes */
export type NodeFactory = (config?: NodeConfig) => PipelineNode;

/** Node definition with factory */
export interface NodeDefinition {
  type: string;
  name: string;
  description: string;
  defaultInputs: NodeInput[];
  defaultOutputs: NodeOutput[];
  create: NodeFactory;
}
