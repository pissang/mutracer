// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { uvProjectionConstants } from '../../materialConstants.js';
import { INSTANCE_VEC4_STRIDE } from '../../bvhAccel.js';
import pdm_displacementWgsl from './pdm_displacement.wgsl.js';
import { createIntersectionAlphaWgsl } from './intersectionAlpha.wgsl.js';

const displacementWgsl = pdm_displacementWgsl;

const flatIntersectCode = function () {
  return /* wgsl */ `
let hit = intersectTriangle(o, d, tri, maxDim, shear, tMax);
if (hit.t > 0.0) {
  let e1 = tri.p1 - tri.p0;
  let e2 = tri.p2 - tri.p0;
  hitNormal = normalize(cross(e1, e2));
  let sideMaterialIndex = i32(unpackMaterialIndex(bitcast<i32>(insData.z)).x);
  let materialDoubleSided = materialsBuffer[sideMaterialIndex].doubleSided > 0.5;
  if (!doubleSided && !materialDoubleSided && dot(hitNormal, d) > 0.0) {
    hitNormal = vec3f(0.0);
    continue;
  }

  tMax = hit.t;
  isHit = true;
  isHitCurrent = true;
  hitPosition = o + tMax * d;
  hitBarycentric = hit.barycentric;
}
`;
};

function getPDMDisplacmentCode(anyHit: boolean) {
  return /*wgsl */ `
  let microTriangle = intersectDisplacement(
    o, d, tMax,
    tri.p0, tri.p1, tri.p2,
    n0, n1, n2,
    uv0, uv1, uv2,
    displacementMapIndex,
    getMapSize(displacementMapIndex),
    minH, maxH,
    hScale,
    matData.displacementBias,
    matData.displacementStepSize,
    i32(matData.displacementUvProjection),
    displacementUvProjectionScale,
    ${anyHit ? 'true' : 'false'},
    isRefractionRay
  );
`;
}

const displacementIntersectCode = function (anyHit: boolean, hasAnisotropyDirections: boolean) {
  return /* wgsl */ `

let hScale = insData.w;
let minMaxH = bitcast<i32>(r3.w);
// Displacement currently uses the first material of the instance.
let materialIndex = i32(unpackMaterialIndex(bitcast<i32>(insData.z)).x);
let matData = materialsBuffer[materialIndex];
let n0 = normalize(attrBuffers[index.x * ATTR_STRIDE + NORMAL_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
let n1 = normalize(attrBuffers[index.y * ATTR_STRIDE + NORMAL_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
let n2 = normalize(attrBuffers[index.z * ATTR_STRIDE + NORMAL_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
if (matData.displacementMapIndex >= 0.0 && matData.displacementBias != 0.0) {
  tri.p0 += n0 * matData.displacementBias;
  tri.p1 += n1 * matData.displacementBias;
  tri.p2 += n2 * matData.displacementBias;
}
if (abs(hScale) > 0.0 && minMaxH > 0) {
  let minH = f32(minMaxH >> 8) / 255.0;
  let maxH = f32(minMaxH & 0xff) / 255.0;
  let displacementUvProjectionScale = vec2f(matData.displacementUvProjectionScale);
  let displacementMapIndex = i32(matData.displacementMapIndex);

  // TODO duplicate reading of normal and uv
  var uv0 = attrBuffers[index.x * ATTR_STRIDE + UV_OFF].xy;
  var uv1 = attrBuffers[index.y * ATTR_STRIDE + UV_OFF].xy;
  var uv2 = attrBuffers[index.z * ATTR_STRIDE + UV_OFF].xy;

  ${getPDMDisplacmentCode(anyHit)}

  if (microTriangle.t < tMax) {
    hitNormal = microTriangle.normal;
    // TODO support double sided to improve non watertight triangles.

    tMax = microTriangle.t;
    // TODO barycentric is for micro triangle
    hitBarycentric = microTriangle.barycentric;
    hitPosition = o + tMax * d;

    isHitMicroTriangle = true;
    isHit = true;
    isHitCurrent = true;
  }
}
else {
  ${flatIntersectCode()}
}
`;
};

const cwbvhTraversalWgsl = /* wgsl */ `
fn unpackCwbvhBytes(value: u32) -> vec4f {
  return vec4f(
    f32(value & 0xffu),
    f32((value >> 8u) & 0xffu),
    f32((value >> 16u) & 0xffu),
    f32(value >> 24u)
  );
}

// CWBVH calls these helpers only with nonzero 8/24-bit masks. Every such
// integer is exactly representable as f32, whose unbiased IEEE-754 exponent
// gives the highest set bit. This avoids both the full-width firstLeadingBit
// polyfill on some shader backends and a serial bit-spread/popcount chain.
// Do not use this conversion for full 32-bit masks: rounding near a power of
// two can change their highest bit. Zero is also outside this contract.
fn cwbvhHighestBitIndex8(value: u32) -> u32 {
  return (bitcast<u32>(f32(value)) >> 23u) - 127u;
}

fn cwbvhHighestBitIndex24(value: u32) -> u32 {
  return (bitcast<u32>(f32(value)) >> 23u) - 127u;
}

fn intersectCwbvhInterior(
  node: i32,
  bufferOffset: i32,
  n0: vec4f,
  o: vec3f,
  invD: vec3f,
  tMax: f32
) -> u32 {
  let i = node + bufferOffset;
  let n2 = bvhBuffer[i + 2];
  let n3 = bvhBuffer[i + 3];
  let n4 = bvhBuffer[i + 4];
  let header = bitcast<u32>(n0.w);
  let exponentX = bitcast<i32>((header & 0xffu) << 24u) >> 24;
  let exponentY = bitcast<i32>(((header >> 8u) & 0xffu) << 24u) >> 24;
  let exponentZ = bitcast<i32>(((header >> 16u) & 0xffu) << 24u) >> 24;
  let quantizationScale = vec3f(
    bitcast<f32>(u32(exponentX + 127) << 23u),
    bitcast<f32>(u32(exponentY + 127) << 23u),
    bitcast<f32>(u32(exponentZ + 127) << 23u)
  );
  let padding = depthSlabPadding(invD, o);
  let originTerm = (n0.xyz - o) * invD;
  let adjustedInvD = quantizationScale * invD;
  // Pick each axis' entry and exit planes from the ray direction once, as in
  // the CWBVH paper, instead of ordering every child's slab pair. This halves
  // the slab arithmetic and the decoded values kept live at once.
  let words2 = bitcast<vec4u>(n2);
  let words3 = bitcast<vec4u>(n3);
  let words4 = bitcast<vec4u>(n4);
  let negative = invD < vec3f(0.0);
  let nearX = select(words2.xy, words3.zw, negative.x);
  let farX = select(words3.zw, words2.xy, negative.x);
  let nearY = select(words2.zw, words4.xy, negative.y);
  let farY = select(words4.xy, words2.zw, negative.y);
  let nearZ = select(words3.xy, words4.zw, negative.z);
  let farZ = select(words4.zw, words3.xy, negative.z);

  let near0 = max(
    max(
      unpackCwbvhBytes(nearX.x) * adjustedInvD.x + originTerm.x - vec4f(padding.x),
      unpackCwbvhBytes(nearY.x) * adjustedInvD.y + originTerm.y - vec4f(padding.y)
    ),
    unpackCwbvhBytes(nearZ.x) * adjustedInvD.z + originTerm.z - vec4f(padding.z)
  );
  let far0 = min(
    min(
      unpackCwbvhBytes(farX.x) * adjustedInvD.x + originTerm.x + vec4f(padding.x),
      unpackCwbvhBytes(farY.x) * adjustedInvD.y + originTerm.y + vec4f(padding.y)
    ),
    unpackCwbvhBytes(farZ.x) * adjustedInvD.z + originTerm.z + vec4f(padding.z)
  );
  let near1 = max(
    max(
      unpackCwbvhBytes(nearX.y) * adjustedInvD.x + originTerm.x - vec4f(padding.x),
      unpackCwbvhBytes(nearY.y) * adjustedInvD.y + originTerm.y - vec4f(padding.y)
    ),
    unpackCwbvhBytes(nearZ.y) * adjustedInvD.z + originTerm.z - vec4f(padding.z)
  );
  let far1 = min(
    min(
      unpackCwbvhBytes(farX.y) * adjustedInvD.x + originTerm.x + vec4f(padding.x),
      unpackCwbvhBytes(farY.y) * adjustedInvD.y + originTerm.y + vec4f(padding.y)
    ),
    unpackCwbvhBytes(farZ.y) * adjustedInvD.z + originTerm.z + vec4f(padding.z)
  );

  let hits0 = (near0 <= min(far0, vec4f(tMax))) & (far0 > vec4f(0.0));
  let hits1 = (near1 <= min(far1, vec4f(tMax))) & (far1 > vec4f(0.0));
  return select(0u, 1u, hits0.x)
    | select(0u, 2u, hits0.y)
    | select(0u, 4u, hits0.z)
    | select(0u, 8u, hits0.w)
    | select(0u, 16u, hits1.x)
    | select(0u, 32u, hits1.y)
    | select(0u, 64u, hits1.z)
    | select(0u, 128u, hits1.w);
}

`;

