import {MAX_PATH_EVENTS} from '../../pathLimits.js';
// Fog-only source. The no-fog generator never includes these declarations.
export const fogWgsl = /* wgsl */ `
fn fogInterval(ray: Ray, volume: FogVolume, maximum: f32) -> vec2f {
  let origin = (volume.worldToLocal * vec4f(ray.o, 1.0)).xyz;
  let direction = (volume.worldToLocal * vec4f(ray.d, 0.0)).xyz;
  var near = 0.0;
  var far = maximum;
  for (var axis = 0; axis < 3; axis++) {
    if (direction[axis] == 0.0) {
      if (abs(origin[axis]) > 1.0) { return vec2f(0.0); }
    } else {
      let a = (-1.0 - origin[axis]) / direction[axis];
      let b = (1.0 - origin[axis]) / direction[axis];
      near = max(near, min(a, b)); far = min(far, max(a, b));
    }
  }
  return vec2f(near, max(near, far));
}
fn fogOpticalDepth(ray: Ray, volume: FogVolume, interval: vec2f) -> f32 {
  return volume.params.x * (interval.y - interval.x);
}
fn fogDistance(ray: Ray, volume: FogVolume, interval: vec2f, opticalTarget: f32) -> f32 {
  if (volume.params.x <= 0.0) { return INF; }
  return interval.x + opticalTarget / volume.params.x;
}
fn fogTransmittance(ray: Ray, maximum: f32) -> f32 {
  var tau = 0.0;
  for (var i = 0; i < rtUniform.fogCount; i++) {
    let volume = rtUniform.fogVolumes[i];
    tau += fogOpticalDepth(ray, volume, fogInterval(ray, volume, maximum));
  }
  return exp(-tau);
}
fn fogGuides(ray: Ray, maximum: f32, outAux: ptr<function, RayTraceAuxiliary>) {
  var tau = 0.0; var weight = 0.0; var albedo = vec3f(0.0);
  for (var i = 0; i < rtUniform.fogCount; i++) {
    let volume = rtUniform.fogVolumes[i];
    let opticalDepth = fogOpticalDepth(ray, volume, fogInterval(ray, volume, maximum));
    let w = 1.0 - exp(-opticalDepth);
    tau += opticalDepth; weight += w; albedo += w * volume.colorAnisotropy.rgb;
  }
  let transmittance = exp(-tau);
  if (weight > 0.0) {
    (*outAux).albedo = transmittance * (*outAux).albedo + (1.0 - transmittance) * albedo / weight;
    (*outAux).normal *= transmittance;
    (*outAux).isBlank = false;
  }
}
// Restrict free flight to the nearest visible analytic emitter as well as
// geometry. Sampling beyond a terminating light would attenuate it twice.
fn fogSegmentMaximum(path: Path, si: SurfaceInteraction) -> f32 {
  var maximum = INF;
  if (si.hit) { maximum = distance(si.position, path.ray.o); }
  for (var i = 0; i < rtUniform.lightsCount; i++) {
    var sample: LightSampleRec;
    let d = intersectLight(path.ray, analyticLights[i], &sample);
    if (d > 0.0) { maximum = min(maximum, d); }
  }
  return maximum;
}
fn sampleFogEvent(path: ptr<function, Path>, si: ptr<function, SurfaceInteraction>, maximum: f32, resample: bool) -> i32 {
  if ((*si).mediumType > 0 || (*si).fogSuppressed) { return -1; }
  var nearest = maximum; var winner = -1;
  for (var i = 0; i < rtUniform.fogCount; i++) {
    let volume = rtUniform.fogVolumes[i];
    let interval = fogInterval((*path).ray, volume, maximum);
    if (interval.y <= interval.x || volume.params.x <= 0.0) { continue; }
    var u = sample1D(bounceDim(BOUNCE_STRIDE - 1u - u32(i)));
    if (resample) { u = hashedSample(0xf091u + u32(i)); }
    let candidate = fogDistance((*path).ray, volume, interval, -log(max(1.0 - u, 1e-7)));
    if (candidate < interval.y && candidate < nearest) { nearest = candidate; winner = i; }
  }
  if (winner >= 0) {
    (*path).ray.o += nearest * (*path).ray.d;
    (*si).position = (*path).ray.o;
    // A fog event is not attached to the surface at the end of the segment.
    (*si).triangleIndex = -1; (*si).instanceIndex = -1;
  }
  return winner;
}
fn shadeFogVertex(path: ptr<function, Path>, si: ptr<function, SurfaceInteraction>, winner: i32, depth: ptr<function, i32>) {
  let volume = rtUniform.fogVolumes[winner];
  (*path).beta *= volume.colorAnisotropy.rgb;
  (*path).alpha = 1.0; (*path).fogScattered = true;
  if (max(max((*path).beta.x, (*path).beta.y), (*path).beta.z) <= 0.0) { (*path).abort = true; return; }
  let originalAnisotropy = (*si).mediumAnisotropy;
  (*si).mediumAnisotropy = volume.colorAnisotropy.w;
  var material: OpenPbrResolvedMaterial; var prepared: OpenPbrPreparedBsdf;
  bounceIndex = u32(*depth);
  let scattered = sampleScattering(si, material, prepared, path, vec3f(0.0), false);
  (*si).mediumAnisotropy = originalAnisotropy;
  (*path).ray.d = scattered.direction;
  (*path).scatteringPdf = scattered.pdf; (*path).scatteringIsDelta = false;
  (*path).fromEye = false; (*path).isNextRefraction = false;
  *depth += 1;
  if (USE_RR && *depth >= RR_MAX) {
    let survival = min(1.0, max(max((*path).beta.x, (*path).beta.y), (*path).beta.z));
    if (sample1D(bounceDim(RUSSIAN_ROULETTE)) >= survival) { (*path).abort = true; }
    else { (*path).beta /= survival; }
  }
}
`;

