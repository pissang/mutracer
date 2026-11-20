export default /* wgsl */ `
fn opticalReflectionImage(point: vec3f, normal: vec3f, endpoint: vec3f) -> vec3f {
  return endpoint - 2.0 * dot(endpoint - point, normal) * normal;
}

fn opticalImageMotion(
  current: vec3f,
  previous: vec3f,
  currentViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  extent: vec2f
) -> vec3f {
  let now = currentViewProjection * vec4f(current, 1.0);
  let old = previousViewProjection * vec4f(previous, 1.0);
  if (!(now.w > 0.0 && old.w > 0.0 &&
      all(abs(now) <= vec4f(3.402823e38)) && all(abs(old) <= vec4f(3.402823e38)))) {
    return vec3f(0.0);
  }
  let ndc = now.xyz / now.w;
  let priorNdc = old.xyz / old.w;
  if (any(abs(ndc) > vec3f(1.0)) || any(abs(priorNdc) > vec3f(1.0))) {
    return vec3f(0.0);
  }
  return vec3f((priorNdc.xy - ndc.xy) * extent * vec2f(0.5, -0.5), 1.0);
}

// Inverts the transmitted ray through a parallel slab in air. The caller
// verifies the two actual interfaces and visibility in the previous scene.
fn opticalSlabEntrance(
  facePoint: vec3f,
  faceNormal: vec3f,
  thickness: f32,
  ior: f32,
  eye: vec3f,
  endpoint: vec3f
) -> vec4f {
  let front = dot(eye - facePoint, faceNormal);
  let rear = -dot(endpoint - facePoint, faceNormal) - thickness;
  if (!(front > 0.0 && rear > 0.0 && thickness >= 0.0 && ior >= 1.0)) {
    return vec4f(0.0);
  }
  let separation = endpoint - eye;
  let lateral = separation - dot(separation, faceNormal) * faceNormal;
  let lateralDistance = length(lateral);
  let airDistance = front + rear;
  // Snell's law in tangent coordinates. The displacement is monotonic for
  // ior >= 1 and the no-slab tangent gives an upper bound.
  var low = 0.0;
  var high = lateralDistance / airDistance;
  let iorSquared = ior * ior;
  for (var i = 0u; i < 24u; i++) {
    let tangentAir = (low + high) * 0.5;
    let tangentGlass = tangentAir / sqrt(iorSquared + (iorSquared - 1.0) * tangentAir * tangentAir);
    let shift = airDistance * tangentAir + thickness * tangentGlass;
    if (shift < lateralDistance) { low = tangentAir; } else { high = tangentAir; }
  }
  let frontNormalProjection = eye - front * faceNormal;
  let frontShift = front * (low + high) * 0.5;
  return vec4f(frontNormalProjection + lateral * (frontShift / max(lateralDistance, 1e-20)), 1.0);
}
`;
