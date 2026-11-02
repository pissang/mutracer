import type {ShaderMixin} from './shader.js';

/** Optional transport experiment. Production entry points never import its implementation. */
export interface ResearchShaderParts {
  enabled: boolean;
  maxDepth: number;
  debugGroup: number;
  declarations: string;
  contribution: string;
  debugOutput: string;
  mixin?: ShaderMixin;
  fragments?: Record<string, string>;
}
export interface ResearchPassState {
  debugGroup: number;
  enabled: boolean;
  key: string;
  workgroupSize: number;
  features: object;
  uniform: object;
}
export interface ResearchTransport {
  compute(options: object): ResearchShaderParts;
  fragment(options: readonly unknown[]): ResearchShaderParts;
  constants(constants: Record<string, boolean | number>, features: object): Record<string, boolean | number>;
  configure(pass: object, backend: 'webgpu' | 'webgl'): ResearchPassState;
  prepare(pass: object, backend: 'webgpu' | 'webgl', lighting?: unknown): void;
  capture(pass: object): void;
  dispose(pass: object, backend: 'webgpu' | 'webgl'): void;
  packUniform(data: ArrayBuffer, options: object): void;
}
let extension: ResearchTransport | undefined;
/** @internal Registers an explicitly imported experiment; call before allocating renders. */
export function registerResearchTransport(value: ResearchTransport | undefined): void { extension = value; }
export function researchTransport(): ResearchTransport | undefined { return extension; }
