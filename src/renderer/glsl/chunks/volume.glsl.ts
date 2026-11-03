import {prefixCheckpoint, prefixSave, prefixRestore, prefixRandomBindings, type PrefixBindings} from './spectralPrefix.glsl.js';
import {volumeTrackingGlsl, volumeNoiseGuidesGlsl} from './volumeTracking.glsl.js';
import {MAX_PATH_EVENTS_WEBGL} from '../../pathLimits.js';
export function createVolumeGlsl(hasVolumeNoise = false) { return /* glsl */ `
vec2 volumeInterval(Ray ray, int index, float maximum) {
  vec3 origin = (volumeWorldToLocal[index] * vec4(ray.o, 1.0)).xyz;
  vec3 direction = (volumeWorldToLocal[index] * vec4(ray.d, 0.0)).xyz;
  if (volumeParams[index].w > 0.5) {
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
float volumeOpticalDepth(Ray ray, int index, vec2 interval) {
  float segmentLength = interval.y - interval.x, density = volumeParams[index].x;
  if (segmentLength <= 0.0 || density <= 0.0) return 0.0;
  float k = volumeParams[index].y;
  if (k == 0.0) return density * segmentLength;
  float s = k * ray.d.y, z = s * segmentLength;
  float enterY = ray.o.y + interval.x * ray.d.y;
  float logTau;
  if (abs(z) < 0.01) {
    float z2 = z * z;
    logTau = log(density) - k * (enterY - volumeParams[index].z) + log(segmentLength) - 0.5 * z + z2 / 24.0 - z2 * z2 / 2880.0;
  } else {
    float denseY = s < 0.0 ? ray.o.y + interval.y * ray.d.y : enterY;
    logTau = log(density) - k * (denseY - volumeParams[index].z) + log(1.0 - exp(-abs(z))) - log(abs(s));
  }
  return exp(clamp(logTau, -100.0, 80.0));
}
float volumeDistance(Ray ray, int index, vec2 interval, float opticalTarget) {
  float density = volumeParams[index].x;
  if (density <= 0.0) return INF;
  if (volumeParams[index].y == 0.0) return interval.x + opticalTarget / density;
  if (opticalTarget >= volumeOpticalDepth(ray, index, interval)) return INF;
  float k = volumeParams[index].y, s = k * ray.d.y;
  float logA = log(density) - k * (ray.o.y + interval.x * ray.d.y - volumeParams[index].z);
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
float volumeTransmittance(Ray ray, float maximum) {
  float tau = 0.0;
  for (int i = 0; i < volumeCount; i++) tau += volumeOpticalDepth(ray, i, volumeInterval(ray, i, maximum));
  return exp(-tau);
}
${hasVolumeNoise ? volumeTrackingGlsl + '\n' : ''}`;
}
export function createVolumePathGlsl(hasVolumeNoise = false, sharePrefix = false) {
  const bindings: PrefixBindings = {
    path: ['Path', 'path'], si: ['SurfaceInteraction', 'si'], mat: ['OpenPbrResolvedMaterial', 'mat'],
    aux: ['RayTraceAuxiliary', 'outAux'], depth: ['int', 'depth'], event: ['int', 'event'],
    primarySi: ['SurfaceInteraction', 'primarySi'], primaryMat: ['OpenPbrResolvedMaterial', 'primaryMat'],
    coverage: ['float', 'coverage'], split: ['bool', 'split'], front: ['bool', 'front'],
    back: ['vec4', 'back'], backAux: ['RayTraceAuxiliary', 'backAux'],
    query: ['bool', 'query'], resample: ['bool', 'resample'], skipVolume: ['bool', 'skipVolume'],
    first: ['bool', 'first'], opaque: ['bool', 'isOpaque'],
    completion: ['uint', 'completionBounce'], maximum: ['float', 'maximum'], ...prefixRandomBindings
  };
  const activate = /* glsl */ `spFork(path);
    back = vec4(sampling_spectral_rgb_filter(back.rgb, spChannel), back.a);`;
  return /* glsl */ `${hasVolumeNoise ? volumeNoiseGuidesGlsl : ''}
void volumeGuides(Ray ray, float maximum, inout RayTraceAuxiliary outAux) {
  float tau = 0.0, weight = 0.0; vec3 albedo = vec3(0.0);
  for (int i = 0; i < volumeCount; i++) {
    float opticalDepth = volumeOpticalDepth(ray, i, volumeInterval(ray, i, maximum));
    float w = 1.0 - exp(-opticalDepth);
    tau += opticalDepth; weight += w; albedo += w * volumeColorAnisotropy[i].rgb;
  }
  float tr = exp(-tau);
  if (weight > 0.0) {
    outAux.albedo = tr * outAux.albedo + (1.0 - tr) * albedo / weight;
    outAux.normal *= tr; outAux.isBlank = false;
  }
}
float volumeSegmentMaximum(Path path, SurfaceInteraction si) {
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
int sampleVolumeEvent(inout Path path, inout SurfaceInteraction si, float maximum, bool resample) {
  if (si.mediumType > 0 || si.volumeSuppressed) return -1;
  float nearest = maximum; int winner = -1;
  for (int i = 0; i < volumeCount; i++) {
    vec2 interval = volumeInterval(path.ray, i, ${hasVolumeNoise ? 'nearest' : 'maximum'});
    if (interval.y <= interval.x || volumeParams[i].x <= 0.0) continue;
    float u = sample1D(bounceDim(BOUNCE_STRIDE - 1u - uint(i)));
    if (resample) u = hashedSample(0xf091u + uint(i));
    // Undo the surface sampler's endpoint remapping for unbiased free flight.
    u = clamp((u - EPS) / (1.0 - 2.0 * EPS), 0.0, 1.0 - 1.0 / 16777216.0);
    float candidate = volumeDistance(path.ray, i, interval, -log(max(1.0 - u, 1e-7)));${hasVolumeNoise ? /* glsl */ `
    if (volumeModulated(i)) candidate = volumeDeltaDistance(path.ray, i, interval, u, 0xc910u + uint(i) * 256u);` : ''}
    if (candidate < interval.y && candidate < nearest) { nearest = candidate; winner = i; }
  }
  if (winner >= 0) {
    path.ray.o += nearest * path.ray.d; si.position = path.ray.o;
    si.triangleIndex = -1; si.instanceIndex = -1;
  }
  return winner;
}
void shadeVolumeVertex(inout Path path, inout SurfaceInteraction si, int winner, inout int depth) {
  path.beta *= volumeColorAnisotropy[winner].rgb; path.alpha = 1.0; path.volumeScattered = true;
  path.scatteringMediumEntered = true;
  if (max(max(path.beta.x, path.beta.y), path.beta.z) <= 0.0) { path.abort = true; return; }
  float originalAnisotropy = si.mediumAnisotropy;
  si.mediumAnisotropy = volumeColorAnisotropy[winner].w;
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
${sharePrefix ? prefixCheckpoint('spVolume', bindings) : ''}vec4 integrateVolumePath(SurfaceInteraction si, Ray ray, OpenPbrResolvedMaterial mat, bool traceVolume, inout RayTraceAuxiliary outAux) {
${sharePrefix ? '  pathChannel = spActive ? 0 : spChannel;\n' : ''}  Path path; path.scatteringMediumEntered = false; path.ray = ray; path.beta = vec3(1.0); path.li = vec3(0.0); path.fromEye = true; path.abort = false;
  path.alpha = transmissiveOutputAlphaMin < 1.0 ? 0.0 : 1.0;
  path.scatteringPdf = 0.0; path.scatteringIsDelta = false; path.isNextRefraction = false; path.volumeScattered = false;
  Path originalPath = path; SurfaceInteraction primarySi = si; OpenPbrResolvedMaterial primaryMat = mat;
  RayTraceAuxiliary originalAux = outAux, backAux;
  float coverage = 1.0; bool split = false, front = false; vec4 back;
  int depth = 0, event = 0;
  bool isOpaque = !si.isTransparency;
  bool originalOpaque = isOpaque;
  bool query = false, resample = false, skipVolume = false, first = true;
  int limit = min(bounceLimit * 3, ${MAX_PATH_EVENTS_WEBGL});
${sharePrefix ? /* glsl */ `  int spSlot = spCall++;
  if (spActive && spChannel > 1 && spCompleted[spSlot].ready) return spReplay(spSlot, outAux);
  bool spResume = false; uint completionBounce = 0u; float maximum = 0.0;
  if (spActive && spChannel > 1 && spForkCall == spSlot) {
    ${prefixRestore('spVolume', bindings)}
    spResume = true; ${activate}
  }
` : ''}  for (int step = 0; step < ${(MAX_PATH_EVENTS_WEBGL + 1) * 2 + 2}; step++) {
    if (${sharePrefix ? '!spResume && query' : 'query'}) {
      intersectScene(path.ray, si, event != 0);
      getMaterial(mat, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
      if (event == 0 && si.hit && (mat.materialType == STANDARD || mat.materialType == UNLIT)) {
        outAux.albedo = mat.transmissionWeight > 0.5 ? vec3(1.0) : mat.baseColor;
        outAux.normal = dot(si.normal, si.position - vec3(viewInv[3])) > 0.0 ? -si.normal : si.normal;
        si.albedoSampled = mat.transmissionWeight > 0.5;
      }
    }
${sharePrefix ? /* glsl */ `    query = true;
    if (!spResume) { completionBounce = samplingBounce; samplingBounce = uint(depth);
      maximum = volumeSegmentMaximum(path, si); }
    int winner = -1;` : /* glsl */ `    query = true; uint completionBounce = samplingBounce; samplingBounce = uint(depth);
    int winner = -1;
    float maximum = volumeSegmentMaximum(path, si);`}
    if (${sharePrefix ? '!spResume && ' : ''}traceVolume && !skipVolume) winner = sampleVolumeEvent(path, si, maximum, resample);
    skipVolume = false;
    if (winner >= 0) {
      // Match the surface event budget; camera volumes establishes opacity.
      if (event == 0) isOpaque = true;
      if ((isOpaque && event > bounceLimit) || event >= limit) path.abort = true;
      else shadeVolumeVertex(path, si, winner, depth);
      first = false; resample = false; event++;
    } else {
      if (first && path.fromEye && si.hit && (mat.materialType == STANDARD || mat.materialType == UNLIT) && mat.alpha < 1.0) {
        split = true; coverage = clamp(mat.alpha, 0.0, 1.0); primarySi = si; primaryMat = mat;
        si.albedoSampled = false;
        path.ray.o = si.position + ray.d * (EPS * 0.02); first = false; resample = true; continue;
      }
      first = false;
${sharePrefix ? /* glsl */ `      if (spActive && (event > 0 || maximum < (si.hit ? distance(si.position, path.ray.o) : INF)) && mat.transmissionWeight > 0.001 && spDisperses(mat)) {
        ${prefixSave('spVolume', bindings)}
        spForkCall = spSlot; ${activate}
      }
` : ''}      if (event > 0 || maximum < (si.hit ? distance(si.position, path.ray.o) : INF)) { samplingBounce = completionBounce; int completionDepth = depth; completeVolumeVertex(path, completionDepth, si, mat, resample); }
      if (!path.abort && ((isOpaque && event > bounceLimit) || event >= limit)) path.abort = true;
      if (!path.abort) {
        si.volumeResample = false;
        bounce(path, depth, si, mat, outAux);
        resample = si.volumeResample;
        if (!resample) depth++;
      }
      event++;
    }
${sharePrefix ? '    spResume = false;\n' : ''}    if (path.abort) {
      vec4 result = vec4(path.li, path.alpha);
      if (!split || coverage <= 0.0) return ${sharePrefix ? 'spFinish(spSlot, result, outAux)' : 'result'};
      if (front) {
        outAux.albedo = mix(backAux.albedo, outAux.albedo, coverage);
        vec3 blendedNormal = mix(backAux.normal, outAux.normal, coverage);
        outAux.normal = dot(blendedNormal, blendedNormal) > 1e-12 ? normalize(blendedNormal) : vec3(0.0);
        outAux.isBlank = backAux.isBlank && outAux.isBlank;
        outAux.isShadowCatcher = backAux.isShadowCatcher && outAux.isShadowCatcher;
        return ${sharePrefix ? 'spFinish(spSlot, mix(back, result, coverage), outAux)' : 'mix(back, result, coverage)'};
      }
      back = result; backAux = outAux; front = true;
      path = originalPath; si = primarySi; mat = primaryMat; mat.alpha = 1.0; outAux = originalAux;
      isOpaque = originalOpaque;
      depth = 0; event = 0; query = false; resample = false; skipVolume = true;
    }
  }
  return ${sharePrefix ? 'spFinish(spSlot, vec4(path.li, path.alpha), outAux)' : 'vec4(path.li, path.alpha)'};
}
`;
}
