export default /* wgsl */ `

const PI = 3.14159265359;
const TWOPI = 6.28318530718;
const INVPI = 0.31830988618;
const INVPI2 = 0.10132118364;
const EPS = 0.0005;
const INV4PI = 0.07957747154594766;
const INF = 1.0e+38;
const ROUGHNESS_MIN = 0.001;

// Ray Tracing Gems, Wachter/Binder: move along the geometric normal by
// representable floats rather than stepping along the ray across a corner.
fn offsetSurfaceRay(position: vec3f, geometricNormal: vec3f, direction: vec3f) -> vec3f {
  let normal = select(-geometricNormal, geometricNormal, dot(geometricNormal, direction) >= 0.0);
  let integerOffset = vec3i(256.0 * normal);
  let bits = bitcast<vec3i>(position);
  let shifted = bitcast<vec3f>(bits + select(integerOffset, -integerOffset, position < vec3f(0.0)));
  return select(shifted, position + normal / 65536.0, abs(position) < vec3f(1.0 / 32.0));
}

// A continuation excludes its source triangle. Include the surface point in
// the next query so a second dielectric sharing that point is still visible.
// Once the second face is reached, advance past both to avoid cycling.
fn transmissionRayOrigin(position: vec3f, direction: vec3f, incomingOrigin: vec3f) -> vec3f {
  let magnitude = max(abs(position), vec3f(1.0));
  let step = max(max(magnitude.x, magnitude.y), magnitude.z) * 4.7683716e-7;
  let near = distance(incomingOrigin, position) <= 2.0 * step;
  return position + select(-step, step, near) * direction;
}

`;
