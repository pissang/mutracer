// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Keep unprojection in camera space to avoid cancellation from world translation.
export default /* glsl */ `
Ray initCameraRay(vec2 coord) {
  vec4 origin = projectionInv * vec4(coord * 2.0 - 1.0, -1.0, 1.0);
  vec4 center = projectionInv * vec4(coord * 2.0 - 1.0, 1.0, 1.0);
  vec3 direction = center.xyz * origin.w - origin.xyz * center.w;
  Ray cam;
  initRay(cam, (viewInv * vec4(origin.xyz / origin.w, 1.0)).xyz,
    normalize((viewInv * vec4(direction, 0.0)).xyz));
  return cam;
}
`;
