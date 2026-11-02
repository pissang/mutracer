import {MAX_PATH_EVENTS} from '../../pathLimits.js';
export const fogGlsl = /* glsl */ `
vec2 fogInterval(Ray ray, int index, float maximum) {
  vec3 origin = (fogWorldToLocal[index] * vec4(ray.o, 1.0)).xyz;
  vec3 direction = (fogWorldToLocal[index] * vec4(ray.d, 0.0)).xyz;
  if (fogParams[index].w > 0.5) {
    float a = dot(direction, direction);
    float center = -dot(origin, direction) / a;
    vec3 closest = origin + center * direction;
    float radius2 = (1.0 - dot(closest, closest)) / a;
    if (radius2 < 0.0 || a <= 0.0) return vec2(0.0);
    float radius = sqrt(radius2), near = max(0.0, center - radius);
    return vec2(near, max(near, min(maximum, center + radius)));
  }
  float near = 0.0, far = maximum;
  for (int axis = 0; axis < 3; axis++) {
    if (direction[axis] == 0.0) {
      if (abs(origin[axis]) > 1.0) return vec2(0.0);
    } else {
      float a = (-1.0 - origin[axis]) / direction[axis];
      float b = (1.0 - origin[axis]) / direction[axis];
      near = max(near, min(a, b)); far = min(far, max(a, b));
    }
  }
  return vec2(near, max(near, far));
}
float fogOpticalDepth(Ray ray, int index, vec2 interval) {
  float segmentLength = interval.y - interval.x, density = fogParams[index].x;
  if (segmentLength <= 0.0 || density <= 0.0) return 0.0;
  float k = fogParams[index].y;
  if (k == 0.0) return density * segmentLength;
  float s = k * ray.d.y, z = s * segmentLength;
  float enterY = ray.o.y + interval.x * ray.d.y;
  float logTau;
  if (abs(z) < 0.01) {
    float z2 = z * z;
    logTau = log(density) - k * (enterY - fogParams[index].z) + log(segmentLength) - 0.5 * z + z2 / 24.0 - z2 * z2 / 2880.0;
  } else {
    float denseY = s < 0.0 ? ray.o.y + interval.y * ray.d.y : enterY;
    logTau = log(density) - k * (denseY - fogParams[index].z) + log(1.0 - exp(-abs(z))) - log(abs(s));
  }
  return exp(clamp(logTau, -100.0, 80.0));
}
float fogDistance(Ray ray, int index, vec2 interval, float opticalTarget) {
  float density = fogParams[index].x;
  if (density <= 0.0) return INF;
  if (fogParams[index].y == 0.0) return interval.x + opticalTarget / density;
  if (opticalTarget >= fogOpticalDepth(ray, index, interval)) return INF;
  float k = fogParams[index].y, s = k * ray.d.y;
  float logA = log(density) - k * (ray.o.y + interval.x * ray.d.y - fogParams[index].z);
  float logDistance = log(opticalTarget) - logA;
  if (s == 0.0) return interval.x + exp(clamp(logDistance, -100.0, 80.0));
  float q = logDistance + log(abs(s)), segmentLength;
  if (q < -5.0) {
    float u = exp(q), signedU = s > 0.0 ? u : -u;
    segmentLength = exp(clamp(logDistance, -100.0, 80.0)) * (1.0 + signedU * 0.5 + u * u / 3.0 + signedU * u * u * 0.25);
  } else if (s > 0.0) {
    if (q >= 0.0) return INF;
    segmentLength = -log(1.0 - exp(q)) / s;
  } else {
    segmentLength = q > 40.0 ? q / -s : log(1.0 + exp(q)) / -s;
  }
  return interval.x + segmentLength;
}
float fogTransmittance(Ray ray, float maximum) {
  float tau = 0.0;
  for (int i = 0; i < fogCount; i++) tau += fogOpticalDepth(ray, i, fogInterval(ray, i, maximum));
  return exp(-tau);
}
`;
export const fogPathGlsl = /* glsl */ `
void fogGuides(Ray ray, float maximum, inout RayTraceAuxiliary outAux) {
  float tau = 0.0, weight = 0.0; vec3 albedo = vec3(0.0);
  for (int i = 0; i < fogCount; i++) {
    float opticalDepth = fogOpticalDepth(ray, i, fogInterval(ray, i, maximum));
    float w = 1.0 - exp(-opticalDepth);
    tau += opticalDepth; weight += w; albedo += w * fogColorAnisotropy[i].rgb;
  }
  float tr = exp(-tau);
  if (weight > 0.0) {
    outAux.albedo = tr * outAux.albedo + (1.0 - tr) * albedo / weight;
    outAux.normal *= tr; outAux.isBlank = false;
  }
}
float fogSegmentMaximum(Path path, SurfaceInteraction si) {
  float maximum = si.hit ? distance(si.position, path.ray.o) : INF;
  // Match primary and alpha-null visibility in the surface integrator.
  if (path.fromEye) return maximum;
#ifdef NUM_LIGHTS
  for (int i = 0; i < NUM_LIGHTS; i++) {
    LightSampleRec lightHit;
    float d = intersectLight(path.ray, fetchLight(i), lightHit);
    if (d > 0.0) maximum = min(maximum, d);
  }
#endif
  return maximum;
}
int sampleFogEvent(inout Path path, inout SurfaceInteraction si, float maximum, bool resample) {
  if (si.mediumType > 0 || si.fogSuppressed) return -1;
  float nearest = maximum; int winner = -1;
  for (int i = 0; i < fogCount; i++) {
    vec2 interval = fogInterval(path.ray, i, maximum);
    if (interval.y <= interval.x || fogParams[i].x <= 0.0) continue;
    float u = sample1D(bounceDim(BOUNCE_STRIDE - 1u - uint(i)));
    if (resample) u = hashedSample(0xf091u + uint(i));
    // Undo the surface sampler's endpoint remapping for unbiased free flight.
    u = clamp((u - EPS) / (1.0 - 2.0 * EPS), 0.0, 1.0 - 1.0 / 16777216.0);
    float candidate = fogDistance(path.ray, i, interval, -log(max(1.0 - u, 1e-7)));
    if (candidate < interval.y && candidate < nearest) { nearest = candidate; winner = i; }
  }
  if (winner >= 0) {
    path.ray.o += nearest * path.ray.d; si.position = path.ray.o;
    si.triangleIndex = -1; si.instanceIndex = -1;
  }
  return winner;
}
void shadeFogVertex(inout Path path, inout SurfaceInteraction si, int winner, inout int depth) {
  path.beta *= fogColorAnisotropy[winner].rgb; path.alpha = 1.0; path.fogScattered = true;
  if (max(max(path.beta.x, path.beta.y), path.beta.z) <= 0.0) { path.abort = true; return; }
  float originalAnisotropy = si.mediumAnisotropy;
  si.mediumAnisotropy = fogColorAnisotropy[winner].w;
  OpenPbrResolvedMaterial material; OpenPbrPreparedBsdf prepared;
  path.li += path.beta * DirectLight(si, material, prepared, path, vec3(0.0), false);
  vec3 direction = sampling_henyey_greenstein(-path.ray.d, si.mediumAnisotropy, sample2D(bounceDim(PHASE_DIRECTION)));
  path.scatteringPdf = sampling_henyey_greenstein_phase(dot(direction, -path.ray.d), si.mediumAnisotropy);
  si.mediumAnisotropy = originalAnisotropy;
  initRay(path.ray, path.ray.o, direction);
  path.scatteringIsDelta = false; path.fromEye = false; path.isNextRefraction = false;
  depth++;
#ifdef USE_RR
  if (depth >= RR_MAX) {
    float survival = min(1.0, max(max(path.beta.x, path.beta.y), path.beta.z));
    if (sample1D(bounceDim(RUSSIAN_ROULETTE)) >= survival) path.abort = true;
    else path.beta /= survival;
  }
#endif
}
vec4 integrateFogPath(SurfaceInteraction si, Ray ray, OpenPbrResolvedMaterial mat, inout RayTraceAuxiliary outAux) {
  Path path; path.ray = ray; path.beta = vec3(1.0); path.li = vec3(0.0); path.fromEye = true; path.abort = false;
  path.alpha = transmissiveOutputAlphaMin < 1.0 ? 0.0 : 1.0;
  path.scatteringPdf = 0.0; path.scatteringIsDelta = false; path.isNextRefraction = false; path.fogScattered = false;
  Path originalPath = path; SurfaceInteraction primarySi = si; OpenPbrResolvedMaterial primaryMat = mat;
  RayTraceAuxiliary originalAux = outAux, backAux;
  float coverage = 1.0; bool split = false, front = false; vec4 back;
  int depth = 0, event = 0;
  bool isOpaque = !si.isTransparency;
  bool originalOpaque = isOpaque;
  bool query = false, resample = false, skipFog = false, first = true;
  int limit = min(bounceLimit * 3, ${MAX_PATH_EVENTS});
  for (int step = 0; step < ${(MAX_PATH_EVENTS + 1) * 2 + 2}; step++) {
    if (query) {
      intersectScene(path.ray, si, event != 0);
      getMaterial(mat, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    }
    query = true; samplingBounce = uint(depth);
    int winner = -1;
    float maximum = fogSegmentMaximum(path, si);
    if (!skipFog) winner = sampleFogEvent(path, si, maximum, resample);
    skipFog = false;
    if (winner >= 0) {
      // Match the surface event budget; camera fog establishes opacity.
      if (event == 0) isOpaque = true;
      if ((isOpaque && event > bounceLimit) || event >= limit) path.abort = true;
      else shadeFogVertex(path, si, winner, depth);
      first = false; resample = false; event++;
    } else {
      if (first && path.fromEye && si.hit && (mat.materialType == STANDARD || mat.materialType == UNLIT) && mat.alpha < 1.0) {
        split = true; coverage = clamp(mat.alpha, 0.0, 1.0); primarySi = si; primaryMat = mat;
        path.ray.o = si.position + ray.d * (EPS * 0.02); first = false; resample = true; continue;
      }
      first = false;
      if (event > 0 || maximum < (si.hit ? distance(si.position, path.ray.o) : INF)) { int completionDepth = depth; completeFogVertex(path, completionDepth, si, mat, resample); }
      if (!path.abort && ((isOpaque && event > bounceLimit) || event >= limit)) path.abort = true;
      if (!path.abort) {
        si.fogResample = false;
        bounce(path, depth, si, mat, outAux);
        resample = si.fogResample;
        if (!resample) depth++;
      }
      event++;
    }
    if (path.abort) {
      vec4 result = vec4(path.li, path.alpha);
      if (!split || coverage <= 0.0) return result;
      if (front) {
        outAux.albedo = mix(backAux.albedo, outAux.albedo, coverage);
        outAux.normal = mix(backAux.normal, outAux.normal, coverage);
        outAux.isBlank = backAux.isBlank && outAux.isBlank;
        outAux.isShadowCatcher = backAux.isShadowCatcher && outAux.isShadowCatcher;
        return mix(back, result, coverage);
      }
      back = result; backAux = outAux; front = true;
      path = originalPath; si = primarySi; mat = primaryMat; mat.alpha = 1.0; outAux = originalAux;
      isOpaque = originalOpaque;
      depth = 0; event = 0; query = false; resample = false; skipFog = true;
    }
  }
  return vec4(path.li, path.alpha);
}
`;
