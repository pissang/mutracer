import type { Vector3 } from 'three';
import type { AovKind, EngineDiagnostics, MaterialGraph, MaterialGraphWaitResult, SampleEvent, WaitForMaterialGraphsOptions } from '@meimu/mutracer';
import type { LoadingState, Stats } from '../store';
import type { LoadedModel, PathedFile } from './loadModel';
import type { MaterialValues, TextureKey } from './materialParams';
import type { MaterialDropTarget } from './materialDrop';
import type { TextureSampling } from './modelCache';
import type { TextureResolution } from './polyHaven';

export const MATERIALX_IMPORT = true;
export const DEFAULT_F_STOP = 2.8;
export interface ExportOptions { width: number; height: number; samples: number; transparent: boolean; }
export type PixelKind = 'hdr' | 'denoised' | 'albedo' | 'normal' | AovKind;
export interface ViewerEngineEvents {
  sample: SampleEvent;
  stats: Stats;
  progress: LoadingState | null;
  error: Error;
}

/** UI boundary. Settings and selection snapshots are published through useViewer. */
export interface ViewerEngine {
  readonly viewportSize: {width: number; height: number};
  readonly maxImageDimension: number;
  dispose(): void;
  loadInitialModel(presetId: string | null): Promise<boolean | void>;
  openURL(presetId: string | null): Promise<boolean | void>;
  loadPreset(id: string, restoreCamera?: boolean): Promise<boolean | void>;
  loadModel(model: LoadedModel): Promise<boolean | void>;
  loadUrl(url: string): Promise<boolean | void>;
  loadFiles(files: PathedFile[], drop?: {clientX: number; clientY: number}): Promise<boolean | void>;
  resetAll(): void;
  applyModelCamera(objectId: string): void;
  fit(aspect?: number, margin?: number): void;
  lookAt(position: Vector3, target: Vector3): void;
  pickFocus(x: number, y: number): void;
  pickMaterialTarget(clientX: number, clientY: number): Promise<MaterialDropTarget | null>;
  select(objectId: string | null, materialId?: string | null): void;
  selectMaterial(materialId: string, objectId: string): void;
  setVisible(objectId: string, visible: boolean): void;
  setMaterialValues(materialId: string, values: MaterialValues, label?: string, mergeKey?: string): void;
  setMaterialTextureSampling(materialId: string, slot: TextureKey, patch: Partial<TextureSampling>, label: string, mergeKey?: string): void;
  setMaterialTexture(materialId: string, slot: TextureKey, file: Blob | null, label: string): Promise<void>;
  setMaterialXHeight(materialId: string, name: string): Promise<boolean>;
  disconnectMaterialGraphInput(materialId: string, terminal: string, label: string): void;
  materialGraph(materialId: string): MaterialGraph | undefined;
  setMaterialGraph(materialId: string, graph: MaterialGraph | null, label: string, mergeKey?: string): void;
  clearMaterialGraph(materialId: string, label: string): void;
  setMaterialGraphImage(materialId: string, node: string, port: string, file: Blob, label: string): Promise<void>;
  applyPolyHavenTexture(materialId: string, id: string, name: string, resolution: TextureResolution,
    onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal, displacement?: boolean): Promise<boolean>;
  importMaterialX(materialId: string, files: PathedFile[], signal?: AbortSignal): Promise<boolean>;
  resetMaterial(materialId: string): void;
  selectClip(index: number): void;
  setAnimation(patch: Partial<{playing: boolean; time: number; speed: number; loop: boolean}>): void;
  downloadViewportImage(): Promise<void>;
  exportImage(options: ExportOptions): Promise<void>;
  captureImage(type?: string, quality?: number): Promise<Blob>;
  renderImage(options: ExportOptions, type?: string, quality?: number): Promise<Blob>;
  cancelExport(): void;
  readPixels(kind?: PixelKind): Promise<{width: number; height: number; data: Float32Array | Uint32Array}>;
  getDiagnostics(): EngineDiagnostics | undefined;
  waitForMaterialGraphs(options?: WaitForMaterialGraphsOptions): Promise<MaterialGraphWaitResult>;
  on<K extends keyof ViewerEngineEvents>(event: K, listener: (value: ViewerEngineEvents[K]) => void): () => void;
  code(): string;
  agentMarkdown(): string;
}

let current: ViewerEngine | null = null;
export const getEngine = () => current;
export const setEngine = (engine: ViewerEngine | null) => { current = engine; };
declare global {
  interface Window { mutracerViewer?: {code(): string | null; agentMarkdown(): string | null}; }
}
if (typeof window !== 'undefined') window.mutracerViewer = {code: () => current?.code() ?? null, agentMarkdown: () => current?.agentMarkdown() ?? null};