function getBVHTraverseCode(
  handleHitCode: string,
  hasDisplacement: boolean,
  anyHit: boolean,
  blasLayoutMask: number,
  hasAnisotropyDirections: boolean,
  skipTriangleCode = ''
) {
  const intersectTriangles = /* wgsl */ `
      let insData = instancesBuffer[insIdx * ${INSTANCE_VEC4_STRIDE}];
      let vertexOffset = vec3i(bitcast<i32>(insData.y));
      for (var k = 0; k < primitiveCount; k++) {
        let triangleIndex = primitiveOffset + k;
        ${skipTriangleCode}
        if (bounces > 0 && triangleIndex == currentTriangleIndex && insIdx == currentInstanceIndex) {
          continue;
        }
        
        let r3 = bvhBuffer[triangleIndex];
        let index = bitcast<vec3i>(r3.xyz) + vertexOffset;
        var tri = Triangle(
          attrBuffers[index.x * ATTR_STRIDE + POSITION_OFF]${hasAnisotropyDirections ? '.xyz' : ''},
          attrBuffers[index.y * ATTR_STRIDE + POSITION_OFF]${hasAnisotropyDirections ? '.xyz' : ''},
          attrBuffers[index.z * ATTR_STRIDE + POSITION_OFF]${hasAnisotropyDirections ? '.xyz' : ''}
        );
        var isHitCurrent = false;

        ${hasDisplacement
          ? displacementIntersectCode(anyHit, hasAnisotropyDirections)
          : flatIntersectCode()}
        if (isHitCurrent) {
          ${handleHitCode}
        }
      }
`;
  return /* wgsl */ `
var d = ray.d;
var o = ray.o;
var tlasTop = -1;
var invD = traversalInverse(d);
var isHitMicroTriangle = false;
var isHit = false;
var hitPosition: vec3f;
var hitNormal: vec3f;
var hitBarycentric: vec3f;


if (intersectBox(o, bvhBuffer[0].xyz, bvhBuffer[1].xyz, invD, tMax) > 0.0) {
  tlasTop = 0;
  tlasStack[0] = 0;
}
while (tlasTop >= 0) {
  let tlasNode = tlasStack[tlasTop];
  tlasTop--;
  o = ray.o;
  d = ray.d;
  invD = traversalInverse(d);

  let tlasR1 = bvhBuffer[tlasNode];
  let tlasPointerOrPrimitiveCount = bitcast<i32>(tlasR1.w);
  if (tlasPointerOrPrimitiveCount >= 0) {
    let left = tlasNode + 2;
    let right = tlasPointerOrPrimitiveCount;
    let d0 = intersectBox(
      o,
      bvhBuffer[left].xyz,
      bvhBuffer[left + 1].xyz,
      invD,
      tMax
    );
    let d1 = intersectBox(
      o,
      bvhBuffer[right].xyz,
      bvhBuffer[right + 1].xyz,
      invD,
      tMax
    );

    if (d0 > d1) {
      if (d0 > 0.0) { tlasTop++; tlasStack[tlasTop] = left; }
      if (d1 > 0.0) { tlasTop++; tlasStack[tlasTop] = right; }
    }
    else {
      if (d1 > 0.0) { tlasTop++; tlasStack[tlasTop] = right; }
      if (d0 > 0.0) { tlasTop++; tlasStack[tlasTop] = left; }
    }
  }
  else {
    let tlasPrimitiveCount = -tlasPointerOrPrimitiveCount;
    // The previous unified LIFO stack visited leaf instances in reverse order.
    // Preserve that order for alpha-tested any-hit rays and deterministic RNG.
    for (
      var instanceOffset = tlasPrimitiveCount - 1;
      instanceOffset >= 0;
      instanceOffset--
    ) {
      let instanceRecord = bvhBuffer[tlasNode + 2 + instanceOffset];
      let insIdx = bitcast<i32>(instanceRecord.x);
      let blasRoot = bitcast<i32>(instanceRecord.y);
      let insData = instancesBuffer[insIdx * ${INSTANCE_VEC4_STRIDE}];
      let w2l = mat4x4<f32>(
        instancesBuffer[insIdx * ${INSTANCE_VEC4_STRIDE} + 1],
        instancesBuffer[insIdx * ${INSTANCE_VEC4_STRIDE} + 2],
        instancesBuffer[insIdx * ${INSTANCE_VEC4_STRIDE} + 3],
        instancesBuffer[insIdx * ${INSTANCE_VEC4_STRIDE} + 4]
      );
      o = (w2l * vec4f(ray.o, 1.0)).xyz;
      d = (w2l * vec4f(ray.d, 0.0)).xyz;
      invD = traversalInverse(d);
      maxDim = maxDimension(abs(d));
      shear = getShear(d, maxDim);

      let encodedBlasOffset = bitcast<u32>(insData.x);
      let blasLayout = encodedBlasOffset >> 30u;
      let blasOffset = i32(encodedBlasOffset & 0x3fffffffu);
      let bufferOff = rtUniform.blasOffset;

      ${(blasLayoutMask & 8) !== 0 ? /* wgsl */ `
      if (blasLayout == 3u) {
        // TinyBVH's official CWBVH traversal keeps compact node groups on the
        // stack. The upper 8 bits identify intersected interior slots and the
        // lower 8 bits preserve the node's interior-slot mask for popcount
        // addressing. Triangle leaves are merged into a separate 24-bit mask.
        var cwbvhTop = -1;
        var cwbvhVisits = 0u;
        var nodeGroupBase = 0u;
        // A synthetic slot-7 hit selects relative node zero for the root.
        var nodeGroupMask = 0x80000000u;
        let octant = select(0u, 4u, d.x < 0.0)
          | select(0u, 2u, d.y < 0.0)
          | select(0u, 1u, d.z < 0.0);
        let octantInverse = 7u - octant;

        // Keep a statically visible trip bound. DXC can otherwise miscompile
        // the dynamic stack-top loop into a non-terminating shader on D3D12.
        // Validated scene rays stay far below this conservative safety cap.
        while (cwbvhVisits < 4096u) {
          cwbvhVisits++;
          
          let internalMask = nodeGroupMask & 0xffu;
          let childBitIndex =
            cwbvhHighestBitIndex8(nodeGroupMask >> 24u) + 24u;
          nodeGroupMask &= ~(1u << childBitIndex);
          if ((nodeGroupMask & 0xff000000u) != 0u) {
            cwbvhTop++;
            
            cwbvhStack[cwbvhTop] = vec2u(nodeGroupBase, nodeGroupMask);
          }

          let slot = (childBitIndex - 24u) ^ octantInverse;
          let precedingMask = (1u << slot) - 1u;
          let relativeIndex = countOneBits(internalMask & precedingMask);
          let childNodeIndex = nodeGroupBase + relativeIndex;
          let node = blasOffset + i32(childNodeIndex * 5u);
          let compressed0 = bvhBuffer[node + bufferOff];
          let slotHits = intersectCwbvhInterior(
            node, bufferOff, compressed0, o, invD, tMax
          );
          // Empty child hits need neither metadata nor leaf processing. Clear
          // the current group so the common tail restores pending siblings.
          nodeGroupMask = 0u;
          if (slotHits != 0u) {
            let compressed1 = bvhBuffer[node + bufferOff + 1];
            let nodeInternalMask = bitcast<u32>(compressed0.w) >> 24u;
            var hitMask = 0u;
            var remainingSlotHits = slotHits;
            while (remainingSlotHits != 0u) {
              let childSlot = cwbvhHighestBitIndex8(remainingSlotHits);
              remainingSlotHits &= ~(1u << childSlot);
              let metaWord = select(
                bitcast<u32>(compressed1.z),
                bitcast<u32>(compressed1.w),
                childSlot >= 4u
              );
              let childMeta =
                (metaWord >> ((childSlot & 3u) * 8u)) & 0xffu;
              let localOffset = childMeta & 0x1fu;
              let bitIndex = select(
                localOffset,
                localOffset ^ octantInverse,
                localOffset >= 24u
              );
              let childBits = (childMeta >> 5u) & 0x7u;
              hitMask |= childBits << bitIndex;
            }

            nodeGroupBase = bitcast<u32>(compressed1.x);
            nodeGroupMask = (hitMask & 0xff000000u) | nodeInternalMask;
            let triangleBase = bitcast<u32>(compressed1.y);
            var triangleMask = hitMask & 0x00ffffffu;
            while (triangleMask != 0u) {
              let triangleBitIndex = cwbvhHighestBitIndex24(triangleMask);
              triangleMask &= ~(1u << triangleBitIndex);
              let primitiveCount = 1;
              let primitiveOffset = bufferOff + blasOffset
                + i32(triangleBase + triangleBitIndex);
              ${intersectTriangles}
            }
          }

          if ((nodeGroupMask & 0xff000000u) != 0u) { continue; }
          if (cwbvhTop >= 0) {
            let restoredGroup = cwbvhStack[cwbvhTop];
            nodeGroupBase = restoredGroup.x;
            nodeGroupMask = restoredGroup.y;
            cwbvhTop--;
          }
          else { break; }
        }
      }
      ` : ''}

      var blasTop = -1;
      if (blasLayout != 3u) {
        blasTop = 0;
        
        blasStack[0] = blasRoot;
      }

      while (blasTop >= 0) {
        
        let node = blasStack[blasTop];
        blasTop--;
        var primitiveCount = 0;
        var primitiveOffset = 0;

        ${(blasLayoutMask & 4) !== 0 ? /* wgsl */ `
        if (blasLayout == 2u) {
          let i = node + bufferOff;
          let gpu0 = bvhBuffer[i];
          let gpu1 = bvhBuffer[i + 1];
          let gpu2 = bvhBuffer[i + 2];
          let gpu3 = bvhBuffer[i + 3];
          primitiveCount = i32(bitcast<u32>(gpu2.w));
          if (primitiveCount > 0) {
            primitiveOffset = bufferOff + blasOffset
              + i32(bitcast<u32>(gpu3.w));
          }
          else {
            let left = blasOffset + i32(bitcast<u32>(gpu0.w) * 4u);
            let right = blasOffset + i32(bitcast<u32>(gpu1.w) * 4u);
            let leftDistance = intersectBox(
              o, gpu0.xyz, gpu1.xyz, invD, tMax
            );
            let rightDistance = intersectBox(
              o, gpu2.xyz, gpu3.xyz, invD, tMax
            );
            if (leftDistance > rightDistance) {
              if (leftDistance > 0.0) {
                blasTop++; blasStack[blasTop] = left;
              }
              if (rightDistance > 0.0) {
                blasTop++; blasStack[blasTop] = right;
              }
            }
            else {
              if (rightDistance > 0.0) {
                blasTop++; blasStack[blasTop] = right;
              }
              if (leftDistance > 0.0) {
                blasTop++; blasStack[blasTop] = left;
              }
            }
          }
        }
        ` : ''}
        ${(blasLayoutMask & 2) !== 0 ? /* wgsl */ `
        if (blasLayout == 1u) {
          let nodeInfo = bitcast<u32>(node);
          if ((nodeInfo & 0x80000000u) != 0u) {
            primitiveCount = i32((nodeInfo >> 23u) & 0xffu);
            primitiveOffset = bufferOff + blasOffset
              + i32(nodeInfo & 0x007fffffu);
          }
          else {
            let i = node + bufferOff;
            let wide0 = bvhBuffer[i];
            let wide1 = bvhBuffer[i + 1];
            let wide2 = bvhBuffer[i + 2];
            let wide3 = bvhBuffer[i + 3];
            let nodeMin = wide0.xyz;
            let nodeExtent = vec3f(wide0.w, wide1.x, wide1.y);
            let childInfos = array<u32, 4>(
              bitcast<u32>(wide1.z), bitcast<u32>(wide1.w),
              bitcast<u32>(wide2.x), bitcast<u32>(wide2.y)
            );
            // Pick each axis' entry and exit planes from the ray direction
            // instead of ordering every child's slab pair.
            let negative = invD < vec3f(0.0);
            let nearX = unpack4x8unorm(bitcast<u32>(select(wide2.z, wide3.y, negative.x)));
            let farX = unpack4x8unorm(bitcast<u32>(select(wide3.y, wide2.z, negative.x)));
            let nearY = unpack4x8unorm(bitcast<u32>(select(wide2.w, wide3.z, negative.y)));
            let farY = unpack4x8unorm(bitcast<u32>(select(wide3.z, wide2.w, negative.y)));
            let nearZ = unpack4x8unorm(bitcast<u32>(select(wide3.x, wide3.w, negative.z)));
            let farZ = unpack4x8unorm(bitcast<u32>(select(wide3.w, wide3.x, negative.z)));
            let padding = depthSlabPadding(invD, o);
            let tNear = max(
              max(
                (nodeMin.x + nearX * nodeExtent.x - o.x) * invD.x - vec4f(padding.x),
                (nodeMin.y + nearY * nodeExtent.y - o.y) * invD.y - vec4f(padding.y)
              ),
              (nodeMin.z + nearZ * nodeExtent.z - o.z) * invD.z - vec4f(padding.z)
            );
            let tFar = min(
              min(
                (nodeMin.x + farX * nodeExtent.x - o.x) * invD.x + vec4f(padding.x),
                (nodeMin.y + farY * nodeExtent.y - o.y) * invD.y + vec4f(padding.y)
              ),
              (nodeMin.z + farZ * nodeExtent.z - o.z) * invD.z + vec4f(padding.z)
            );
            var distance = select(tFar, tNear, tNear > vec4f(0.0));
            distance = select(
              distance,
              vec4f(-1.0),
              tNear > min(tFar, vec4f(tMax))
            );
            var childDistances = array<f32, 4>(
              distance.x,
              distance.y,
              distance.z,
              distance.w
            );

            // Push far-to-near so that the closest child is popped first.
            for (var order = 0; order < 4; order++) {
              var farthestDistance = -1.0;
              var farthestChild = -1;
              for (var child = 0; child < 4; child++) {
                if (
                  childInfos[child] != 0u &&
                  childDistances[child] > farthestDistance
                ) {
                  farthestDistance = childDistances[child];
                  farthestChild = child;
                }
              }
              if (farthestChild >= 0 && farthestDistance > 0.0) {
                let childInfo = childInfos[farthestChild];
                var childAddress = bitcast<i32>(childInfo);
                if ((childInfo & 0x80000000u) == 0u) {
                  childAddress += blasOffset;
                }
                blasTop++;
                blasStack[blasTop] = childAddress;
                childDistances[farthestChild] = -1.0;
              }
            }
          }
        }
        ` : ''}
        ${(blasLayoutMask & 1) !== 0 ? /* wgsl */ `
        if (blasLayout == 0u) {
          let i = node + bufferOff;
          let r1 = bvhBuffer[i];
          let pointerToRightOrNumPrims = bitcast<i32>(r1.w);

          if (pointerToRightOrNumPrims >= 0) {
            let left = node + 2;
            let right = pointerToRightOrNumPrims + blasOffset;
            let d0 = intersectBox(
              o,
              bvhBuffer[left + bufferOff].xyz,
              bvhBuffer[left + 1 + bufferOff].xyz,
              invD,
              tMax
            );
            let d1 = intersectBox(
              o,
              bvhBuffer[right + bufferOff].xyz,
              bvhBuffer[right + 1 + bufferOff].xyz,
              invD,
              tMax
            );

            if (d0 > d1) {
              if (d0 > 0.0) {
                blasTop++; blasStack[blasTop] = left;
                
              }
              if (d1 > 0.0) {
                blasTop++; blasStack[blasTop] = right;
                
              }
            }
            else {
              if (d1 > 0.0) {
                blasTop++; blasStack[blasTop] = right;
                
              }
              if (d0 > 0.0) {
                blasTop++; blasStack[blasTop] = left;
                
              }
            }
          }
          else {
            primitiveCount = -pointerToRightOrNumPrims;
            primitiveOffset = i + 2;
          }
        }
        ` : ''}
        if (primitiveCount > 0) {
          ${intersectTriangles}
        }
      }
    }
  }
}

`;
}
// Raw first-hit contract for native diagnostics. Reuse the same traversal and
// triangle tests without surface completion or any integrator/alpha sampling.
export function createSceneHitQueryWgsl(hasAnisotropyDirections = false) {
  return /* wgsl */ `
struct SceneQueryHit {
  hit: bool, instance: i32, record: i32, t: f32, barycentric: vec3f,
}
fn querySceneSoftware(ray: Ray) -> SceneQueryHit {
  var result: SceneQueryHit;
  result.instance = -1; result.record = -1; result.t = RAY_MAX_DISTANCE;
  if (rtUniform.isEmpty > 0) { return result; }
  let bounces = 0;
  let doubleSided = false;
  let isRefractionRay = false;
  let currentTriangleIndex = -1;
  let currentInstanceIndex = -1;
  var tMax = RAY_MAX_DISTANCE;
  var maxDim: i32;
  var shear: vec3f;
  ${getBVHTraverseCode(`
    result.hit = true; result.instance = insIdx; result.record = triangleIndex;
    result.t = tMax; result.barycentric = hitBarycentric;
  `, false, false, 1, hasAnisotropyDirections)}
  return result;
}
`;
}

