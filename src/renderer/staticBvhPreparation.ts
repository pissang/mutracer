import { setGeometryBvh, type BvhBuildConfig } from './geometryBvh.js';
import type Mesh from '../scene/Mesh.js';
import type Geometry from '../scene/Geometry.js';
import type { TinyBvhLayout } from '../tinybvh/TinyBvhBuilder.js';
import { buildBLAS, type FlattendBVH } from './bvhAccel.js';
import {
  buildBvhInWorker, BvhWorkerPool, BvhWorkerUnavailableError, BvhWorkerDisposedError
} from './bvhWorkerClient.js';
import {
  captureMeshBlasSnapshot,
  getMeshBlasInput,
  getPreparedMeshGeometry,
  meshNeedsStaticBvh,
  meshBlasSnapshotIsCurrent
} from './prepareMeshBVH.js';

export type StaticBvhCacheInput = ReturnType<typeof getMeshBlasInput>;
/** Internal application cache. Failures never prevent scene preparation. */
export interface StaticBvhCache {
  load(input: StaticBvhCacheInput, config: BvhBuildConfig): Promise<FlattendBVH | undefined>;
  store(input: StaticBvhCacheInput, config: BvhBuildConfig, bvh: FlattendBVH): Promise<void>;
}

export interface StaticBvhPreparationOptions {
  config?: BvhBuildConfig;
  cache?: StaticBvhCache;
  builder: 'builtin' | 'tinybvh';
  layout: TinyBvhLayout;
  spatialSplits: boolean;
  useWorker: boolean;
  workerPool?: BvhWorkerPool;
  isCancelled?: () => boolean;
  rebuild: boolean;
  onProgress?: (progress: number) => void;
}

export interface StaticBvhPreparationResult {
  geometryCount: number;
  bvhTimeMs: number;
  failedMeshes: Mesh[];
  workerUnavailable: boolean;
  tinyBvhUnavailable: boolean;
}

/** Build static BLASes once per target geometry, preserving old BVHs until writeback. */
export async function prepareStaticBvhs(
  meshes: readonly Mesh[], options: StaticBvhPreparationOptions
): Promise<StaticBvhPreparationResult> {
  const result: StaticBvhPreparationResult = {
    geometryCount: 0, bvhTimeMs: 0, failedMeshes: [],
    workerUnavailable: false, tinyBvhUnavailable: false
  };
  const jobs = new Map<Geometry, {
    mesh: Mesh;
    snapshot: ReturnType<typeof captureMeshBlasSnapshot>;
  }>();
  for (const mesh of meshes) {
    if (!mesh.geometry.position?.array.length || mesh.geometry.dynamic) continue;
    const target = getPreparedMeshGeometry(mesh);
    if (jobs.has(target) || (!meshNeedsStaticBvh(mesh, options.config ?? options) && !options.rebuild)) continue;
    try {
      jobs.set(target, { mesh, snapshot: captureMeshBlasSnapshot(mesh, target) });
    } catch {
      result.failedMeshes.push(mesh);
    }
  }
  const pool = options.useWorker ? options.workerPool ?? new BvhWorkerPool(1) : undefined;

  async function build(
    input: ReturnType<typeof getMeshBlasInput>, builder: StaticBvhPreparationOptions['builder'], useWorker: boolean
  ): Promise<FlattendBVH> {
    const { geometry, displacementScale, trianglesDisplacement } = input;
    let bvh: FlattendBVH & { bvhTimeMs?: number };
    if (useWorker) {
      bvh = await buildBvhInWorker(geometry, displacementScale, trianglesDisplacement,
        builder, builder === 'tinybvh' ? options.layout : 'bvh2', options.spatialSplits, pool);
    } else if (builder === 'tinybvh') {
      const { buildTinyBvh } = await import('../tinybvh/TinyBvhBuilder.js');
      bvh = await buildTinyBvh(geometry, displacementScale, trianglesDisplacement,
        options.layout, options.spatialSplits);
    } else {
      const start = performance.now();
      bvh = { ...buildBLAS(geometry, displacementScale, trianglesDisplacement),
        bvhTimeMs: performance.now() - start };
    }
    if (builder === 'tinybvh' && (bvh.builder !== 'tinybvh' || !bvh.buffer.byteLength)) {
      throw new Error('TinyBVH did not build every scene geometry.');
    }
    result.bvhTimeMs += bvh.bvhTimeMs ?? 0;
    return bvh;
  }

  async function buildWithFallback(input: ReturnType<typeof getMeshBlasInput>) {
    let builder = options.builder;
    let useWorker = options.useWorker && !result.workerUnavailable;
    for (;;) {
      if (options.isCancelled?.()) throw new BvhWorkerDisposedError();
      try {
        return await build(input, builder, useWorker);
      } catch (error) {
        if (error instanceof BvhWorkerDisposedError) throw error;
        if (error instanceof BvhWorkerUnavailableError && useWorker) {
          result.workerUnavailable = true;
          useWorker = false;
        } else if (builder === 'tinybvh') {
          result.tinyBvhUnavailable = true;
          builder = 'builtin';
          useWorker = options.useWorker && !result.workerUnavailable;
        } else {
          throw error;
        }
      }
    }
  }

  let completed = 0;
  // Large BLASes start first to reduce the tail. Only active lanes prepare
  // attributes/displacement inputs and submit geometry to Workers.
  const pending = [...jobs].sort(([a], [b]) =>
    (b.indices?.array.length ?? 0) - (a.indices?.array.length ?? 0));
  let next = 0;
  async function runLane() {
    while (next < pending.length && !options.isCancelled?.()) {
      const [target, { mesh, snapshot }] = pending[next++];
      try {
        if (!meshBlasSnapshotIsCurrent(mesh, target, snapshot)) continue;
        const input = getMeshBlasInput(mesh);
        const config = options.config ?? options;
        const cached = options.cache ? await options.cache.load(input, config).catch(() => undefined) : undefined;
        if (options.isCancelled?.() || !meshBlasSnapshotIsCurrent(mesh, target, snapshot)) continue;
        const bvh = cached ?? await buildWithFallback(input);
        if (!options.isCancelled?.() && meshBlasSnapshotIsCurrent(mesh, target, snapshot)) {
          setGeometryBvh(target, bvh, config);
          result.geometryCount++;
          if (!cached) await options.cache?.store(input, config, bvh).catch(() => {});
        }
      } catch (error) {
        if (!(error instanceof BvhWorkerDisposedError)) result.failedMeshes.push(mesh);
      } finally {
        if (!options.isCancelled?.()) {
          // A loading-screen callback must not stop a lane and strand jobs.
          try { options.onProgress?.(++completed / jobs.size); } catch { /* Keep building. */ }
        }
      }
    }
  }
  try {
    await Promise.allSettled(Array.from({ length: Math.min(pool?.size ?? 1, jobs.size) }, runLane));
  } finally {
    if (!options.workerPool) pool?.dispose();
  }
  return result;
}
