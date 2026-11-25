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

float rayRoundoff(vec3 position, float distance) {
  vec3 p = abs(position);
  return max(max(p.x, max(p.y, p.z)), abs(distance)) * 4.7683716e-7;
}

float surfaceRayRoundoff(vec3 position, vec3 incomingOrigin) {
  return rayRoundoff(max(abs(position), abs(incomingOrigin)), 0.0);
}

vec3 offsetSurfaceRay(vec3 position, vec3 geometricNormal, vec3 direction, vec3 incomingOrigin) {
  vec3 normal = dot(geometricNormal, direction) >= 0.0 ? geometricNormal : -geometricNormal;
  return position + normal * surfaceRayRoundoff(position, incomingOrigin);
}

vec3 transmissionRayOrigin(vec3 position, vec3 direction, vec3 incomingOrigin) {
  float stepSize = surfaceRayRoundoff(position, incomingOrigin);
  bool nearBoundary = distance(incomingOrigin, position) <= 2.0 * stepSize;
  return position + (nearBoundary ? stepSize : -stepSize) * direction;
}

`;
