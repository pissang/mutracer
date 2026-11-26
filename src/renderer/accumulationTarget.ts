import type { DenoiseInput } from '../Render.js';
import type { Scene } from '../scene/Scene.js';
import type { TraceSettings } from './renderPipeline.js';
import type { RenderPasses } from './RenderingPipeline.js';

export interface TemporalCaptureInput extends DenoiseInput {
  centerRecords?: GPUBuffer;
  reflection?: { radiance: GPUBuffer; albedo: GPUBuffer; records: GPUBuffer; samples: number };
}

/** Backend-owned execution and outputs of one resident accumulation. */
export interface TargetPipeline extends RenderPasses {
  captureTemporalInput?(aovs: readonly import('./aov.js').AovKind[], capture: (input: TemporalCaptureInput) => Promise<void>): Promise<void>;
  composeExternalDenoiseInput?(input: {width: number; height: number; samples: number; color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer}): {color: GPUBuffer; albedo: GPUBuffer; normal: GPUBuffer};
  setExternalDenoisedOutput?(input: GPUBuffer, displayLinear: boolean, encodedCodes: boolean, capturedBaseline?: GPUBuffer): void;
  readOfflineGeometry?(): Promise<ArrayBuffer>;
  setTemporalReflections?(enabled: boolean): void;
  activate(): void;
  invalidateDenoisedOutput(): void;
  /** Refreshes backend timing after structural scene changes; optional without GPU timestamps. */
  invalidateTiming?(): void;
  configure(settings: TraceSettings): void;
  synchronizeBackground(background: Scene['background']): void;
  canCompleteSampleWithin(timeBudgetMs: number): boolean;
  /** Optional WebGPU throughput controls; do not alter the tile budget. */
  setRealtimeBatchBudget?(milliseconds: number): void;
  setRealtimeDeferPostProcess?(defer: boolean): void;
  getRealtimeSampleTime?(): number | undefined;
  getRealtimeTileTime?(): number | undefined;
  whenTraceAvailable?(): Promise<boolean>;
  present(): void;
  readPresentation(): Promise<{width: number; height: number; data: Float32Array}>;
  readonly presentationComplete: boolean;
  readonly presentationDenoised: boolean;
  getMemory(): {width: number; height: number; bytes: number};
}
