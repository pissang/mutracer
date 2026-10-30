import emissive from './emissiveLight.glsl.js';
import { glsl } from '../../shader.js';

export default glsl`
#ifdef NUM_LIGHTS
void light_sample_sphere(
  in Light light,
  in vec3 shadingPoint,
  in vec2 samplePoint,
  inout LightSampleRec result
) {
  vec3 toCenter = light.position - shadingPoint;
  float centerDistance = length(toCenter);
  if (light.radius <= 0.0) {
    if (centerDistance <= 1e-6) {
      result.direction = vec3(0.0, 0.0, 1.0);
      result.normal = vec3(0.0, 0.0, -1.0);
      result.dist = 0.0;
      result.pdf = 1.0;
      result.emission = vec3(0.0);
      result.isDelta = true;
      return;
    }
    result.direction = toCenter / centerDistance;
    result.normal = -result.direction;
    result.dist = centerDistance;
    result.pdf = 1.0;
    result.emission = light.emission / max(centerDistance * centerDistance, 1e-8);
    result.isDelta = true;
    return;
  }
  float radius = max(light.radius, 1e-6);
#ifdef HAS_EMISSIVE_LIGHTS
  sampleEmissiveSceneLight(shadingPoint,randomSampleValue,result);return;
#endif
  result.sourceType=0;result.sourceIndex=-1;
  result.isDelta = false;
  vec3 direction;

  if (centerDistance <= radius) {
    float z = 1.0 - 2.0 * samplePoint.x;
    float radial = sqrt(max(0.0, 1.0 - z * z));
    float azimuth = TWOPI * samplePoint.y;
    direction = vec3(radial * cos(azimuth), radial * sin(azimuth), z);
    result.pdf = INV4PI;
  }
  else {
    vec3 axis = toCenter / centerDistance;
    float sineLimitSquared = min(
      1.0,
      radius * radius / (centerDistance * centerDistance)
    );
    float cosineLimit = sqrt(max(0.0, 1.0 - sineLimitSquared));
    // Keep the small solid angle and sampled sine without subtracting
    // nearly equal floats; otherwise small emitters produce irradiance bands.
    float oneMinusCosineLimit = sineLimitSquared / (1.0 + cosineLimit);
    float oneMinusCosine = samplePoint.x * oneMinusCosineLimit;
    float cosine = 1.0 - oneMinusCosine;
    float sine = sqrt(max(0.0, oneMinusCosine * (2.0 - oneMinusCosine)));
    float azimuth = TWOPI * samplePoint.y;
    vec3 tangent;
    vec3 bitangent;
    sampling_orthonormal_basis(axis, tangent, bitangent);
    direction = axis * cosine
      + tangent * (sine * cos(azimuth))
      + bitangent * (sine * sin(azimuth));
    result.pdf = 1.0 / max(TWOPI * oneMinusCosineLimit, 1e-8);
  }

  float projectedCenter = dot(direction, toCenter);
  float discriminant = projectedCenter * projectedCenter
    - dot(toCenter, toCenter) + radius * radius;
  float root = sqrt(max(0.0, discriminant));
  float nearDistance = projectedCenter - root;
  float farDistance = projectedCenter + root;
  result.dist = nearDistance > 1e-6 ? nearDistance : farDistance;
  result.direction = direction;
  vec3 surfacePoint = shadingPoint + direction * result.dist;
  result.normal = normalize(surfacePoint - light.position);
  result.emission = light.emission;
}

void light_apply_rect_texture(
  in Light light,
  in vec3 surfacePoint,
  in vec3 lowerLeft,
  inout LightSampleRec result
) {
#ifdef NUM_MAPS
  if (light.textureIndex >= 0) {
    float width = length(light.u);
    float height = length(light.v);
    vec3 relative = surfacePoint - lowerLeft;
    vec2 uv = vec2(
      dot(relative, light.u / width) / width,
      dot(relative, light.v / height) / height
    );
    result.emission *= sampleMap(light.textureIndex, uv).rgb;
  }
#endif
}

void light_sample_rect(
  in Light light,
  in vec3 shadingPoint,
  in vec2 samplePoint,
  inout LightSampleRec result
) {
  vec3 normal = normalize(cross(light.u, light.v));
  vec3 lowerLeft = light.position - 0.5 * (light.u + light.v);
  float spread = clamp(light.spread, 0.0, 1.0);

  if (spread <= 0.001) {
    float planeDistance = dot(normal, shadingPoint - light.position);
    vec3 surfacePoint = shadingPoint - normal * planeDistance;
    vec3 relative = surfacePoint - lowerLeft;
    float width = length(light.u);
    float height = length(light.v);
    vec2 uv = vec2(
      dot(relative, light.u / width) / width,
      dot(relative, light.v / height) / height
    );
    if (planeDistance <= 0.0 || any(lessThan(uv, vec2(0.0)))
      || any(greaterThan(uv, vec2(1.0)))) {
      result.emission = vec3(0.0);
      result.pdf = 0.0;
      return;
    }
    result.direction = -normal;
    result.dist = planeDistance;
    result.normal = normal;
    result.emission = light.emission;
    result.pdf = 1.0;
    result.isDelta = true;
    light_apply_rect_texture(light, surfacePoint, lowerLeft, result);
    return;
  }

  vec3 surfacePoint = lowerLeft
    + light.u * samplePoint.x
    + light.v * samplePoint.y;
  vec3 offset = surfacePoint - shadingPoint;
  float distanceSquared = dot(offset, offset);
  result.dist = sqrt(distanceSquared);
  result.direction = offset / result.dist;
  result.normal = normal;
  float emitterCosine = dot(-result.direction, normal);
  float spreadCosine = cos(0.5 * PI * spread);
  if (emitterCosine <= 0.0 || emitterCosine < spreadCosine) {
    result.emission = vec3(0.0);
    result.pdf = 0.0;
    return;
  }
  result.emission = light.emission;
  result.pdf = distanceSquared / max(light.area * emitterCosine, 1e-8);
  light_apply_rect_texture(light, surfacePoint, lowerLeft, result);
}

void light_sample_directional(
  in Light light,
  in vec3 shadingPoint,
  inout LightSampleRec result
) {
  result.direction = normalize(-light.u);
  result.normal = -result.direction;
  result.emission = light.emission;
  result.dist = INF;
  result.pdf = 1.0;
  result.isDelta = true;
}

void light_sample_spot(
  in Light light,
  in vec3 shadingPoint,
  in vec2 samplePoint,
  inout LightSampleRec result
) {
  light_sample_sphere(light, shadingPoint, samplePoint, result);
  vec3 surfacePoint = shadingPoint + result.direction * result.dist;
  result.emission *= evaluateSpotEmissionMultiplier(
    light,
    normalize(shadingPoint - surfacePoint)
  );
}

void sampleAnalyticLight(
  in Light light,
  in vec3 shadingPoint,
  in vec2 samplePoint,
  inout LightSampleRec result
) {
  int lightType = int(light.type);
#ifdef HAS_RECT_LIGHTS
  if (lightType == RECT_LIGHT) {
    light_sample_rect(light, shadingPoint, samplePoint, result);
    return;
  }
#endif
#ifdef HAS_SPHERE_LIGHTS
  if (lightType == SPHERE_LIGHT) {
    light_sample_sphere(light, shadingPoint, samplePoint, result);
    return;
  }
#endif
#ifdef HAS_SPOT_LIGHTS
  if (lightType == SPOT_LIGHT) {
    light_sample_spot(light, shadingPoint, samplePoint, result);
    return;
  }
#endif
#ifdef HAS_DIRECTIONAL_LIGHTS
  if (lightType == DIRECTIONAL_LIGHT) {
    light_sample_directional(light, shadingPoint, result);
  }
#endif
}
#endif

void sampleEnvLight(in vec2 samplePoint, inout LightSampleRec result) {
  vec2 uv;
  result.direction = sampleEnvmap(samplePoint, uv, result.pdf);
  result.emission = textureLinear(envMap, uv).rgb;
  result.dist = INF;
}

#ifdef HAS_EMISSIVE_LIGHTS
${emissive}
#endif

void sampleLight(
  in vec3 shadingPoint,
  in vec3 randomSampleValue,
  inout LightSampleRec result,
  bool distByIntensity
) {
#ifdef HAS_EMISSIVE_LIGHTS
  sampleEmissiveSceneLight(shadingPoint,randomSampleValue,result);return;
#endif
  result.sourceType=0;result.sourceIndex=-1;
  result.isDelta = false;
  float selector = randomSampleValue.z;
  bool choseEnvironment = false;
#ifdef USE_ENVMAP
  choseEnvironment = selector < envLightSelectionPmf;
  if (choseEnvironment) {
    sampleEnvLight(randomSampleValue.xy, result);
    result.pdf *= envLightSelectionPmf;
  }
#endif

#ifdef NUM_LIGHTS
  if (!choseEnvironment) {
    int selectedIndex = NUM_LIGHTS - 1;
    for (int index = 0; index < NUM_LIGHTS; index++) {
      if (selector < fetchLight(index).selectionCdf) {
        selectedIndex = index;
        break;
      }
    }
    result.sourceType=2;result.sourceIndex=selectedIndex;
    Light selectedLight = fetchLight(selectedIndex);
    sampleAnalyticLight(
      selectedLight,
      shadingPoint,
      randomSampleValue.xy,
      result
    );
    result.pdf *= selectedLight.selectionPmf;
  }
#endif
}
`;
