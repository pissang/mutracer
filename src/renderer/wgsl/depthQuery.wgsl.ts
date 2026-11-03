import { DEPTH_SAMPLE_GRID } from '../depthQuery.js';

/** Extra entry point in the ray-tracing module; reuses its scene bindings. */
export default /* wgsl */ `
@group(3) @binding(4) var<uniform> depthArea: vec4f;

@compute @workgroup_size(${DEPTH_SAMPLE_GRID}, ${DEPTH_SAMPLE_GRID})
fn depthQuery(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x + id.y * ${DEPTH_SAMPLE_GRID}u;
  let picking = depthArea.z < 0.0;
  if (picking && index != 0u) {return;}
  let offset = vec2f(id.xy) / ${DEPTH_SAMPLE_GRID - 1}.0 * 2.0 - 1.0;
  let uv = select(depthArea.xy + depthArea.zw * offset * vec2f(1.0, -1.0), depthArea.xy, picking);
  outColor[index] = vec4f(0.0);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return; }
  var ray = initCameraRay(uv);
  let eye = cameraUniform.viewInv[3].xyz;
  let forward = -normalize(cameraUniform.viewInv[2].xyz);
  var si: SurfaceInteraction;
  si.triangleIndex = -1;
  // Ignore invisible catchers and alpha-cutout holes, without stochastic DOF
  // or pixel jitter. A bounded continuation prevents coincident surfaces
  // from keeping the query alive indefinitely.
  for (var layer = 0; layer < 32; layer++) {
    intersectScene(ray, &si, 0, false, false);
    if (!si.hit) { return; }
    var material: OpenPbrResolvedMaterial;
    getMaterial(&material, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    if (material.materialType != SHADOW_CATCHER && material.alpha > 0.0) {
      if (picking) {
        let instance = u32(si.instanceIndex) + 1u;
        let materialIndex = u32(si.materialIndex) + 1u;
        outColor[index] = vec4f(f32(instance & 65535u), f32(instance >> 16u),
          f32(materialIndex & 65535u), f32(materialIndex >> 16u));
      } else {
        outColor[index] = vec4f(max(dot(si.position - eye, forward), 0.0), 0.0, 0.0, 0.0);
      }
      return;
    }
    ray.o = si.position + ray.d * (EPS * 0.02);
  }
}
`;
