import type {ScratchPool} from './ScratchPool.js';
import type Camera from '../scene/Camera.js';
import type { Scene } from '../scene/Scene.js';
import type { SceneResources, AlphaBlendStrategy, ToneMappingParams, DisplayChannel } from './RenderingPipeline.js';
import type { SamplingPattern } from './sampling.js';
import type { TargetPipeline } from './accumulationTarget.js';

/** Immutable execution settings restored before every operation on a target. */
export interface TraceSettings {
  aovs?: readonly import('./aov.js').AovKind[]; aovSamples?: number;
  transmissiveOutputAlphaMin: number;
  bounces: number; clamping: number; bevel: boolean; bevelSamples: number;
  dispersionWavelengths: 1 | 3; directLightCandidates: number;
  caustics?: import('../Render.js').CausticSettings;
  alphaBlendStrategy: AlphaBlendStrategy; samplingPattern: SamplingPattern; maxSamples: number;
  timeBudgetMs: number; maxTiles: number; batchSamples: boolean;
}
export interface DisplaySettings {
  toneMapping: ToneMappingParams;
  bloom: { intensity: number; threshold: number; radius: number };
  hdrOutputEnabled: boolean; channel: DisplayChannel;
  shadowCatcherColor: [number, number, number]; shadowCatcherAlpha: number;
}
export interface RenderTarget extends TargetPipeline {
  readonly label: string;
  configure(settings: TraceSettings): void;
  synchronizeBackground(background: Scene['background']): void;
}
export interface RenderPipeline {
  getSharedMemoryBytes(): number;
  createTarget(label: string): RenderTarget;
  releaseTarget(target: RenderTarget): void;
  setMeshes: SceneResources['setMeshes'];
  setLights: SceneResources['setLights'];
  setBackground: SceneResources['setBackground'];
  setTextureAtlasBudget: SceneResources['setTextureAtlasBudget'];
  readDepthSamples(camera: Camera, area: Parameters<SceneResources['readDepthSamples']>[0], aspect?: number): ReturnType<SceneResources['readDepthSamples']>;
  getDiagnostics(): ReturnType<SceneResources['getDiagnostics']>;
  dispose(): void;
}

/** Shared scene ownership; every image operation explicitly selects its target. */
export function makeRenderPipeline(
  scene: Pick<RenderPipeline, 'setMeshes' | 'setLights' | 'setBackground' | 'setTextureAtlasBudget' | 'getDiagnostics' | 'dispose'> & {
    setCamera(camera: Camera): void;
    readDepthSamples(area: Parameters<SceneResources['readDepthSamples']>[0], aspect?: number): ReturnType<SceneResources['readDepthSamples']>;
    setBounce(bounces: number): boolean;
  },
  create: () => TargetPipeline,
  webgl = false,
  scratch?: ScratchPool
): RenderPipeline {
  const targets = new Set<RenderTarget>();
  const settings = new Map<RenderTarget, TraceSettings>();
  let latest: RenderTarget | undefined;
  let background: Scene['background'];
  return {
    getSharedMemoryBytes: () => scratch?.getMemoryBytes() ?? 0,
    createTarget(label) {
      const backend = create();
      const target: RenderTarget = {
        ...backend,
        get presentationComplete() { return backend.presentationComplete; },
        get presentationDenoised() { return backend.presentationDenoised; },
        label,
        configure(options) { settings.set(target, { ...options }); backend.configure(options); },
        activate() {
          latest = target;
          if (webgl) scene.setBounce(Math.max(1, ...Array.from(settings.values(), s => s.bounces)));
          backend.activate();
        }
      };
      target.synchronizeBackground(background);
      targets.add(target);
      return target;
    },
    releaseTarget(target) { if (targets.delete(target)) { settings.delete(target); target.dispose(); } },
    setMeshes: (meshes, update) => scene.setMeshes(meshes, update),
    setLights: lights => scene.setLights(lights),
    setBackground(value) {
      background = value; scene.setBackground(value);
      for (const target of targets) target.synchronizeBackground(value);
    },
    setTextureAtlasBudget: bytes => scene.setTextureAtlasBudget(bytes),
    async readDepthSamples(camera, area) { scene.setCamera(camera); return scene.readDepthSamples(area, camera.aspect); },
    getDiagnostics() {
      return { ...scene.getDiagnostics(), ...latest?.getDiagnostics(), targets: Array.from(targets, t => ({label: t.label, ...t.getMemory()})) };
    },
    dispose() { for (const target of targets) target.dispose(); targets.clear(); settings.clear(); scene.dispose(); scratch?.dispose(); }
  };
}