export const fogIntegratorWgsl = /* wgsl */ `
fn integrateFogPath(uv: vec2f, ray: Ray, initialSi: SurfaceInteraction, initialMa: OpenPbrResolvedMaterial, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
  var si = initialSi; var ma = initialMa;
  var path: Path; path.ray = ray; path.beta = vec3f(1.0); path.fromEye = true;
  path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
  let originalPath = path;
  var primarySi = si; var primaryMa = ma;
  let originalAux = *outAux;
  var coverage = 1.0; var split = false; var front = false;
  var back: vec4f; var backAux: RayTraceAuxiliary;
  var depth = 0; var event = 0; var query = false; var resample = false;
  var skipFog = false; var first = true;
  let limit = min(max(rtUniform.bounces, 0) * 3, ${MAX_PATH_EVENTS});
  for (var step = 0; step < ${(MAX_PATH_EVENTS + 1) * 2 + 2}; step++) {
    if (query) {
      intersectScene(path.ray, &si, depth, true, path.isNextRefraction);
      getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    }
    query = true;
    samplingBounce = u32(depth);
    let maximum = fogSegmentMaximum(path, si);
    var winner = -1;
    if (!skipFog) { winner = sampleFogEvent(&path, &si, maximum, resample); }
    skipFog = false;
    if (winner >= 0) {
      if (depth >= rtUniform.bounces || event >= limit) { path.abort = true; }
      else { shadeFogVertex(&path, &si, winner, &depth); }
      first = false; resample = false; event++;
    } else {
      if (first && path.fromEye && si.hit && (ma.materialType == STANDARD || ma.materialType == UNLIT) && ma.alpha < 1.0) {
        // Camera free flight was sampled before splitting coverage. Both
        // branches share that prefix; the front branch must not resample it.
        split = true; coverage = clamp(ma.alpha, 0.0, 1.0);
        primarySi = si; primaryMa = ma;
        path.ray.o = si.position + ray.d * (EPS * 0.02);
        first = false; resample = true;
        continue;
      }
      first = false;
      if (path.fromEye && si.hit && ma.materialType == SHADOW_CATCHER) {
        (*outAux).isShadowCatcher = true;
        (*outAux).shadowCounts = sampleShadowCatcher(si, 0, &path);
        path.li = vec3f(1.0); path.alpha = 1.0; path.abort = true;
      } else {
        if (event > 0) { var completionDepth = depth; completeVertex(&path, &completionDepth, &si, &ma, false); }
        if (!path.abort && (depth > rtUniform.bounces || event >= limit)) { path.abort = true; }
        if (!path.abort) {
          var ignored = false;
          shadeVertex(uv, &path, &depth, &si, &ma, outAux, &ignored);
          resample = ignored;
          if (!ignored) { depth++; }
          // completeVertex advances surface depth. Alpha-null traversal must
          // retain it, but consumes a fresh hashed free-flight sample.
        }
      }
      event++;
    }
    if (path.abort) {
      let result = vec4f(path.li, path.alpha);
      if (!split || coverage <= 0.0) { return result; }
      if (front) {
        (*outAux).albedo = mix(backAux.albedo, (*outAux).albedo, coverage);
        (*outAux).normal = mix(backAux.normal, (*outAux).normal, coverage);
        (*outAux).isBlank = backAux.isBlank && (*outAux).isBlank;
        (*outAux).isShadowCatcher = backAux.isShadowCatcher && (*outAux).isShadowCatcher;
        (*outAux).shadowCounts = mix(backAux.shadowCounts, (*outAux).shadowCounts, coverage);
        return mix(back, result, coverage);
      }
      back = result; backAux = *outAux;
      front = true; path = originalPath; si = primarySi; ma = primaryMa; ma.alpha = 1.0;
      *outAux = originalAux;
      depth = 0; event = 0; query = false; resample = false; skipFog = true;
    }
  }
  return vec4f(path.li, path.alpha);
}
fn integrator(uv: vec2f, ray: Ray, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
  var si: SurfaceInteraction; var ma: OpenPbrResolvedMaterial;
  intersectScene(ray, &si, 0, false, false);
  getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
  if (si.hit) {
    (*outAux).albedo = select(ma.baseColor, vec3f(1.0), ma.transmissionWeight > 0.5);
    (*outAux).normal = select(si.normal, -si.normal, dot(si.normal, ray.d) > 0.0);
  }
  var maximum = INF;
  if (si.hit) { maximum = distance(si.position, ray.o); }
  fogGuides(ray, maximum, outAux);
  si.albedoSampled = true;
  let originalAux = *outAux;
  let wavelengthSample = sample1D(CAMERA_WAVELENGTH);
  let rng = s0; let counter = hashedCounter;
  let single = rtUniform.dispersionWavelengths == 1;
  let dispersive = si.hit && ma.transmissionWeight > 0.001 && ma.transmissionDispersionScale > 0.001;
  let count = select(1, 3, SPECTRAL && !single);
  var color = vec3f(0.0); var alpha = 0.0; var guides = vec3f(0.0); var normals = vec3f(0.0);
  var allBlank = true;
  for (var channel = 0; channel < count; channel++) {
    var wavelengthSi = si; var wavelengthMa = ma; var aux = originalAux;
    s0 = rng; hashedCounter = counter; samplingBounce = 0u;
    if (SPECTRAL && (!single || dispersive)) {
      let hero = min(i32(wavelengthSample * 3.0), 2);
      wavelengthSi.spectralChannel = select(channel, hero, single) + 1;
      wavelengthSi.wavelength = spectrumCameraWavelength(u32(wavelengthSi.spectralChannel - 1), select(wavelengthSample, fract(wavelengthSample * 3.0), single));
      wavelengthMa.specularIor = sampling_cauchy_ior(wavelengthSi.wavelength, ma.specularIor, ma.transmissionDispersionScale, ma.dispersionAbbeNumber);
    }
    let result = integrateFogPath(uv, ray, wavelengthSi, wavelengthMa, &aux);
    color += result.rgb * select(1.0, 3.0, SPECTRAL && single && dispersive);
    alpha = max(alpha, result.a); guides += aux.albedo; normals += aux.normal; allBlank = allBlank && aux.isBlank;
    (*outAux).isShadowCatcher = aux.isShadowCatcher; (*outAux).shadowCounts = aux.shadowCounts;
  }
  (*outAux).albedo = guides / f32(count); (*outAux).normal = normals / f32(count);
  (*outAux).isBlank = allBlank && fogTransmittance(ray, maximum) >= 1.0;
  return vec4f(color, alpha);
}
`;
