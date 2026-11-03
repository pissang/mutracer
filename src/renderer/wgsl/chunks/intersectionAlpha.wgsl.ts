import { mapAlphaUsageConstants } from '../../materialConstants.js';
import { uvProjectionConstants } from '../../materialConstants.js';
import {
  materialAlphaModeConstants
} from '../../materialConstants.js';

/**
 * Material coverage shared by software BVH traversal and native RayQuery
 * candidate filtering. The caller supplies local-space hit data so UV
 * projection and stochastic glTF BLEND semantics stay backend-independent.
 */
export function createIntersectionAlphaWgsl(hasAnisotropyDirections = true, compactVertices = false) {
  return /* wgsl */ `
fn intersectionAlphaPasses(
  initialMaterialIndex: i32,
  index: vec3i,
  hitBarycentric: vec3f,
  hitPosition: vec3f,
  hitNormal: vec3f${compactVertices ? ", record: i32" : ""}
) -> bool {
  var materialIndex = initialMaterialIndex;
${compactVertices ? /* wgsl */ `materialIndex = triangleMaterial(initialMaterialIndex, record);` : /* wgsl */ `
  let m0 = vec3i(attrBuffers[index.x * ATTR_STRIDE + MATERIALINDEX_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
  let m1 = vec3i(attrBuffers[index.y * ATTR_STRIDE + MATERIALINDEX_OFF]${hasAnisotropyDirections ? '.xyz' : ''});
  let m2 = vec3i(attrBuffers[index.z * ATTR_STRIDE + MATERIALINDEX_OFF]${hasAnisotropyDirections ? '.xyz' : ''});

  if (m0.x > 0 || m1.x > 0 || m2.x > 0) {
    materialIndex = randomPickMaterial(m0, m1, m2, hitBarycentric);
  }

`}
  let ma = materialsBuffer[materialIndex];
  var alpha = ma.alpha;
  if (USE_DIFFUSE_MAPS &&
      ma.mapAlphaUsage == ${mapAlphaUsageConstants.alpha}) {
    let diffuseMapIndex = i32(ma.diffuseMapIndex);
    if (diffuseMapIndex >= 0) {
      let uvProjection = i32(ma.uvProjection);
      let uv0 = vertexUv(index.x);
      let uv1 = vertexUv(index.y);
      let uv2 = vertexUv(index.z);
      var uv = hitBarycentric.x * uv0 +
        hitBarycentric.y * uv1 + hitBarycentric.z * uv2;
      if (uvProjection > 0) {
        uv = projectUV(uvProjection, hitPosition, hitNormal);
      }
      uv *= ma.uvScale;
      if (uvProjection == ${uvProjectionConstants.triplanar}) {
        uv = fract(uv);
      }
      alpha *= sampleMap(diffuseMapIndex, uv).a;
    }
  }

  if (USE_ALPHA_MAPS) {
    let alphaMapIndex = i32(ma.alphaMapIndex);
    if (alphaMapIndex >= 0) {
      let uvProjection = i32(ma.uvProjection);
      let uv0 = vertexUv(index.x);
      let uv1 = vertexUv(index.y);
      let uv2 = vertexUv(index.z);
      var uv = hitBarycentric.x * uv0 +
        hitBarycentric.y * uv1 + hitBarycentric.z * uv2;
      if (uvProjection > 0) {
        uv = projectUV(uvProjection, hitPosition, hitNormal);
      }
      uv *= ma.uvScale;
      if (uvProjection == ${uvProjectionConstants.triplanar}) {
        uv = fract(uv);
      }
      alpha *= sampleMap(alphaMapIndex, uv).g;
    }
  }

  let alphaMode = i32(ma.alphaMode);
  if (alphaMode == ${materialAlphaModeConstants.opaque}) {
    alpha = 1.0;
  }
  else if (alphaMode == ${materialAlphaModeConstants.mask}) {
    alpha = select(0.0, 1.0, alpha >= ma.alphaCutoff);
  }
  if (alphaMode == ${materialAlphaModeConstants.blend}) {
    return hashedSample(1u) <= alpha;
  }
  return alpha >= 1.0;
}
`;


}
export default createIntersectionAlphaWgsl();
