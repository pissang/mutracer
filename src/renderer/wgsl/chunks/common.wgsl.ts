export default /* wgsl */ `

const PI = 3.14159265359;
const TWOPI = 6.28318530718;
const INVPI = 0.31830988618;
const INVPI2 = 0.10132118364;
const EPS = 0.0005;
const INV4PI = 0.07957747154594766;
const INF = 1.0e+38;
const ROUGHNESS_MIN = 0.001;

// Four float32 rounding units at the scale of the ray. The incoming point
// supplies a scale when reconstruction cancels near the coordinate origin.
fn rayRoundoff(position: vec3f, distance: f32) -> f32 {
  let p = abs(position);
  return max(max(p.x, max(p.y, p.z)), abs(distance)) * 4.7683716e-7;
}

fn surfaceRayRoundoff(position: vec3f, incomingOrigin: vec3f) -> f32 {
  return rayRoundoff(max(abs(position), abs(incomingOrigin)), 0.0);
}

fn offsetSurfaceRay(position: vec3f, geometricNormal: vec3f, direction: vec3f, incomingOrigin: vec3f) -> vec3f {
  let normal = select(-geometricNormal, geometricNormal, dot(geometricNormal, direction) >= 0.0);
  return position + normal * surfaceRayRoundoff(position, incomingOrigin);
}

// Include a coincident surface in the next query. The query excludes the
// source instance and primitive. After a second hit at the interface, step
// through it to keep the pair of surfaces from cycling.
fn transmissionRayOrigin(position: vec3f, direction: vec3f, incomingOrigin: vec3f) -> vec3f {
  let step = surfaceRayRoundoff(position, incomingOrigin);
  let near = distance(incomingOrigin, position) <= 2.0 * step;
  return position + select(-step, step, near) * direction;
}

`;
