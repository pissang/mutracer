import {prefixCheckpoint, prefixSave, prefixRestore, prefixRandomBindings, type PrefixBindings} from './spectralPrefix.wgsl.js';
import {volumeTrackingWgsl} from './volumeTracking.wgsl.js';
import {MAX_PATH_EVENTS_WEBGL} from '../../pathLimits.js';
// Volume-only source. The no-volumes generator never includes these declarations.
export function createVolumeWgsl(hasVolumeNoise = false) { return /* wgsl */ `
fn volumeInterval(ray: Ray, volume: VolumeRecord, maximum: f32) -> vec2f {
  let origin = (volume.worldToLocal * vec4f(ray.o, 1.0)).xyz;
  let direction = (volume.worldToLocal * vec4f(ray.d, 0.0)).xyz;
  if (volume.params.w > 0.5) {
    let a = dot(direction, direction);
    let center = -dot(origin, direction) / a;
    let closest = origin + center * direction;
    let radius2 = (1.0 - dot(closest, closest)) / a;
    if (radius2 < 0.0 || a <= 0.0) { return vec2f(0.0); }
    let radius = sqrt(radius2);
    let near = max(0.0, center - radius);
    return vec2f(near, max(near, min(maximum, center + radius)));
  }
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
// log((1-exp(-z))/z), with a series around zero. The large-z
// branch evaluates density at the denser endpoint, avoiding overflow in a.
fn volumeOpticalDepth(ray: Ray, volume: VolumeRecord, interval: vec2f) -> f32 {
  let length = interval.y - interval.x;
  let density = volume.params.x;
  if (length <= 0.0 || density <= 0.0) { return 0.0; }
  let k = volume.params.y;
  if (k == 0.0) { return density * length; }
  let s = k * ray.d.y;
  let z = s * length;
  let enterY = ray.o.y + interval.x * ray.d.y;
  var logTau: f32;
  if (abs(z) < 0.01) {
    let z2 = z * z;
    logTau = log(density) - k * (enterY - volume.params.z) + log(length) - 0.5 * z + z2 / 24.0 - z2 * z2 / 2880.0;
  } else {
    var denseY = enterY;
    if (s < 0.0) { denseY = ray.o.y + interval.y * ray.d.y; }
    logTau = log(density) - k * (denseY - volume.params.z) + log(1.0 - exp(-abs(z))) - log(abs(s));
  }
  // Targets are -log(1-u) <= 16.64; 80 is indistinguishable from opaque
  // for both event selection and float32 shadow transmittance.
  return exp(clamp(logTau, -100.0, 80.0));
}
fn volumeDistance(ray: Ray, volume: VolumeRecord, interval: vec2f, opticalTarget: f32) -> f32 {
  let density = volume.params.x;
  if (density <= 0.0) { return INF; }
  if (volume.params.y == 0.0) { return interval.x + opticalTarget / density; }
  if (opticalTarget >= volumeOpticalDepth(ray, volume, interval)) { return INF; }
  let k = volume.params.y;
  let s = k * ray.d.y;
  let logA = log(density) - k * (ray.o.y + interval.x * ray.d.y - volume.params.z);
  let logDistance = log(opticalTarget) - logA;
  if (s == 0.0) { return interval.x + exp(clamp(logDistance, -100.0, 80.0)); }
  let q = logDistance + log(abs(s));
  var length: f32;
  if (q < -5.0) {
    let u = exp(q); let signedU = select(-u, u, s > 0.0);
    length = exp(clamp(logDistance, -100.0, 80.0)) * (1.0 + signedU * 0.5 + u * u / 3.0 + signedU * u * u * 0.25);
  } else if (s > 0.0) {
    if (q >= 0.0) { return INF; }
    length = -log(1.0 - exp(q)) / s;
  } else {
    if (q > 40.0) { length = q / -s; }
    else { length = log(1.0 + exp(q)) / -s; }
  }
  return interval.x + length;
}
fn volumeTransmittance(ray: Ray, maximum: f32) -> f32 {
  var tau = 0.0;
  for (var i = 0; i < rtUniform.volumeCount; i++) {
    let volume = rtUniform.volumeRecords[i];
    tau += volumeOpticalDepth(ray, volume, volumeInterval(ray, volume, maximum));
  }
  return exp(-tau);
}
${hasVolumeNoise ? volumeTrackingWgsl + '\n' : ''}fn volumeGuides(ray: Ray, maximum: f32, outAux: ptr<function, RayTraceAuxiliary>) {
  var tau = 0.0; var weight = 0.0; var albedo = vec3f(0.0);
  for (var i = 0; i < rtUniform.volumeCount; i++) {
    let volume = rtUniform.volumeRecords[i];
    let opticalDepth = volumeOpticalDepth(ray, volume, volumeInterval(ray, volume, maximum));
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
fn volumeSegmentMaximum(path: Path, si: SurfaceInteraction) -> f32 {
  var maximum = INF;
  if (si.hit) { maximum = distance(si.position, path.ray.o); }
  // Analytic emitters are invisible along camera/alpha-null continuations.
  if (path.fromEye) { return maximum; }
  for (var i = 0; i < rtUniform.lightsCount; i++) {
    var sample: LightSampleRec;
    let d = intersectLight(path.ray, analyticLights[i], &sample);
    if (d > 0.0) { maximum = min(maximum, d); }
  }
  return maximum;
}
fn sampleVolumeEvent(path: ptr<function, Path>, si: ptr<function, SurfaceInteraction>, maximum: f32, resample: bool) -> i32 {
  if ((*si).mediumType > 0 || (*si).volumeSuppressed) { return -1; }
  var nearest = maximum; var winner = -1;
  for (var i = 0; i < rtUniform.volumeCount; i++) {
    let volume = rtUniform.volumeRecords[i];
    let interval = volumeInterval((*path).ray, volume, ${hasVolumeNoise ? 'nearest' : 'maximum'});
    if (interval.y <= interval.x || volume.params.x <= 0.0) { continue; }
    var u = sample1D(bounceDim(BOUNCE_STRIDE - 1u - u32(i)));
    if (resample) { u = hashedSample(0xf091u + u32(i)); }
    // The surface sampler avoids endpoints with an EPS remapping. Free-flight
    // survival needs the full uniform distribution, especially for thin overlaps.
    u = clamp((u - EPS) / (1.0 - 2.0 * EPS), 0.0, 1.0 - 1.0 / 16777216.0);
    ${hasVolumeNoise ? /* wgsl */ `var candidate = volumeDistance((*path).ray, volume, interval, -log(max(1.0 - u, 1e-7)));
    if (volumeModulated(volume)) { candidate = volumeDeltaDistance((*path).ray, volume, interval, u, 0xc910u + u32(i) * 256u); }` : 'let candidate = volumeDistance((*path).ray, volume, interval, -log(max(1.0 - u, 1e-7)));'}
    if (candidate < interval.y && candidate < nearest) { nearest = candidate; winner = i; }
  }
  if (winner >= 0) {
    (*path).ray.o += nearest * (*path).ray.d;
    (*si).position = (*path).ray.o;
    // A volumes event is not attached to the surface at the end of the segment.
    (*si).triangleIndex = -1; (*si).instanceIndex = -1;
  }
  return winner;
}
fn shadeVolumeVertex(path: ptr<function, Path>, si: ptr<function, SurfaceInteraction>, winner: i32, depth: ptr<function, i32>) {
  let volume = rtUniform.volumeRecords[winner];
  (*path).beta *= volume.colorAnisotropy.rgb;
  (*path).alpha = 1.0; (*path).volumeScattered = true;
  (*path).scatteringMediumEntered = true;
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
}

export function createVolumeIntegratorWgsl(deterministicPrimaryAlpha: boolean, hasVolumeNoise = false, maxPathEvents = MAX_PATH_EVENTS_WEBGL, sharePrefix = false) {
  const bindings: PrefixBindings = {
    path: ['Path', 'path'], si: ['SurfaceInteraction', 'si'], ma: ['OpenPbrResolvedMaterial', 'ma'],
    aux: ['RayTraceAuxiliary', '*outAux'], depth: ['i32', 'depth'], event: ['i32', 'event'],
    primarySi: ['SurfaceInteraction', 'primarySi'], primaryMa: ['OpenPbrResolvedMaterial', 'primaryMa'],
    coverage: ['f32', 'coverage'], split: ['bool', 'split'], front: ['bool', 'front'],
    back: ['vec4f', 'back'], backAux: ['RayTraceAuxiliary', 'backAux'],
    query: ['bool', 'query'], resample: ['bool', 'resample'], skipVolume: ['bool', 'skipVolume'],
    first: ['bool', 'first'], opaque: ['bool', 'isOpaque'],
    completion: ['u32', 'completionBounce'], maximum: ['f32', 'maximum'], ...prefixRandomBindings
  };
  const activate = /* wgsl */ `spFork(&path, &si);
    primarySi.spectralChannel = spChannel; primarySi.wavelength = spWavelength;
    back = vec4f(sampling_spectral_rgb_filter(back.rgb, spChannel), back.a);`;
  return /* wgsl */ `
${sharePrefix ? prefixCheckpoint('spVolume', bindings) : ''}fn integrateVolumePath(uv: vec2f, ray: Ray, initialSi: SurfaceInteraction, initialMa: OpenPbrResolvedMaterial, traceVolume: bool, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
  var si = initialSi; var ma = initialMa;${sharePrefix ? /* wgsl */ `
  if (spEnabled) { si.spectralChannel = select(spChannel, 0, spActive); si.wavelength = spWavelength; }` : ''}
  var path: Path; path.ray = ray; path.beta = vec3f(1.0); path.fromEye = true;
  path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
  let originalPath = path;
  var primarySi = si; var primaryMa = ma;
  let originalAux = *outAux;
  var coverage = 1.0; var split = false; var front = false;
  var back: vec4f; var backAux: RayTraceAuxiliary;
  var depth = 0; var event = 0; var query = false; var resample = false;
  var skipVolume = false; var first = true;
  var isOpaque = false;
  let limit = min(max(rtUniform.bounces, 0) * 3, ${maxPathEvents});
${sharePrefix ? /* wgsl */ `  let spSlot = spCall; spCall++;
  if (spActive && spChannel > 1 && spCompleted[spSlot].ready) { return spReplay(spSlot, outAux); }
  var spResume = false; var completionBounce = 0u; var maximum = 0.0;
  if (spActive && spChannel > 1 && spForkCall == spSlot) {
    ${prefixRestore('spVolume', bindings)}
    spResume = true; ${activate}
  }
` : ''}  for (var step = 0; step < ${(maxPathEvents + 1) * 2 + 2}; step++) {
    if (${sharePrefix ? '!spResume && query' : 'query'}) {
      intersectScene(path.ray, &si, depth, event != 0, path.isNextRefraction);
      getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
      if (event == 0 && si.hit && ma.materialType == STANDARD) {
        (*outAux).albedo = select(ma.baseColor, vec3f(1.0), ma.transmissionWeight > 0.5);
        (*outAux).normal = select(si.normal, -si.normal, dot(si.normal, si.position - cameraUniform.viewInv[3].xyz) > 0.0);
        si.albedoSampled = ma.transmissionWeight > 0.5;
      }
    }
    query = true;
    ${sharePrefix ? 'if (!spResume) {\n      completionBounce = samplingBounce;' : 'let completionBounce = samplingBounce;'}
    samplingBounce = u32(depth);
    ${sharePrefix ? 'maximum =' : 'let maximum ='} volumeSegmentMaximum(path, si);
${sharePrefix ? '    }\n' : ''}    var winner = -1;
    if (${sharePrefix ? '!spResume && ' : ''}traceVolume && !skipVolume) { winner = sampleVolumeEvent(&path, &si, maximum, resample); }
    skipVolume = false;
    if (winner >= 0) {
      // A camera volumes event establishes an opaque primary path. Surface
      // transparency otherwise retains the legacy three-events-per-bounce budget.
      if (event == 0) { isOpaque = true; }
      if ((isOpaque && event > rtUniform.bounces) || event >= limit) { path.abort = true; }
      else { shadeVolumeVertex(&path, &si, winner, &depth); }
      first = false; resample = false; event++;
    } else {
      if (${deterministicPrimaryAlpha ? 'true' : 'false'} && first && path.fromEye && si.hit && (ma.materialType == STANDARD || ma.materialType == UNLIT) && ma.alpha < 1.0) {
        // Camera free flight was sampled before splitting coverage. Both
        // branches share that prefix; the front branch must not resample it.
        split = true; coverage = clamp(ma.alpha, 0.0, 1.0);
        primarySi = si; primaryMa = ma;
        si.albedoSampled = false;
        path.ray.o = si.position + ray.d * (EPS * 0.02);
        first = false; resample = true;
        continue;
      }
      if (event == 0) { isOpaque = ma.transmissionWeight < 0.001 && ma.subsurfaceWeight < 0.001 && ma.alpha > 0.99; }
      first = false;
      if (path.fromEye && si.hit && ma.materialType == SHADOW_CATCHER) {
        (*outAux).isShadowCatcher = true;
        (*outAux).shadowCounts = sampleShadowCatcher(si, 0, &path);
        path.li = vec3f(1.0); path.alpha = 1.0; path.abort = true;
      } else {
${sharePrefix ? /* wgsl */ `        if (spActive && (event > 0 || maximum < select(INF, distance(si.position, path.ray.o), si.hit)) && ma.transmissionWeight > 0.001 && spDisperses(ma)) {
          ${prefixSave('spVolume', bindings)}
          spForkCall = spSlot; ${activate}
        }
` : ''}        if (event > 0 || maximum < select(INF, distance(si.position, path.ray.o), si.hit)) { samplingBounce = completionBounce; var completionDepth = depth; completeVertex(&path, &completionDepth, &si, &ma, resample); }
        if (!path.abort && ((isOpaque && event > rtUniform.bounces) || event >= limit)) { path.abort = true; }
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
${sharePrefix ? '    spResume = false;\n' : ''}    if (path.abort) {
      let result = vec4f(path.li, path.alpha);
      if (!split || coverage <= 0.0) { return ${sharePrefix ? 'spFinish(spSlot, result, *outAux)' : 'result'}; }
      if (front) {
        (*outAux).albedo = mix(backAux.albedo, (*outAux).albedo, coverage);
        let blendedNormal = mix(backAux.normal, (*outAux).normal, coverage);
        (*outAux).normal = select(vec3f(0.0), normalize(blendedNormal), dot(blendedNormal, blendedNormal) > 1e-12);
        (*outAux).isBlank = backAux.isBlank && (*outAux).isBlank;
        (*outAux).isShadowCatcher = backAux.isShadowCatcher && (*outAux).isShadowCatcher;
        (*outAux).shadowCounts = mix(backAux.shadowCounts, (*outAux).shadowCounts, coverage);
        return ${sharePrefix ? 'spFinish(spSlot, mix(back, result, coverage), *outAux)' : 'mix(back, result, coverage)'};
      }
      back = result; backAux = *outAux;
      front = true; path = originalPath; si = primarySi; ma = primaryMa; ma.alpha = 1.0;
      *outAux = originalAux;
      depth = 0; event = 0; query = false; resample = false; skipVolume = true;
    }
  }
  return ${sharePrefix ? 'spFinish(spSlot, vec4f(path.li, path.alpha), *outAux)' : 'vec4f(path.li, path.alpha)'};
}
fn integrator(uv: vec2f, ray: Ray, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
  var si: SurfaceInteraction; var ma: OpenPbrResolvedMaterial;
  intersectScene(ray, &si, 0, false, false);
  getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
  if (si.hit && HAS_BEVEL && rtUniform.bevel != 0 && ma.bevel > 0.0) { si.normal = getBevelNormal(si, ma.bevel); }
  if (si.hit && (ma.materialType == STANDARD || ma.materialType == UNLIT)) {
    (*outAux).albedo = select(ma.baseColor, vec3f(1.0), ma.transmissionWeight > 0.5);
    (*outAux).normal = select(si.normal, -si.normal, dot(si.normal, si.position - cameraUniform.viewInv[3].xyz) > 0.0);
    si.albedoSampled = ma.transmissionWeight > 0.5;
  }
  if (si.hit && ma.materialType == SHADOW_CATCHER) {
    (*outAux).albedo = vec3f(1.0);
    (*outAux).normal = select(si.normal, -si.normal, dot(si.normal, ray.d) > 0.0);
    si.albedoSampled = true;
  }
  var maximum = INF;
  if (si.hit) { maximum = distance(si.position, ray.o); }
  let originalAux = *outAux;
  let guideTr = ${hasVolumeNoise ? 'select(1.0, 0.0, volumeHasDensity(ray, maximum))' : 'volumeTransmittance(ray, maximum)'};
  // Rough surfaces/glass already have a stable fallback. Delta and coverage
  // paths need their ordinary continuation even when volumes scatters before it.
  let replayGuides = guideTr < 1.0 && si.hit && !si.albedoSampled &&
    (ma.alpha < 1.0 || (ma.specularRoughness <= 0.02 && ma.baseMetalness > 0.98));
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
${sharePrefix ? /* wgsl */ `      spBegin(wavelengthSi.spectralChannel, wavelengthSi.wavelength, spDisperses(ma));
      if (spActive) { wavelengthSi.spectralChannel = 0; }
` : ''}      wavelengthMa.specularIor = sampling_cauchy_ior(wavelengthSi.wavelength, ma.specularIor, ma.transmissionDispersionScale, ma.dispersionAbbeNumber);
    }
    let result = integrateVolumePath(uv, ray, wavelengthSi, wavelengthMa, true, &aux);
    if (guideTr < 1.0) {
      if (replayGuides) {
        let endRng = s0; let endCounter = hashedCounter;
        s0 = rng; hashedCounter = counter; samplingBounce = 0u;
        var guideAux = originalAux;
        let ignored = integrateVolumePath(uv, ray, wavelengthSi, wavelengthMa, false, &guideAux);
        aux.albedo = guideAux.albedo; aux.normal = guideAux.normal;
        s0 = endRng; hashedCounter = endCounter;
      } else { aux.albedo = originalAux.albedo; aux.normal = originalAux.normal; }
    }
    color += result.rgb * select(1.0, 3.0, SPECTRAL && single && dispersive);
    alpha = max(alpha, result.a); guides += aux.albedo; normals += aux.normal; allBlank = allBlank && aux.isBlank;
    (*outAux).isShadowCatcher = aux.isShadowCatcher; (*outAux).shadowCounts = aux.shadowCounts;
  }
  (*outAux).albedo = guides / f32(count); (*outAux).normal = normals / f32(count);
  (*outAux).isBlank = allBlank;
  ${hasVolumeNoise ? 'volumeNoiseGuides' : 'volumeGuides'}(ray, maximum, outAux);
  return vec4f(color, alpha);
}
`;
}