export function createSceneIntersectionsWgsl({
  hasDisplacement, hasAnisotropyDirections = true, hasCoatNormals = false, blasLayoutMask = 1,
  closestName = 'intersectScene', shadowName = 'intersectSceneShadow', bevelName = 'intersectSceneBevel', closestHitHook = ''
}: {
  hasDisplacement: boolean; hasAnisotropyDirections?: boolean; hasCoatNormals?: boolean;
  blasLayoutMask?: number; closestName?: string; shadowName?: string; bevelName?: string; closestHitHook?: string;
}) {
  return /* wgsl */ `// Traverse BVH, find closest triangle intersection, and return surface information
fn ${closestName}(ray: Ray, si: ptr<function, SurfaceInteraction>, bounces: i32, doubleSided: bool, isRefractionRay: bool) {

  (*si).hit = false;

  if (rtUniform.isEmpty > 0) {
    return;
  }

  var tMax = RAY_MAX_DISTANCE;
  var maxDim: i32;
  var shear: vec3f;

  var hitIndex: vec3i;
  var hitTri: Triangle;
  var hitInsIdx: i32;
  var currentTriangleIndex: i32 = (*si).triangleIndex;
  let currentInstanceIndex = (*si).instanceIndex;

  ${getBVHTraverseCode(
    `
(*si).triangleIndex = triangleIndex;
hitTri = tri;
hitIndex = index;
hitInsIdx = insIdx;
  `,
    hasDisplacement,
    false,
    blasLayoutMask,
    hasAnisotropyDirections
  )}

${closestHitHook}  if (isHit) {
    completeSurfaceInteraction(
      si,
      hitTri,
      hitBarycentric,
      hitIndex,
      isHitMicroTriangle,
      hitInsIdx,
      hitNormal,
      hitPosition,
      -1
    );
  }
}

// Local intersection helper for shader bevel.
fn ${bevelName}(ray: Ray, si: ptr<function, SurfaceInteraction>, instanceIndex: i32, maxDistance: f32) {
  (*si).hit = false;

  if (rtUniform.isEmpty > 0) {
    return;
  }

  let bounces = 0;
  let doubleSided = true;
  let isRefractionRay = false;
  var tMax = maxDistance;
  var maxDim: i32;
  var shear: vec3f;
  var hitIndex: vec3i;
  var hitTri: Triangle;
  var hitInsIdx: i32;
  var currentTriangleIndex: i32 = -1;
  let currentInstanceIndex = instanceIndex;

  ${getBVHTraverseCode(
    `
(*si).triangleIndex = triangleIndex;
hitTri = tri;
hitIndex = index;
hitInsIdx = insIdx;
    `,
    hasDisplacement,
    false,
    blasLayoutMask,
    hasAnisotropyDirections,
    `
        if (insIdx != instanceIndex) {
          continue;
        }
    `
  )}

  if (isHit) {
    (*si).instanceIndex = hitInsIdx;
    (*si).normal = hitNormal;
    (*si).position = hitPosition;
    (*si).materialIndex = i32(unpackMaterialIndex(bitcast<i32>(instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE}].z)).x);
    fetchAttributes(
      si,
      hitTri,
      hitBarycentric,
      hitIndex,
      isHitMicroTriangle,
      -1
    );

    let l2w = mat4x4<f32>(
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 5],
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 6],
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 7],
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 8]
    );
    let w2l = mat4x4<f32>(
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 1],
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 2],
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 3],
      instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 4]
    );
    let normalTransform = transpose(mat3x3<f32>(
      w2l[0].xyz,
      w2l[1].xyz,
      w2l[2].xyz
    ));
    (*si).faceNormal = normalize(normalTransform * hitNormal);
    (*si).vertexNormal = normalize(normalTransform * (*si).vertexNormal);
    (*si).normal = normalize(normalTransform * (*si).normal);
${hasCoatNormals ? /* wgsl */ `  (*si).coatNormal = normalize(normalTransform * (*si).coatNormal);` : ''}
    if (USE_TANGENT && dot((*si).tangent, (*si).tangent) > 0.0) {
      (*si).tangent = normalize((l2w * vec4f((*si).tangent, 0.0)).xyz);
    }
${hasAnisotropyDirections ? /* wgsl */ `
    (*si).directionTangent = (l2w * vec4f((*si).directionTangent, 0.0)).xyz;
    (*si).directionBitangent = (l2w * vec4f((*si).directionBitangent, 0.0)).xyz;
    (*si).geometryTangent = (l2w * vec4f((*si).geometryTangent, 0.0)).xyz;
    (*si).geometryBitangent = (l2w * vec4f((*si).geometryBitangent, 0.0)).xyz;
` : /* wgsl */ ``}
  (*si).shadowOffset = (l2w * vec4f((*si).shadowOffset, 0.0)).xyz;
    (*si).position = (l2w * vec4((*si).position, 1.0)).xyz;
  }
}

fn ${shadowName}(ray: Ray, lightDistance: f32, currTriangleIndex: i32, currInstanceIndex:i32) -> bool {
  if (rtUniform.isEmpty > 0) {
    return false;
  }

  let doubleSided = true;
  let shadowRayTMax = min(max(lightDistance, 0.0), RAY_MAX_DISTANCE);
  var tMax = shadowRayTMax;
  var maxDim: i32;
  var shear: vec3f;

  let bounces = 1;
  var isRefractionRay = false;
  var currentTriangleIndex: i32 = currTriangleIndex;
  let currentInstanceIndex = currInstanceIndex;

  ${getBVHTraverseCode(
    /*wgsl */ `
// Traversal is already clipped to the sampled light. Affine instance
// transforms preserve the ray parameter because local directions are not
// renormalized, so no local-to-world hit transform or distance() is needed.
var isOccluded = true;

if (isOccluded) {
  if (HAS_ALPHA) {
    let materialIndex = i32(unpackMaterialIndex(bitcast<i32>(insData.z)).x);
    if (!intersectionAlphaPasses(
      materialIndex,
      index,
      hitBarycentric,
      hitPosition,
      hitNormal
    )) {
      // Continue looking for an opaque hit, but never traverse beyond the light.
      tMax = shadowRayTMax;
      isOccluded = false;
    }
  }
}
if (isOccluded) {
  return true;
}
    `,
    hasDisplacement,
    true,
    blasLayoutMask,
    hasAnisotropyDirections
  )}

  return false;
}

`;
}

