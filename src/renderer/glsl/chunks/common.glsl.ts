// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { glsl } from '../../shader.js';

export default glsl`
#define PI 3.14159265359
#define TWOPI 6.28318530718
#define INVPI 0.31830988618
#define INVPI2 0.10132118364
#define EPS 0.0005
#define INF 1.0e999
#define INV4PI 0.07957747154594766

#define ROUGHNESS_MIN 0.001

#ifdef HAS_ADJACENT_MEDIA
vec3 transmissionRayOrigin(vec3 position, vec3 direction, vec3 incomingOrigin) {
  vec3 magnitude = max(abs(position), vec3(1.0));
  float stepSize = max(max(magnitude.x, magnitude.y), magnitude.z) * 4.7683716e-7;
  bool nearBoundary = distance(incomingOrigin, position) <= 2.0 * stepSize;
  return position + (nearBoundary ? stepSize : -stepSize) * direction;
}
#endif

`;
