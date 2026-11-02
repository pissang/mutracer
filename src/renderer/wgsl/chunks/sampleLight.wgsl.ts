import {
  LIGHT_CHOICE_ANALYTIC,
  LIGHT_CHOICE_EMISSIVE_TRIANGLE,
  LIGHT_CHOICE_ENVIRONMENT
} from '../../lightConstants.js';

export default /*wgsl */ `
fn light_sample_sphere(light: Light, scatterPos: vec3f, randomV2: vec2f, lightSample: ptr<function, LightSampleRec>) {
  let centerOffset = light.position - scatterPos;
  let centerDistance = length(centerOffset);
  if (light.radiusOrSpread <= 0.0) {
    // A zero-radius sphere is a point emitter. The stored emission is
    // luminous intensity, so convert it to incident radiance here rather
    // than approximating the delta source as a tiny area sphere.
    if (centerDistance <= 1e-6) {
      (*lightSample).direction = vec3f(0.0, 0.0, 1.0);
      (*lightSample).normal = vec3f(0.0, 0.0, -1.0);
      (*lightSample).dist = 0.0;
      (*lightSample).pdf = 1.0;
      (*lightSample).emission = vec3f(0.0);
      (*lightSample).isDelta = true;
      return;
    }
    (*lightSample).direction = centerOffset / centerDistance;
    (*lightSample).normal = -(*lightSample).direction;
    (*lightSample).dist = centerDistance;
    (*lightSample).pdf = 1.0;
    (*lightSample).emission = light.emission /
      max(centerDistance * centerDistance, 1e-8);
    (*lightSample).isDelta = true;
    return;
  }
  let radius = max(light.radiusOrSpread, 1e-6);
  (*lightSample).isDelta = false;
  var sampledDirection: vec3f;

  if (centerDistance <= radius) {
    let z = 1.0 - 2.0 * randomV2.x;
    let radial = sqrt(max(0.0, 1.0 - z * z));
    let azimuth = TWOPI * randomV2.y;
    sampledDirection = vec3f(
      radial * cos(azimuth),
      radial * sin(azimuth),
      z
    );
    (*lightSample).pdf = INV4PI;
  }
  else {
    let sphereAxis = centerOffset / centerDistance;
    let sinThetaMaxSquared = min(
      1.0,
      radius * radius / (centerDistance * centerDistance)
    );
    let cosThetaMax = sqrt(max(0.0, 1.0 - sinThetaMaxSquared));
    // Rationalize 1 - cos(thetaMax): subtracting nearly equal f32 values
    // quantizes small emitters' solid angles into visible irradiance bands.
    let oneMinusCosThetaMax = sinThetaMaxSquared / (1.0 + cosThetaMax);
    let oneMinusCosTheta = randomV2.x * oneMinusCosThetaMax;
    let cosTheta = 1.0 - oneMinusCosTheta;
    let sinTheta = sqrt(max(0.0, oneMinusCosTheta * (2.0 - oneMinusCosTheta)));
    let azimuth = TWOPI * randomV2.y;
    var tangent: vec3f;
    var bitangent: vec3f;
    sampling_orthonormal_basis(sphereAxis, &tangent, &bitangent);
    sampledDirection = sphereAxis * cosTheta
      + tangent * (sinTheta * cos(azimuth))
      + bitangent * (sinTheta * sin(azimuth));
    (*lightSample).pdf = 1.0 / max(
      TWOPI * oneMinusCosThetaMax,
      1e-8
    );
  }

  let centerProjection = dot(sampledDirection, centerOffset);
  let centerOffsetSquared = dot(centerOffset, centerOffset);
  let discriminant = centerProjection * centerProjection
    - centerOffsetSquared + radius * radius;
  let nearDistance = centerProjection - sqrt(max(0.0, discriminant));
  let farDistance = centerProjection + sqrt(max(0.0, discriminant));
  (*lightSample).dist = select(farDistance, nearDistance, nearDistance > 1e-6);
  (*lightSample).direction = sampledDirection;
  let lightSurfacePos = scatterPos + sampledDirection * (*lightSample).dist;
  (*lightSample).normal = normalize(lightSurfacePos - light.position);
  (*lightSample).emission = light.emission;
}

fn light_apply_rect_texture(
  light: Light,
  surfacePoint: vec3f,
  lowerLeft: vec3f,
  result: ptr<function, LightSampleRec>
) {
  if (light.textureIndex < 0.0) {
    return;
  }
  let width = length(light.u);
  let height = length(light.v);
  let relative = surfacePoint - lowerLeft;
  let uv = vec2f(
    dot(relative, light.u / width) / width,
    dot(relative, light.v / height) / height
  );
  (*result).emission *= sampleMap(i32(light.textureIndex), uv).rgb;
}

fn light_sample_rect(
  light: Light,
  shadingPoint: vec3f,
  samplePoint: vec2f,
  result: ptr<function, LightSampleRec>
) {
  let normal = normalize(cross(light.u, light.v));
  let lowerLeft = light.position - 0.5 * (light.u + light.v);
  let spread = clamp(light.radiusOrSpread, 0.0, 1.0);

  if (spread <= 0.001) {
    let planeDistance = dot(normal, shadingPoint - light.position);
    let surfacePoint = shadingPoint - normal * planeDistance;
    let relative = surfacePoint - lowerLeft;
    let width = length(light.u);
    let height = length(light.v);
    let uv = vec2f(
      dot(relative, light.u / width) / width,
      dot(relative, light.v / height) / height
    );
    if (planeDistance <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
      (*result).emission = vec3f(0.0);
      (*result).pdf = 0.0;
      return;
    }
    (*result).direction = -normal;
    (*result).dist = planeDistance;
    (*result).normal = normal;
    (*result).emission = light.emission;
    (*result).pdf = 1.0;
    (*result).isDelta = true;
    light_apply_rect_texture(light, surfacePoint, lowerLeft, result);
    return;
  }

  let surfacePoint = lowerLeft
    + light.u * samplePoint.x
    + light.v * samplePoint.y;
  let offset = surfacePoint - shadingPoint;
  let distanceSquared = dot(offset, offset);
  (*result).dist = sqrt(distanceSquared);
  (*result).direction = offset / (*result).dist;
  (*result).normal = normal;
  let emitterCosine = dot(-(*result).direction, normal);
  let spreadCosine = cos(0.5 * PI * spread);
  if (emitterCosine <= 0.0 || emitterCosine < spreadCosine) {
    (*result).emission = vec3f(0.0);
    (*result).pdf = 0.0;
    return;
  }
  (*result).emission = light.emission;
  (*result).pdf = distanceSquared / max(light.area * emitterCosine, 1e-8);
  light_apply_rect_texture(light, surfacePoint, lowerLeft, result);
}

fn light_sample_directional(
  light: Light,
  result: ptr<function, LightSampleRec>
) {
  (*result).direction = normalize(-light.u);
  (*result).normal = -(*result).direction;
  (*result).emission = light.emission;
  (*result).dist = INF;
  (*result).pdf = 1.0;
  (*result).isDelta = true;
}

fn light_sample_spot(
  light: Light,
  shadingPoint: vec3f,
  samplePoint: vec2f,
  result: ptr<function, LightSampleRec>
) {
  light_sample_sphere(light, shadingPoint, samplePoint, result);
  let surfacePoint = shadingPoint + (*result).direction * (*result).dist;
  let lightToSurface = normalize(shadingPoint - surfacePoint);
  (*result).emission *= evaluateSpotEmissionMultiplier(light, lightToSurface);
}

fn sampleAnalyticLight(
  light: Light,
  shadingPoint: vec3f,
  samplePoint: vec2f,
  result: ptr<function, LightSampleRec>
) {
  let lightType = i32(light.litType);
  if (HAS_SCENE_RECT_LIGHT && lightType == RECT_LIGHT) {
    light_sample_rect(light, shadingPoint, samplePoint, result);
    return;
  }
  if (HAS_SCENE_SPHERE_LIGHT && lightType == SPHERE_LIGHT) {
    light_sample_sphere(light, shadingPoint, samplePoint, result);
    return;
  }
  if (HAS_SCENE_SPOT_LIGHT && lightType == SPOT_LIGHT) {
    light_sample_spot(light, shadingPoint, samplePoint, result);
    return;
  }
  if (HAS_SCENE_DIRECTIONAL_LIGHT && lightType == DIRECTIONAL_LIGHT) {
    light_sample_directional(light, result);
  }
}

fn sampleEnvLight(randomV2: vec2f, lightSample: ptr<function, LightSampleRec>) {
  var uv: vec2f;
  // Naga's SPIR-V writer cannot pass a struct-member pointer as a call argument.
  var pdf: f32;
  let direction = sampleEnvmap(randomV2, &uv, &pdf);
  (*lightSample).pdf = pdf;
  (*lightSample).direction = direction;
  (*lightSample).emission = textureLinear(envMap, uv).rgb;
  (*lightSample).dist = INF;
}

fn loadLightSamplingTexel(texelIndex: i32) -> vec4f {
  let width = rtUniform.lightSamplingTextureWidth;
  return textureLoad(
    lightSamplingData,
    vec2i(texelIndex % width, texelIndex / width),
    0
  );
}

fn getEmissiveTriangle(index: i32) -> EmissiveTriangle {
  let offset = index * 6;
  let a = loadLightSamplingTexel(offset);
  let b = loadLightSamplingTexel(offset + 1);
  let c = loadLightSamplingTexel(offset + 2);
  let d = loadLightSamplingTexel(offset + 3);
  let e = loadLightSamplingTexel(offset + 4);
  let f = loadLightSamplingTexel(offset + 5);
  return EmissiveTriangle(
    a.xyz, a.w,
    b.xyz, b.w,
    c.xyz, c.w,
    d.xy, d.zw, e.xy,
    e.zw, f.xy, f.zw
  );
}

fn getLightChoice(index: i32) -> LightChoice {
  let data = loadLightSamplingTexel(rtUniform.lightChoiceTexelOffset + index);
  return LightChoice(
    data.x,
    bitcast<i32>(data.y),
    bitcast<i32>(data.z),
    bitcast<i32>(data.w)
  );
}

fn getLightChoiceFromTable(tableOffset: i32, index: i32) -> LightChoice {
  return getLightChoice(tableOffset + index);
}

fn stratifyLightChoiceRandom(
  rnd: vec3f,
  candidateIndex: u32,
  candidateCount: u32
) -> vec3f {
  var stratified = rnd;
  let count = max(candidateCount, 1u);
  stratified.z = (rnd.z + f32(min(candidateIndex, count - 1u))) /
    f32(count);
  return stratified;
}

fn sampleEmissiveTriangleLight(
  triangle: EmissiveTriangle,
  scatterPos: vec3f,
  randomV2: vec2f,
  lightSample: ptr<function, LightSampleRec>
) {
  let sqrtU = sqrt(randomV2.x);
  let barycentric = vec3f(
    1.0 - sqrtU,
    sqrtU * (1.0 - randomV2.y),
    sqrtU * randomV2.y
  );
  let lightPosition =
    barycentric.x * triangle.p0 +
    barycentric.y * triangle.p1 +
    barycentric.z * triangle.p2;
  let uv =
    barycentric.x * triangle.uv0 +
    barycentric.y * triangle.uv1 +
    barycentric.z * triangle.uv2;
  let secondaryUv =
    barycentric.x * triangle.secondaryUv0 +
    barycentric.y * triangle.secondaryUv1 +
    barycentric.z * triangle.secondaryUv2;
  let normal = normalize(cross(triangle.p1 - triangle.p0, triangle.p2 - triangle.p0));
  (*lightSample).direction = lightPosition - scatterPos;
  (*lightSample).dist = length((*lightSample).direction);
  if ((*lightSample).dist <= EPS) {
    (*lightSample).emission = vec3f(0.0);
    (*lightSample).pdf = 0.0;
    return;
  }
  (*lightSample).direction /= (*lightSample).dist;
  (*lightSample).normal = normal;
  let cosLight = dot(normal, -(*lightSample).direction);
  if (cosLight <= 0.0) {
    (*lightSample).emission = vec3f(0.0);
    (*lightSample).pdf = 0.0;
    return;
  }
  (*lightSample).emission = getMaterialEmission(
    i32(triangle.materialIndex), uv, secondaryUv
  );
  (*lightSample).selectionPmf = triangle.selectionPmf;
  (*lightSample).pdf = triangle.selectionPmf *
    ((*lightSample).dist * (*lightSample).dist) /
    max(triangle.area * cosLight, 1e-8);
}

fn sampleLightChoiceTable(
  scatterPos: vec3f,
  rnd: vec3f,
  tableOffset: i32,
  choiceCount: i32,
  selectionPmfScale: f32,
  lightSample: ptr<function, LightSampleRec>
) {
  (*lightSample).emission = vec3f(0.0);
  (*lightSample).pdf = 0.0;
  (*lightSample).selectionPmf = 0.0;
  (*lightSample).dist = INF;
  (*lightSample).isDelta = false;
  (*lightSample).sourceType = 0u;
  (*lightSample).sourceIndex = 0xffffffffu;
  if (choiceCount <= 0) {
    return;
  }

  let scaledChoice = rnd.z * f32(choiceCount);
  let column = min(i32(scaledChoice), choiceCount - 1);
  let columnChoice = getLightChoiceFromTable(tableOffset, column);
  let selectedIndex = select(
    columnChoice.aliasIndex,
    column,
    fract(scaledChoice) < columnChoice.probability
  );
  let choice = getLightChoiceFromTable(tableOffset, selectedIndex);
  if (USE_ENVMAP && choice.sourceType == ${LIGHT_CHOICE_ENVIRONMENT}) {
    (*lightSample).sourceType = 0u;
    (*lightSample).sourceIndex = u32(choice.sourceIndex);
    sampleEnvLight(rnd.xy, lightSample);
    (*lightSample).selectionPmf = rtUniform.envLightPmf;
    (*lightSample).pdf *= rtUniform.envLightPmf;
  }
  else if (choice.sourceType == ${LIGHT_CHOICE_ANALYTIC}) {
    (*lightSample).sourceType = 2u;
    (*lightSample).sourceIndex = u32(choice.sourceIndex);
    let light = analyticLights[choice.sourceIndex];
    sampleAnalyticLight(light, scatterPos, rnd.xy, lightSample);
    (*lightSample).selectionPmf = light.selectionPmf;
    (*lightSample).pdf *= light.selectionPmf;
  }
  else if (HAS_SCENE_EMISSIVE_LIGHT && choice.sourceType == ${LIGHT_CHOICE_EMISSIVE_TRIANGLE}) {
    (*lightSample).sourceType = 1u;
    (*lightSample).sourceIndex = u32(choice.sourceIndex);
    sampleEmissiveTriangleLight(
      getEmissiveTriangle(choice.sourceIndex),
      scatterPos,
      rnd.xy,
      lightSample
    );
  }
  (*lightSample).selectionPmf *= selectionPmfScale;
  (*lightSample).pdf *= selectionPmfScale;
}

fn sampleLight(
  scatterPos: vec3f,
  rnd: vec3f,
  lightSample: ptr<function, LightSampleRec>,
  distByIntensity: bool
) {
  sampleLightChoiceTable(
    scatterPos,
    rnd,
    0,
    rtUniform.lightChoiceCount,
    1.0,
    lightSample
  );
}

// Light choice for one of the resampled NEE candidates. The selection random
// number is stratified across the candidates.
fn sampleLightForNEECandidate(
  scatterPos: vec3f,
  rnd: vec3f,
  candidateIndex: u32,
  candidateCount: u32,
  lightSample: ptr<function, LightSampleRec>
) {
  sampleLightChoiceTable(
    scatterPos,
    stratifyLightChoiceRandom(rnd, candidateIndex, candidateCount),
    0,
    rtUniform.lightChoiceCount,
    1.0,
    lightSample
  );
}
`;