export default function getIntersectCode({
  hasDisplacement,
  hasAnisotropyDirections = true,
  hasCoatNormals = false,
  blasLayoutMask = 1,
  sceneIntersections = ''
}: {
  hasDisplacement: boolean;
  hasAnisotropyDirections?: boolean;
  hasCoatNormals?: boolean;
  blasLayoutMask?: number;
  sceneIntersections?: string;
}) {
  return /*wgsl*/ `

// Scene queries run sequentially within each invocation. Share their private
// traversal scratch instead of allocating arrays at every inlined query site.
// Each traversal resets its stack tops and writes entries before reading them.
// Never start another scene query while a traversal is still using these stacks.
var<private> tlasStack: array<i32, TLAS_STACK_SIZE>;
var<private> blasStack: array<i32, BLAS_STACK_SIZE>;
${(blasLayoutMask & 8) !== 0 ? /* wgsl */ `var<private> cwbvhStack: array<vec2u, BLAS_STACK_SIZE>;` : ''}

${hasDisplacement ? displacementWgsl : ''}
${(blasLayoutMask & 8) !== 0 ? cwbvhTraversalWgsl : ''}

struct Triangle {
  p0: vec3f,
  p1: vec3f,
  p2: vec3f,
};

fn intersectSphere(rad: f32, pos: vec3f, r: Ray) -> f32 {
  let op: vec3f = pos - r.o;
  let eps: f32 = 0.001;
  let b: f32 = dot(op, r.d);
  var det: f32 = b * b - dot(op, op) + rad * rad;
  if (det < 0.0) {
    return INF;
  }

  det = sqrt(det);
  let t1: f32 = b - det;
  if (t1 > eps) {
    return t1;
  }

  let t2: f32 = b + det;
  if (t2 > eps) {
    return t2;
  }

  return INF;
}

fn intersectRect(pos: vec3f, u: vec3f, v: vec3f, n: vec3f, r: Ray) -> f32 {
  let dt: f32 = dot(r.d, n);
  let t: f32 = (dot(n, pos) - dot(n, r.o)) / dt;

  if (t > EPS) {
    let p: vec3f = r.o + r.d * t;
    let vi: vec3f = p - pos;
    let a1: f32 = dot(u / dot(u, u), vi);
    if (a1 >= 0.0 && a1 <= 1.0) {
      let a2: f32 = dot(v / dot(v, v), vi);
      if (a2 >= 0.0 && a2 <= 1.0) {
        return t;
      }
    }
  }

  return INF;
}

fn sphereSolidAnglePdf(origin: vec3f, center: vec3f, radius: f32) -> f32 {
  let centerDistance = distance(origin, center);
  if (centerDistance <= radius) { return INV4PI; }
  let sinThetaMaxSquared = min(1.0, radius * radius / (centerDistance * centerDistance));
  let cosThetaMax = sqrt(max(0.0, 1.0 - sinThetaMaxSquared));
  return 1.0 / max(TWOPI * (1.0 - cosThetaMax), 1e-8);
}

fn intersectLight(r: Ray, light: Light, lightSample: ptr<function, LightSampleRec>) -> f32 {
  // Analytic continuation hits use the same conditional light density as NEE.
  // Initialize every field because this record is reused across the light loop.
  var d: f32 = INF;
  (*lightSample).direction = r.d;
  (*lightSample).normal = -r.d;
  (*lightSample).dist = INF;
  (*lightSample).pdf = 0.0;
  (*lightSample).emission = vec3f(0.0);
  (*lightSample).isDelta = false;
  var u = light.u;
  var v = light.v;
  var lightType = i32(light.litType);

  if (HAS_SCENE_RECT_LIGHT && lightType == RECT_LIGHT) {
    // Adjust the position from center to start corner
    var pos = light.position - u * 0.5 - v * 0.5;
    var normal = normalize(cross(u, v));
    if (dot(normal, r.d) > 0.0) { // Hide backfacing quad light
      return INF;
    }

    d = intersectRect(pos, u, v, normal, r);
    if (d < 0.0) {
      d = INF;
    }
    else {
      var cosTheta: f32 = dot(-r.d, normal);
      let spread = light.radiusOrSpread;
      if (cosTheta >= cos(spread * PI / 2.0)) {
        (*lightSample).direction = r.d;
        (*lightSample).normal = normal;
        (*lightSample).dist = d;
        (*lightSample).pdf = (d * d) / (light.area * cosTheta);
        (*lightSample).emission = light.emission;
        (*lightSample).isDelta = false;
      }
      else {
        d = INF;
      }
    }
  }

  else if (HAS_SCENE_SPHERE_LIGHT && lightType == SPHERE_LIGHT) {
    if (light.radiusOrSpread <= 0.0) {
      let toPoint = light.position - r.o;
      let projection = dot(toPoint, r.d);
      let perpendicular = toPoint - projection * r.d;
      if (projection <= EPS || dot(perpendicular, perpendicular) > 1e-8) {
        return INF;
      }
      d = projection;
      (*lightSample).direction = r.d;
      (*lightSample).normal = -r.d;
      (*lightSample).dist = d;
      (*lightSample).pdf = 1.0;
      (*lightSample).isDelta = true;
    }
    else {
      d = intersectSphere(light.radiusOrSpread, light.position, r);
      (*lightSample).isDelta = false;
      if (d > 0.0 && d != INF) {
        (*lightSample).direction = r.d;
        (*lightSample).dist = d;
        (*lightSample).normal = normalize(
          r.o + r.d * d - light.position
        );
        (*lightSample).pdf = sphereSolidAnglePdf(
          r.o,
          light.position,
          light.radiusOrSpread
        );
      }
    }
    if (d < 0.0) {
      d = INF;
    }
    else {
      (*lightSample).direction = r.d;
      (*lightSample).dist = d;
      (*lightSample).emission = select(
        light.emission,
        light.emission / max(d * d, 1e-8),
        light.radiusOrSpread <= 0.0
      );
    }
  }

  else if (HAS_SCENE_SPOT_LIGHT && lightType == SPOT_LIGHT) {
    if (light.radiusOrSpread <= 0.0) {
      let toPoint = light.position - r.o;
      let projection = dot(toPoint, r.d);
      let perpendicular = toPoint - projection * r.d;
      if (projection <= EPS || dot(perpendicular, perpendicular) > 1e-8) {
        return INF;
      }
      d = projection;
      (*lightSample).direction = r.d;
      (*lightSample).normal = -r.d;
      (*lightSample).dist = d;
      (*lightSample).pdf = 1.0;
      (*lightSample).isDelta = true;
    }
    else {
      d = intersectSphere(light.radiusOrSpread, light.position, r);
      (*lightSample).isDelta = false;
    }
    if (d != INF) {
      let hitPt = r.o + d * r.d;
      let multiplier = evaluateSpotEmissionMultiplier(light, normalize(r.o - hitPt));
      if (multiplier <= 0.0) { return INF; }
      if (light.radiusOrSpread > 0.0) {
        (*lightSample).direction = r.d;
        (*lightSample).dist = d;
        (*lightSample).normal = normalize(
          r.o + r.d * d - light.position
        );
        (*lightSample).pdf = sphereSolidAnglePdf(r.o, light.position, light.radiusOrSpread);
      }
      (*lightSample).emission = light.emission * multiplier * select(
        1.0,
        1.0 / max(d * d, 1e-8),
        light.radiusOrSpread <= 0.0
      );
    }
  }

  else if (lightType != RECT_LIGHT && lightType != SPHERE_LIGHT && lightType != SPOT_LIGHT) {
    // Unsupported light
    d = INF;
  }

  return d;
}

fn randomPickMaterial(m0: vec3i, m1: vec3i, m2: vec3i, bary: vec3f) -> i32 {
  let m00 = unpackMaterialIndex(m0.x);
  let m01 = unpackMaterialIndex(m0.y);
  let m02 = unpackMaterialIndex(m0.z);
  let m10 = unpackMaterialIndex(m1.x);
  let m11 = unpackMaterialIndex(m1.y);
  let m12 = unpackMaterialIndex(m1.z);
  let m20 = unpackMaterialIndex(m2.x);
  let m21 = unpackMaterialIndex(m2.y);
  let m22 = unpackMaterialIndex(m2.z);
  var w00 = m00.y * bary.x;
  var w01 = m01.y * bary.x;
  var w02 = m02.y * bary.x;
  var w10 = m10.y * bary.y;
  var w11 = m11.y * bary.y;
  var w12 = m12.y * bary.y;
  var w20 = m20.y * bary.z;
  var w21 = m21.y * bary.z;
  var w22 = m22.y * bary.z;

  var wTotal = w00 + w01 + w02 + w10 + w11 + w12 + w20 + w21 + w22;
  // Accumulate weights
  w00 = w00 / wTotal;
  w01 = w01 / wTotal + w00;
  w02 = w02 / wTotal + w01;
  w10 = w10 / wTotal + w02;
  w11 = w11 / wTotal + w10;
  w12 = w12 / wTotal + w11;
  w20 = w20 / wTotal + w12;
  w21 = w21 / wTotal + w20;
  w22 = w22 / wTotal + w21;

  let rand = hashedSample(0u);
  var mIdx: f32;
  if (rand < w00) {
    mIdx = m00.x;
  } else if (rand < w01) {
    mIdx = m01.x;
  } else if (rand < w02) {
    mIdx = m02.x;
  } else if (rand < w10) {
    mIdx = m10.x;
  } else if (rand < w11) {
    mIdx = m11.x;
  } else if (rand < w12) {
    mIdx = m12.x;
  } else if (rand < w20) {
    mIdx = m20.x;
  } else if (rand < w21) {
    mIdx = m21.x;
  } else {
    mIdx = m22.x;
  }
  return i32(mIdx);
}

fn resolveSurfaceMaterialIndex(
  fallbackMaterialIndex: i32,
  index: vec3i,
  bary: vec3f
) -> i32 {
  let m0 = vec3i(attrBuffers[index.x * ATTR_STRIDE + MATERIALINDEX_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
  let m1 = vec3i(attrBuffers[index.y * ATTR_STRIDE + MATERIALINDEX_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
  let m2 = vec3i(attrBuffers[index.z * ATTR_STRIDE + MATERIALINDEX_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
  if (m0.x > 0 || m1.x > 0 || m2.x > 0) {
    return randomPickMaterial(m0, m1, m2, bary);
  }
  return fallbackMaterialIndex;
}



${hasAnisotropyDirections ? /* wgsl */ `
fn anisotropy_axes(normal: vec3f, dp1: vec3f, dp2: vec3f, duv1: vec2f, duv2: vec2f, input: vec4f) -> mat2x3f {
  let determinant = duv1.x * duv2.y - duv1.y * duv2.x;
  var t = input.xyz;
  var b = vec3f(0.0);
  // Internal W=2 marks an authored XYZ tangent whose sign is derived from UVs.
  var sign = select(input.w, 0.0, abs(input.w) > 1.5);
  if (abs(determinant) > 1e-12) {
    let dt = (dp1 * duv2.y - dp2 * duv1.y) / determinant;
    let db = (dp2 * duv1.x - dp1 * duv2.x) / determinant;
    if (dot(t, t) < 1e-8) { t = dt; }
    if (sign == 0.0) { sign = select(1.0, -1.0, dot(cross(normal, dt), db) < 0.0); }
  }
  t -= normal * dot(normal, t);
  if (dot(t, t) < 1e-8) {
    let signZ = select(-1.0, 1.0, normal.z >= 0.0);
    let factor = -1.0 / (signZ + normal.z);
    let xy = normal.x * normal.y * factor;
    t = vec3f(1.0 + signZ * normal.x * normal.x * factor, signZ * xy, -signZ * normal.x);
    b = vec3f(xy, signZ + normal.y * normal.y * factor, -normal.y);
  }
  else { t = normalize(t); b = normalize(cross(normal, t)); }
  return mat2x3f(t, b * select(1.0, -1.0, sign < 0.0));
}

` : /* wgsl */ ``}
fn fetchAttributes(
  si: ptr<function, SurfaceInteraction>,
  tri: Triangle,
  bary: vec3f,
  index: vec3i,
  isHitMicroTriangle: bool,
  resolvedMaterialIndex: i32
) {
  (*si).hit = true;
  // Get projected uv
  let material = materialsBuffer[(*si).materialIndex];
  let uvProjection = i32(material.uvProjection);

  let i0 = index.x;
  let i1 = index.y;
  let i2 = index.z;
  (*si).vertexColor = vec3f(1.0);
  if (USE_VERTEX_COLOR) {
    (*si).vertexColor = bary.x * attrBuffers[i0 * ATTR_STRIDE + COLOR_OFF].xyz
      + bary.y * attrBuffers[i1 * ATTR_STRIDE + COLOR_OFF].xyz
      + bary.z * attrBuffers[i2 * ATTR_STRIDE + COLOR_OFF].xyz;
  }
  let isSphericalProj = uvProjection == ${uvProjectionConstants.spherical};

  var normal: vec3f = (*si).normal;
  var normalForSphericalProj: vec3f;
  var n0 = vec3f(0.0);
  var n1 = vec3f(0.0);
  var n2 = vec3f(0.0);
  // Otherwise use the normal from the microtriangle
  // The exception is spherical projection, we need the original normal to project the uv. Or the case like earth has wrong normal.
  if (!isHitMicroTriangle || isSphericalProj) {
    n0 = attrBuffers[i0 * ATTR_STRIDE + NORMAL_OFF]${hasAnisotropyDirections ? '.xyz' : ''};
    n1 = attrBuffers[i1 * ATTR_STRIDE + NORMAL_OFF]${hasAnisotropyDirections ? '.xyz' : ''};
    n2 = attrBuffers[i2 * ATTR_STRIDE + NORMAL_OFF]${hasAnisotropyDirections ? '.xyz' : ''};
    normalForSphericalProj = normalize(bary.x * n0 + bary.y * n1 + bary.z * n2);
    if (!isHitMicroTriangle) {
      normal = normalForSphericalProj;
    }
  }

  var uv: vec2f;
  var uv0: vec2f;
  var uv1: vec2f;
  var uv2: vec2f;
  var secondaryUv = vec2f(0.0);
  if (USE_UV) {
    uv0 = attrBuffers[i0 * ATTR_STRIDE + UV_OFF].xy;
    uv1 = attrBuffers[i1 * ATTR_STRIDE + UV_OFF].xy;
    uv2 = attrBuffers[i2 * ATTR_STRIDE + UV_OFF].xy;
    uv = bary.x * uv0 + bary.y * uv1 + bary.z * uv2;
    if (USE_UV1) {
      let secondaryUv0 = attrBuffers[i0 * ATTR_STRIDE + UV1_OFF].xy;
      let secondaryUv1 = attrBuffers[i1 * ATTR_STRIDE + UV1_OFF].xy;
      let secondaryUv2 = attrBuffers[i2 * ATTR_STRIDE + UV1_OFF].xy;
      secondaryUv = bary.x * secondaryUv0
        + bary.y * secondaryUv1
        + bary.z * secondaryUv2;
    }
  }

  if (USE_TANGENT) {
    let t0 = attrBuffers[i0 * ATTR_STRIDE + TANGENT_OFF]${hasAnisotropyDirections ? '.xyz' : ''};
    let t1 = attrBuffers[i1 * ATTR_STRIDE + TANGENT_OFF]${hasAnisotropyDirections ? '.xyz' : ''};
    let t2 = attrBuffers[i2 * ATTR_STRIDE + TANGENT_OFF]${hasAnisotropyDirections ? '.xyz' : ''};
    (*si).tangent = normalize(bary.x * t0 + bary.y * t1 + bary.z * t2);
  }

  if (resolvedMaterialIndex >= 0) {
    (*si).materialIndex = resolvedMaterialIndex;
  }
  else {
    (*si).materialIndex = resolveSurfaceMaterialIndex(
      (*si).materialIndex,
      index,
      bary
    );
  }

  if (uvProjection > 0) {
    // NOTE: position and normal are not transformed to world space yet.
    uv = projectUV(uvProjection, (*si).position, select(normal, normalForSphericalProj, isSphericalProj));
    secondaryUv = uv;
  }

  uv = uv * material.uvScale;
  secondaryUv = secondaryUv * material.uvScale;

  // Force repeating UVs for triplanar mapping
  if (uvProjection == ${uvProjectionConstants.triplanar}) {
    uv = fract(uv);
  }

${hasAnisotropyDirections ? /* wgsl */ `
${hasCoatNormals ? /* wgsl */ `  (*si).coatNormal = normal;` : ''}
  let directionMaterial = materialsBuffer[(*si).materialIndex];
  if (directionMaterial.anisotropyMapIndex >= 0.0 || directionMaterial.specularAnisotropyRotation != 0.0 || directionMaterial.coatAnisotropyRotation != 0.0${hasCoatNormals ? " || directionMaterial.coatWeight > 0.0" : ""}) {
    let dp1 = tri.p0 - tri.p2;
    let dp2 = tri.p1 - tri.p2;
    var inputTangent = vec4f(0.0);
    if (USE_TANGENT) {
      inputTangent = bary.x * attrBuffers[i0 * ATTR_STRIDE + TANGENT_OFF]
        + bary.y * attrBuffers[i1 * ATTR_STRIDE + TANGENT_OFF]
        + bary.z * attrBuffers[i2 * ATTR_STRIDE + TANGENT_OFF];
    }
    let geometryAxes = anisotropy_axes(normal, dp1, dp2, uv0-uv2, uv1-uv2, inputTangent);
    (*si).geometryTangent = geometryAxes[0];
    (*si).geometryBitangent = geometryAxes[1];
    var directionAxes = geometryAxes;
    if (USE_UV1 && directionMaterial.anisotropyMapIndex >= 0.0 && mapInfo[i32(directionMaterial.anisotropyMapIndex) + NUM_MAPS * 2].x > 0.5) {
      let a = attrBuffers[i0 * ATTR_STRIDE + UV1_OFF].xy;
      let b = attrBuffers[i1 * ATTR_STRIDE + UV1_OFF].xy;
      let c = attrBuffers[i2 * ATTR_STRIDE + UV1_OFF].xy;
      directionAxes = anisotropy_axes(normal, dp1, dp2, a-c, b-c, select(inputTangent, vec4f(0.0), inputTangent.w == 0.0));
    }
    (*si).directionTangent = directionAxes[0];
    (*si).directionBitangent = directionAxes[1];
${hasCoatNormals ? /* wgsl */ `
    if (USE_COAT_NORMAL_MAPS && directionMaterial.coatNormalMapIndex >= 0.0) {
      let coatIndex = i32(directionMaterial.coatNormalMapIndex);
      var coatAxes = geometryAxes;
      if (USE_UV1 && mapInfo[coatIndex + NUM_MAPS * 2].x > 0.5) {
        let a = attrBuffers[i0 * ATTR_STRIDE + UV1_OFF].xy;
        let b = attrBuffers[i1 * ATTR_STRIDE + UV1_OFF].xy;
        let c = attrBuffers[i2 * ATTR_STRIDE + UV1_OFF].xy;
        coatAxes = anisotropy_axes(normal, dp1, dp2, a-c, b-c,
          select(inputTangent, vec4f(0.0), inputTangent.w == 0.0));
      }
      // Procedural projection overrides both UV sets. UV0 has already applied
      // triplanar wrapping, so use it for either texture channel in that case.
      let decoded = sampleMap(coatIndex, getMapUvSet(coatIndex, uv,
        select(secondaryUv, uv, uvProjection > 0))).rgb * 2.0 - 1.0;
      let mapped = coatAxes[0] * decoded.x * directionMaterial.coatNormalScale.x
        + coatAxes[1] * decoded.y * directionMaterial.coatNormalScale.y + normal * decoded.z;
      if (dot(mapped, mapped) > 1e-12) { (*si).coatNormal = normalize(mapped); }
    }
` : ''}
  }

` : /* wgsl */ ``}
  (*si).normal = normal;
  (*si).vertexNormal = normal;
  (*si).shadowOffset = vec3f(0.0);
  if (!isHitMicroTriangle) {
    // Smooth-limit geometry offset for direct-light shadow rays. This follows
    // the Cycles shadow terminator construction while keeping the result in
    // local space until the instance transform is available.
    let geometricNormal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
    let smoothNormal = bary.x * n0 + bary.y * n1 + bary.z * n2;
    let a = dot(n2 - n0, tri.p0 - tri.p2);
    let b = dot(n2 - n1, tri.p1 - tri.p2);
    let c = dot(n1 - n0, tri.p1 - tri.p0);
    var h = a * bary.x * (bary.x - 1.0)
      + (a + b + c) * bary.x * bary.y
      + b * bary.y * (bary.y - 1.0);
    if (dot(smoothNormal, geometricNormal) > 0.0) {
      var h0 = max(max(dot(tri.p1 - tri.p0, n0), dot(tri.p2 - tri.p0, n0)), 0.0);
      var h1 = max(max(dot(tri.p0 - tri.p1, n1), dot(tri.p2 - tri.p1, n1)), 0.0);
      var h2 = max(max(dot(tri.p0 - tri.p2, n2), dot(tri.p1 - tri.p2, n2)), 0.0);
      h0 = max(dot(tri.p0 - (*si).position, n0) + h0, 0.0);
      h1 = max(dot(tri.p1 - (*si).position, n1) + h1, 0.0);
      h2 = max(dot(tri.p2 - (*si).position, n2) + h2, 0.0);
      h = max(min(min(h0, h1), h2), h * 0.5);
    }
    else {
      var h0 = max(max(dot(tri.p0 - tri.p1, n0), dot(tri.p0 - tri.p2, n0)), 0.0);
      var h1 = max(max(dot(tri.p1 - tri.p0, n1), dot(tri.p1 - tri.p2, n1)), 0.0);
      var h2 = max(max(dot(tri.p2 - tri.p0, n2), dot(tri.p2 - tri.p1, n2)), 0.0);
      h0 = max(dot((*si).position - tri.p0, n0) + h0, 0.0);
      h1 = max(dot((*si).position - tri.p1, n1) + h1, 0.0);
      h2 = max(dot((*si).position - tri.p2, n2) + h2, 0.0);
      h = min(-min(min(h0, h1), h2), h * 0.5);
    }
    (*si).shadowOffset = smoothNormal * h;
  }
  (*si).uv = uv;
  (*si).uv1 = secondaryUv;
  if (USE_NORMAL_MAPS) {
    let dp1 = tri.p0 - tri.p2;
    let dp2 = tri.p1 - tri.p2;
    let duv1 = uv0 - uv2;
    let duv2 = uv1 - uv2;
    (*si).normal = getMatNormal(
      (*si).materialIndex, uv, normal, dp1, dp2, duv1, duv2
    );
  }
}

struct TriangleIntersect {
  t: f32,
  barycentric: vec3f,
};


// Triangle-ray intersection
// Faster than the classic Möller–Trumbore intersection algorithm
// http://www.pbr-book.org/3ed-2018/Shapes/Triangle_Meshes.html#TriangleIntersection
fn intersectTriangle(o: vec3f, d: vec3f, tri: Triangle, maxDim: i32, shear: vec3f, tMax: f32) -> TriangleIntersect {
  var ti: TriangleIntersect;

  // translate vertices based on ray origin
  var p0t = tri.p0 - o;
  var p1t = tri.p1 - o;
  var p2t = tri.p2 - o;

  // permute components of triangle vertices
  if (maxDim == 0) {
    p0t = p0t.yzx;
    p1t = p1t.yzx;
    p2t = p2t.yzx;
  } else if (maxDim == 1) {
    p0t = p0t.zxy;
    p1t = p1t.zxy;
    p2t = p2t.zxy;
  }

  // apply shear transformation to translated vertex positions
  // TODO swizzled assignment is not supported in wgsl
  p0t = vec3f(p0t.xy + shear.xy * p0t.z, p0t.z);
  p1t = vec3f(p1t.xy + shear.xy * p1t.z, p1t.z);
  p2t = vec3f(p2t.xy + shear.xy * p2t.z, p2t.z);

  // compute edge function coefficients
  var e = vec3f(
    p1t.x * p2t.y - p1t.y * p2t.x,
    p2t.x * p0t.y - p2t.y * p0t.x,
    p0t.x * p1t.y - p0t.y * p1t.x
  );

  if (DEPTH_QUERY_MODE) {
    // Exact grid rays can land on shared edges. Roundoff in the two edge
    // products must not turn the edge into a crack between both triangles.
    let edgeScale = abs(vec3f(p1t.x * p2t.y, p2t.x * p0t.y, p0t.x * p1t.y))
      + abs(vec3f(p1t.y * p2t.x, p2t.y * p0t.x, p0t.y * p1t.x));
    e = select(e, vec3f(0.0), abs(e) <= edgeScale * 1e-6);
  }

  // check if intersection is inside triangle
  if (any(e < vec3f(0)) && any(e > vec3f(0))) {
    return ti;
  }

  let det = e.x + e.y + e.z;
  if (DEPTH_QUERY_MODE && det == 0.0) { return ti; }

  p0t.z *= shear.z;
  p1t.z *= shear.z;
  p2t.z *= shear.z;
  let tScaled = (e.x * p0t.z + e.y * p1t.z + e.z * p2t.z);

  // check if closer intersection already exists
  if (abs(tScaled) > abs(tMax * det)) {
    return ti;
  }

  let invDet = 1. / det;
  ti.t = tScaled * invDet;
  ti.barycentric = e * invDet;

  return ti;
}

// Pinhole depth queries can lie exactly on a grid vertex or a flat slab.
// Specialize conservative slabs for that entry point; beauty retains its
// original traversal arithmetic and random streams.
override DEPTH_QUERY_MODE: bool = false;

fn traversalInverse(d: vec3f) -> vec3f {
  if (!DEPTH_QUERY_MODE) { return 1.0 / d; }
  return 1.0 / select(d, select(vec3f(1e-20), vec3f(-1e-20), d < vec3f(0.0)), abs(d) < vec3f(1e-20));
}

fn depthSlabPadding(invD: vec3f, o: vec3f) -> vec3f {
  if (!DEPTH_QUERY_MODE) { return vec3f(0.0); }
  return abs(invD) * max(vec3f(1.0), abs(o)) * 1e-6;
}

// Branchless ray/box intersection
// https://tavianator.com/fast-branchless-raybounding-box-intersections/
fn intersectBox(o: vec3f, bmin: vec3f, bmax: vec3f, invD: vec3f, tMax: f32) -> f32 {
  let tBot = (bmin - o) * invD;
  let tTop = (bmax - o) * invD;
  let padding = depthSlabPadding(invD, o);
  let tNear = min(tBot, tTop) - padding;
  let tFar = max(tBot, tTop) + padding;
  let t0 = max(tNear.x, max(tNear.y, tNear.z));
  let t1 = min(tFar.x, min(tFar.y, tFar.z));
  return select(select(t1, t0, t0 > 0.0), -1.0, (t0 > t1 || t0 > tMax));
}

fn maxDimension(v: vec3f) -> i32 {
  return select(select(2, 1, v.y > v.z), select(2, 0, v.x > v.z), v.x > v.y);
}

fn getShear(d: vec3f, maxDim: i32) -> vec3f {
  // Permute space so that the z dimension is the one where the absolute value of the ray's direction is largest.
  // Then create a shear transformation that aligns ray direction with the +z axis
  if (maxDim == 0) {
    return vec3f(-d.y, -d.z, 1.0) / d.x;
  } else if (maxDim == 1) {
    return vec3f(-d.z, -d.x, 1.0) / d.y;
  } else {
    return vec3f(-d.x, -d.y, 1.0) / d.z;
  }
}

fn completeSurfaceInteraction(
  si: ptr<function, SurfaceInteraction>,
  hitTri: Triangle,
  hitBarycentric: vec3f,
  hitIndex: vec3i,
  isHitMicroTriangle: bool,
  hitInsIdx: i32,
  hitNormal: vec3f,
  hitPosition: vec3f,
  resolvedMaterialIndex: i32
) {
  (*si).instanceIndex = hitInsIdx;
  (*si).barycentrics = hitBarycentric.xy;
  (*si).normal = hitNormal;
  (*si).position = hitPosition;
  (*si).materialIndex = i32(unpackMaterialIndex(
    bitcast<i32>(instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE}].z)
  ).x);
  // NOTE: Must be called before transforming normal/position to world space.
  // UV projection depends on the local position.
  fetchAttributes(
    si,
    hitTri,
    hitBarycentric,
    hitIndex,
    isHitMicroTriangle,
    resolvedMaterialIndex
  );

  let l2w = mat4x4<f32>(
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 5],
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 6],
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 7],
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 8]
  );
  let w2l = mat4x4<f32>(
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 1],
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 2],
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 3],
    instancesBuffer[hitInsIdx * ${INSTANCE_VEC4_STRIDE} + 4]
  );
  let normalTransform = transpose(mat3x3<f32>(
    w2l[0].xyz,
    w2l[1].xyz,
    w2l[2].xyz
  ));

  (*si).faceNormal = normalize(normalTransform * hitNormal);
  (*si).vertexNormal = normalize(normalTransform * (*si).vertexNormal);
  (*si).normal = normalize(normalTransform * (*si).normal);
${hasCoatNormals ? /* wgsl */ `  (*si).coatNormal = normalize(normalTransform * (*si).coatNormal);` : ''}
  if (USE_TANGENT && dot((*si).tangent, (*si).tangent) > 0.0) {
    (*si).tangent = normalize((l2w * vec4f((*si).tangent, 0.0)).xyz);
  }
${hasAnisotropyDirections ? /* wgsl */ `
  (*si).directionTangent = (l2w * vec4f((*si).directionTangent, 0.0)).xyz;
  (*si).directionBitangent = (l2w * vec4f((*si).directionBitangent, 0.0)).xyz;
    (*si).geometryTangent = (l2w * vec4f((*si).geometryTangent, 0.0)).xyz;
    (*si).geometryBitangent = (l2w * vec4f((*si).geometryBitangent, 0.0)).xyz;
` : /* wgsl */ ``}
  (*si).shadowOffset = (l2w * vec4f((*si).shadowOffset, 0.0)).xyz;
  (*si).position = (l2w * vec4((*si).position, 1.0)).xyz;
}


${createIntersectionAlphaWgsl(hasAnisotropyDirections)}



${sceneIntersections || createSceneIntersectionsWgsl({hasDisplacement, hasAnisotropyDirections, hasCoatNormals, blasLayoutMask})}`;
}
