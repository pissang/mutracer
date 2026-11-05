import {aovLaneKind, type AovKind} from '../aov.js';
import {aovResolveCommon} from './aovResolve.wgsl.js';

// Two input storage buffers leave six output slots on the baseline WebGPU
// eight-storage-buffer limit. Binding 3 remains the shared uniform binding.
export const AOV_SNAPSHOT_BATCH_SIZE = 6;
export const aovSnapshotBinding = (index: number) => index === 0 ? 2 : index + 3;

export function aovSnapshotShader(kinds: readonly AovKind[]): string {
  if (!kinds.length || kinds.length > AOV_SNAPSHOT_BATCH_SIZE) throw new RangeError('Invalid AOV snapshot batch size');
  return aovResolveCommon + kinds.map((_, i) =>
    `@group(0) @binding(${aovSnapshotBinding(i)}) var<storage,read_write> output${i}: array<vec4u>;`
  ).join('\n') + /* wgsl */ `
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let width=parameters.x;let height=parameters.y;
  if(id.x>=width||id.y>=height){return;}
  let index=id.x+id.y*width;
  let source=id.x+(height-1u-id.y)*width;
  ${kinds.map((kind, i) => `output${i}[index]=aovResolvedValue(source,${aovLaneKind(kind)}u);`).join('\n  ')}
}
`;
}
