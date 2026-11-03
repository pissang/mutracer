import type {AovSceneSource} from './aovScene.js';
import {aovInstanceOrder} from './aovScene.js';
import type {FlattendBVH} from './bvhAccel.js';
import {PackedMeshInstances} from './packedMeshInstances.js';

/** Internal GPU picking result; IDs refer to the committed source objects. */
export interface SurfaceHit {object: number; material: number; instance: number;}

/** Numeric 16-bit halves survive both storage buffers and float render targets. */
export function resolveSurfaceHit(source: AovSceneSource, tlas: FlattendBVH, samples: Float32Array): SurfaceHit | null | undefined {
  const words = samples.subarray(0, 4);
  if (words.length !== 4 || words.some(value => !Number.isInteger(value) || value < 0 || value > 65535)) return;
  const instance = words[0] + words[1] * 65536 - 1, material = words[2] + words[3] * 65536 - 1;
  if (instance === -1 && material === -1) return null;
  const index = aovInstanceOrder(tlas)[instance];
  if (index == null) return;
  const instances = source.instances;
  const binding = source.instanceBindings[instances instanceof PackedMeshInstances ? instances.bindingIndices[index] : index];
  const selectedMaterial = source.materials[material];
  if (!binding || !selectedMaterial) return;
  return {object: binding.mesh.aovId, material: selectedMaterial.aovId,
    instance: instances instanceof PackedMeshInstances ? instances.localIndices[index] : 0};
}
