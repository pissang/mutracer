import { FragmentShader, Shader } from '../shader.js';
import { DEPTH_SAMPLE_GRID } from '../depthQuery.js';
import common from './chunks/common.glsl.js';
import core from './chunks/rayTraceCore.glsl.js';
import materials from './chunks/materialBuffer.glsl.js';
import intersect from './chunks/intersect.glsl.js';
import uvProjection from './chunks/uvProjection.glsl.js';
import random from './chunks/random.glsl.js';
import rand from './chunks/rand.glsl.js';

export default new FragmentShader({
  name: 'depthQuery', outputs: ['depth'],
  defines: { DEPTH_QUERY_MODE: true },
  includes: [core, materials, intersect, random],
  uniforms: {
    depthArea: Shader.uniform('vec4'),
    viewProjectionInv: Shader.uniform('mat4'),
    viewInv: Shader.uniform('mat4')
  },
  main: /* glsl */ `
${common}
${rand}
${random.main}
${core.main}
${uvProjection}
${materials.main}
${intersect.main}

void main() {
  vec2 offset = floor(gl_FragCoord.xy) / ${DEPTH_SAMPLE_GRID - 1}.0 * 2.0 - 1.0;
  vec2 uv = depthArea.xy + depthArea.zw * offset * vec2(1.0, -1.0);
  out_depth = vec4(0.0);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return;
  vec4 origin = viewProjectionInv * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 target = viewProjectionInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  Ray ray;
  initRay(ray, origin.xyz / origin.w, normalize(target.xyz * origin.w - origin.xyz * target.w));
  vec3 eye = viewInv[3].xyz;
  vec3 forward = -normalize(viewInv[2].xyz);
  SurfaceInteraction si;
  si.triangleIndex = -1;
  for (int layer = 0; layer < 32; layer++) {
    intersectScene(ray, si, false);
    if (!si.hit) return;
    OpenPbrResolvedMaterial material;
    getMaterial(material, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    if (material.materialType != SHADOW_CATCHER && material.alpha > 0.0) {
      out_depth.r = max(dot(si.position - eye, forward), 0.0);
      return;
    }
    ray.o = si.position + ray.d * (EPS * 0.02);
  }
}
`
});
