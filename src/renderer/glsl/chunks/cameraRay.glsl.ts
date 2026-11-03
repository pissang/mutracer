// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import cameraProjection from './cameraProjection.glsl.js';

// Shared primary-ray construction keeps beauty and catcher coverage aligned.
export default /* glsl */ `
${cameraProjection}
vec2 sampleCircle(vec2 p) {
  p = 2.0 * p - 1.0;
  bool greater = abs(p.x) > abs(p.y);
  float r = greater ? p.x : p.y;
  float theta = greater ? 0.25 * PI * p.y / p.x : PI * (0.5 - 0.25 * p.x / p.y);
  return r * vec2(cos(theta), sin(theta));
}

Ray primaryCameraRay() {
  Ray cam = initCameraRay(v_Texcoord + pixelJitter());
  if (cameraApertureRadius > 0.0) {
    // Thin lens: the focus plane is perpendicular to the view direction.
    vec3 eye = viewInv[3].xyz;
    vec3 forward = -normalize(viewInv[2].xyz);
    vec3 focusPoint = eye + cam.d * (cameraFocusDistance / dot(cam.d, forward));
    vec2 lensPoint = cameraApertureRadius * sampleCircle(sample2D(CAMERA_LENS));
    vec3 origin = vec3(viewInv * vec4(lensPoint, 0.0, 1.0));
    initRay(cam, origin, normalize(focusPoint - origin));
  }
  return cam;
}
`;
