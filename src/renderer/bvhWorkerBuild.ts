import { buildTinyBvh } from '../tinybvh/TinyBvhBuilder.js';
import Geometry, {Attribute} from '../scene/Geometry.js';
import { buildBLAS } from './bvhAccel.js';
import type { BvhBuildRequest } from './bvhWorkerClient.js';

/** Shared worker operation, also executable without browser globals in tests. */
export async function executeBvhBuild(request: BvhBuildRequest) {
  const geometry = new Geometry({
    position: request.position,
    // A non-displaced BLAS needs no normals. Suppress Geometry's smooth-normal
    // generation rather than allocating 12 bytes per vertex in every worker.
    normal: request.normal ?? new Attribute(new Float32Array(0), 3), indices: request.indices
  });
  geometry.dynamic = request.dynamic;
  if (request.builder === 'tinybvh' && !geometry.dynamic) {
    return buildTinyBvh(geometry, request.displacementScale, request.trianglesDisplacement,
      request.layout, request.spatialSplits);
  }
  const start = performance.now();
  return { ...buildBLAS(geometry, request.displacementScale, request.trianglesDisplacement),
    bvhTimeMs: performance.now() - start };
}
