export default /* wgsl */ `fn groundedSurfaceDistance(point: vec3f, height: f32, radius: f32) -> f32 {
  let pointLength = length(point);
  if (pointLength < 0.00001) {
    return -radius;
  }

  let originalY = radius * point.y / pointLength;
  let transitionY = -1.5 * height;
  var surfaceRadius: f32;
  if (originalY >= 0.0) {
    surfaceRadius = radius;
  }
  else if (originalY < transitionY) {
    surfaceRadius = -height * pointLength / point.y;
  }
  else {
    let factor = 1.0
      - originalY * originalY / (3.0 * transitionY * transitionY);
    surfaceRadius = radius * factor;
  }
  return pointLength - surfaceRadius;
}

fn groundedBackgroundDirection(origin: vec3f, direction: vec3f) -> vec3f {
  if (!USE_GROUNDED_BACKGROUND) {
    return direction;
  }
  let params = rtUniform.groundedBackgroundParams;
  let rayDirection = normalize(direction);
  let center = vec3f(
    rtUniform.groundedBackgroundCenter.x,
    params.z + params.x,
    rtUniform.groundedBackgroundCenter.y
  );
  let localOrigin = origin - center;
  let projectedOrigin = dot(localOrigin, rayDirection);
  let discriminant = projectedOrigin * projectedOrigin
    - dot(localOrigin, localOrigin) + params.y * params.y;
  if (
    discriminant <= 0.0
    || groundedSurfaceDistance(localOrigin, params.x, params.y) > 0.0
  ) {
    return direction;
  }

  var farDistance = -projectedOrigin + sqrt(discriminant);
  if (farDistance <= 0.0) {
    return direction;
  }

  let sphereHit = localOrigin + rayDirection * farDistance;
  if (sphereHit.y >= 0.0) {
    return normalize(sphereHit);
  }

  if (rayDirection.y < -0.00001 && params.y > 1.5 * params.x) {
    let groundDistance = (-params.x - localOrigin.y) / rayDirection.y;
    let groundHit = localOrigin + rayDirection * groundDistance;
    let groundRadius = (2.0 / 3.0)
      * sqrt(params.y * params.y - 2.25 * params.x * params.x);
    if (groundDistance > 0.0 && length(groundHit.xz) <= groundRadius) {
      return normalize(groundHit);
    }
  }

  var nearDistance = 0.0;
  for (var i = 0; i < 14; i++) {
    let middleDistance = (nearDistance + farDistance) * 0.5;
    let middlePoint = localOrigin + rayDirection * middleDistance;
    if (groundedSurfaceDistance(middlePoint, params.x, params.y) > 0.0) {
      farDistance = middleDistance;
    }
    else {
      nearDistance = middleDistance;
    }
  }
  let hit = localOrigin + rayDirection * ((nearDistance + farDistance) * 0.5);
  return normalize(hit);
}

fn sampleSceneBackground(ray: Ray) -> vec4f {
  var bg = vec4f(0.0);
  if (USE_BACKGROUND_MAP) {
    let d = groundedBackgroundDirection(ray.o, ray.d);
    let t = rtUniform.backgroundMapTransform;
    let backgroundDirection = vec3f(t.x * d.x - t.y * d.z, d.y, t.y * d.x + t.x * d.z);
    let rotation = rtUniform.backgroundMapRotation;
    let mapDirection = transpose(mat3x3f(rotation[0].xyz, rotation[1].xyz, rotation[2].xyz)) * backgroundDirection;
    let backgroundSample = textureLinear(backgroundMap, cartesianToEquirect(mapDirection));
    bg = vec4f(backgroundSample.rgb * t.z, backgroundSample.a);
  }
  else if (USE_BACKGROUND) {
    bg = rtUniform.backgroundColor;
  }
  else if (USE_ENVMAP) {
    bg = textureLinear(envMap, environmentUv(ray.d));
  }
  return bg;
}

`;
