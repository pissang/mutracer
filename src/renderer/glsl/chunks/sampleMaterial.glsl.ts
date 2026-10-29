// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

import { glsl } from '../../shader.js';
export default glsl`
float emissiveHitMisWeight(SurfaceInteraction si,Path path) {
  // Secondary intersections remain two-sided, but one-sided emission does not.
  float facing=dot(si.faceNormal,-path.ray.d);
  if(facing<=0.0&&fetchMatData(si.materialIndex*MAT_DATA_SIZE+MAT_ROW_ALPHA).z<0.5)return 0.0;
#ifdef HAS_EMISSIVE_LIGHTS
  if(!path.fromEye && emissiveWeightTotal>0.0) {
    vec3 emission=fetchMatData(si.materialIndex*MAT_DATA_SIZE+MAT_ROW_EMISSION).rgb;
    float value=dot(emission,vec3(.2126,.7152,.0722)),cosine=dot(si.faceNormal,-path.ray.d);
    if(value>0.0&&cosine>0.0){float d=distance(si.position,path.ray.o);return sampling_power_heuristic(path.scatteringPdf,value/emissiveWeightTotal*d*d/cosine);}
  }
#endif
  return 1.0;
}

vec3 DirectLight(SurfaceInteraction si, OpenPbrResolvedMaterial mat, OpenPbrPreparedBsdf prepared, inout Path path, vec3 ffnormal, bool isSurface) {
  float occluded = 1.0;
  vec3 lightRnd = vec3(sample2D(bounceDim(LIGHT_POSITION)), sample1D(bounceDim(LIGHT_SELECT)));

  LightSampleRec lightSample;
  sampleLight(si.position, lightRnd, lightSample, false);
  lightSample.emission = sampling_spectral_rgb_filter(lightSample.emission, pathWavelength);

  vec3 lightDir = lightSample.direction;
  vec3 viewDir = -path.ray.d;
  float lightPdf = lightSample.pdf;
  // Opaque surfaces are rendered two-sided by the core renderer. Use the
  // face-forward shading normal here as well, otherwise the early-out rejects
  // every direct-light sample seen from the back of a triangle (for example
  // the inside of an imported room wall).
  float cosThetaL = dot(ffnormal, lightDir);
#ifdef USE_COAT_NORMAL_FRAMES
  if (isSurface && mat.coatNormalEnabled) { cosThetaL = dot(mat.geometricNormal, lightDir); }
#endif

  if (lightPdf <= 0.0 || max(max(lightSample.emission.x, lightSample.emission.y), lightSample.emission.z) <= 0.0) {
    return vec3(0.0);
  }

  float scatteringPdf = 0.0;
  vec3 f = vec3(0.0);
  if (isSurface) {
    if (cosThetaL <= 0.0 && mat.transmissionWeight <= 0.0 && mat.subsurfaceWeight <= 0.0) {
      return vec3(0.0);
    }
    f = openpbr_eval_prepared(prepared, lightDir, scatteringPdf);
  }
  else {
    scatteringPdf = sampling_henyey_greenstein_phase(
      dot(viewDir, lightDir),
      si.mediumAnisotropy
    );
    f = vec3(scatteringPdf);
  }

  if (scatteringPdf <= 0.0 || max(max(f.x, f.y), f.z) <= 0.0) {
    return vec3(0.0);
  }

  Ray lightRay;
  vec3 shadowOrigin = si.position + EPS * lightDir;
  if (isSurface) {
    const float shadowTerminatorCutoff = 0.1;
    float normalLight = dot(si.normal, lightDir);
#ifdef USE_COAT_NORMAL_FRAMES
    if (mat.coatNormalEnabled) { normalLight = dot(si.faceNormal, lightDir); }
#endif
    vec3 geometricNormal = normalLight < 0.0 ? -si.faceNormal : si.faceNormal;
    normalLight = abs(normalLight);
    float geometricLight = dot(geometricNormal, lightDir);
    float offsetAmount = normalLight < shadowTerminatorCutoff
      ? clamp(
          2.0 - (geometricLight + normalLight) / shadowTerminatorCutoff,
          0.0,
          1.0
        )
      : clamp(1.0 - geometricLight / shadowTerminatorCutoff, 0.0, 1.0);
    shadowOrigin += si.shadowOffset * offsetAmount;
  }
  float shadowDistance=lightSample.dist-EPS;
  vec3 shadowDirection=lightDir;
  if(lightSample.sourceType==1){
    vec3 endpoint=si.position+lightDir*lightSample.dist+EPS*lightSample.normal;
    shadowDirection=normalize(endpoint-shadowOrigin);shadowDistance=distance(endpoint,shadowOrigin);
  }
  initRay(lightRay, shadowOrigin, shadowDirection);
  if (intersectSceneShadow(lightRay, shadowDistance, si.triangleIndex)) {
    return vec3(0.0);
  }

#ifdef USE_ENVMAP
  // Match the endpoint used by a BSDF-sampled surface transmission, including
  // a separately displayed or grounded background and its coverage.
  if (isSurface && cosThetaL < 0.0 && lightSample.sourceType == 0) {
    vec4 background = sampleBackgroundFromRay(lightRay.o, lightDir);
    lightSample.emission = sampling_spectral_rgb_filter(background.rgb * background.a, pathWavelength);
  }
#endif

  // Delta lights cannot be sampled by the BSDF strategy, so their MIS weight
  // is exactly one even when their light-selection PMF is small.
  float misWeight = lightSample.isDelta
    ? 1.0
    : sampling_power_heuristic(lightPdf, scatteringPdf);
  return misWeight > 0.0
    ? misWeight * lightSample.emission * f / lightPdf
    : vec3(0.0);
}

#ifdef USE_COAT_NORMAL_FRAMES
vec3 coat_frame_normal(vec3 inputNormal, vec3 face, vec3 view) {
  bool front = dot(face, view) >= 0.0;
  vec3 ffFace = front ? face : -face;
  vec3 ffInput = front ? inputNormal : -inputNormal;
  if (dot(inputNormal, face) <= 0.0 || dot(ffInput, view) <= 1e-6) { return ffFace; }
  return ffInput;
}
#endif
void SampleMaterial(inout SurfaceInteraction si, OpenPbrResolvedMaterial mat, inout Path path) {
  vec3 matRnd = vec3(sample2D(bounceDim(BSDF_DIRECTION)), sample1D(bounceDim(BSDF_LOBE)));
#ifdef USE_COAT_NORMAL_FRAMES
  vec3 originalFace = si.faceNormal;
  vec3 originalNormal = si.normal;
#endif
  float ndv1 = -dot(si.faceNormal, path.ray.d);
  float ndv2 = -dot(si.normal, path.ray.d);
  if ((mat.transmissionWeight > 0.0 || mat.subsurfaceWeight > 0.0) && mat.thinWalled) {
    // Always treat thin material as entering medium
    if (ndv1 < 0.0) {
      si.faceNormal = -si.faceNormal;
      ndv1 = -ndv1;
    }
    if (ndv2 < 0.0) {
      si.normal = -si.normal;
      ndv2 = -ndv2;
    }
  }
  // In same edge cases normal is not torwards the camera while we can still see the face.
  // We need to choose faceNormal in this case.
  bool useFaceN = ndv1 >= 0.0 && ndv2 < 0.0;
  float ndv = useFaceN ? ndv1 : ndv2;
  vec3 normal = useFaceN ? si.faceNormal : si.normal;

  mat.inside = ndv <= 0.0 && !mat.thinWalled;
  // In or out
  mat.relativeIor = ndv > 0.0 ? (1.0 / mat.specularIor) : mat.specularIor;
  vec3 ffnormal = ndv >= 0.0 ? normal : -normal;
#ifdef USE_COAT_NORMAL_FRAMES
  if (mat.coatNormalEnabled) {
    vec3 view = -path.ray.d;
    float geometricView = dot(originalFace, view);
    mat.geometricNormal = geometricView >= 0.0 ? originalFace : -originalFace;
    ffnormal = coat_frame_normal(originalNormal, originalFace, view);
    mat.coatNormal = coat_frame_normal(si.coatNormal, originalFace, view);
    mat.inside = geometricView <= 0.0 && !mat.thinWalled;
    mat.relativeIor = (geometricView > 0.0 || mat.thinWalled) ? 1.0 / mat.specularIor : mat.specularIor;
  }
#endif


  float scatteringPdf;
  vec3 scatterDir;
  path.scatteringIsDelta = false;
  bool mediumSampled = false;
  bool crossedBoundary = false;
  OpenPbrPreparedBsdf prepared;

#ifdef HAS_MEDIUM
  int mediumType = si.mediumType;
  float d = distance(si.position, path.ray.o);
  vec3 segmentOrigin = path.ray.o;
  vec3 extinction = si.mediumExtinction;
  vec3 scattering = min(si.mediumScattering, extinction);
  float majorant = max(max(extinction.x, extinction.y), extinction.z);
  if (mediumType > 0 && majorant > 0.0) {
    // Sample one RGB extinction channel and divide by the mixture PDF. This
    // is the homogeneous-medium estimator used by PBRT and avoids the very
    // large exp((majorant - extinction) * distance) weights produced by
    // majorant tracking when OpenPBR SSS radii differ strongly by channel.
    int mediumChannel = min(int(sample1D(bounceDim(MEDIUM_CHANNEL)) * 3.0), 2);
    float channelExtinction = extinction[mediumChannel];
    float scatterDist = channelExtinction > 0.0
      ? min(-log(max(sample1D(bounceDim(MEDIUM_DISTANCE)), 1e-7)) / channelExtinction, d)
      : d;
    mediumSampled = scatterDist < d;
    vec3 transmittance = exp(-extinction * scatterDist);
    vec3 density = mediumSampled
      ? extinction * transmittance
      : transmittance;
    float mediumPdf = max(
      (density.x + density.y + density.z) / 3.0,
      1e-8
    );
    if (mediumSampled) {
      path.beta *= transmittance * scattering / mediumPdf;
      // Move from the start of the segment, not from its end surface.
      path.ray.o = segmentOrigin + scatterDist * path.ray.d;
      si.position = path.ray.o;
      path.li += DirectLight(si, mat, prepared, path, ffnormal, false) * path.beta;

      // Pick a new direction based on the phase function
      scatterDir = sampling_henyey_greenstein(
        -path.ray.d,
        si.mediumAnisotropy,
        sample2D(bounceDim(PHASE_DIRECTION))
      );
      scatteringPdf = sampling_henyey_greenstein_phase(
        dot(scatterDir, -path.ray.d),
        si.mediumAnisotropy
      );
    }
    else {
      path.beta *= transmittance / mediumPdf;
    }
  }
#endif

  // Direct lighting
  if (!mediumSampled) {
    path.li += emissiveHitMisWeight(si,path) * mat.emission * path.beta;
    if (mat.materialType == UNLIT) {
      path.abort = true;
      return;
    }
    vec3 surfaceTangent = vec3(0.0);
#ifdef USE_TANGENT
    surfaceTangent = si.tangent;
#endif
    mat.directionTangent = si.directionTangent;
    mat.directionBitangent = si.directionBitangent;
    mat.geometryTangent = si.geometryTangent;
    mat.geometryBitangent = si.geometryBitangent;
    prepared = openpbr_prepare(surfaceTangent, mat, -path.ray.d, ffnormal);
    path.li += DirectLight(si, mat, prepared, path, ffnormal, true) * path.beta;
    // Sample BSDF for color and outgoing direction
    bool isNextRefraction;
    vec3 f = openpbr_sample_prepared(
      prepared,
      matRnd,
      scatterDir,
      scatteringPdf,
      isNextRefraction
    );
    // Null-boundary transmission is discrete and has no NEE competitor.
    path.scatteringIsDelta = !prepared.material.thinWalled &&
      abs(prepared.material.relativeIor - 1.0) <= 1e-6 &&
      prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] >= 1.0 - 1e-6;
    // Match WebGPU: rejected VNDF/refraction proposals have no continuation.
    // Tracing their fallback direction with the incoming throughput invents
    // light paths, especially after total internal reflection inside glass.
    if (!(scatteringPdf > 0.0) || any(isnan(f)) || any(isinf(f)) ||
        dot(scatterDir, scatterDir) < 0.5) {
      path.scatteringPdf = 0.0;
      path.abort = true;
      return;
    }
    path.beta *= f / scatteringPdf;
    crossedBoundary = !mat.thinWalled &&
      isNextRefraction;
    path.isNextRefraction = isNextRefraction;
    // TODO prefer the opaque surface when transmission surface and opaque surface are overlapped.
    // Or the ray go out from transmission material will miss the opque surface.
    path.ray.o = si.position + EPS * scatterDir;
#ifdef USE_COAT_NORMAL_FRAMES
    if (mat.coatNormalEnabled) { path.ray.o = si.position + EPS * (dot(originalFace, scatterDir) >= 0.0 ? originalFace : -originalFace); }
#endif
  }

  path.scatteringPdf = scatteringPdf;
  initRay(path.ray, path.ray.o, scatterDir);
  if (mediumSampled) {
    path.isNextRefraction = false;
  }
  path.fromEye = false;

#ifdef HAS_MEDIUM
  // A reflected ray stays in its current medium. Only a sampled transmission
  // event crosses the boundary of a medium-bearing closed mesh.
  if (!mediumSampled && crossedBoundary && mat.mediumType > 0) {
    if (ndv1 >= 0.0) {
      si.mediumType = mat.mediumType;
      si.mediumExtinction = mat.mediumExtinction;
      si.mediumScattering = mat.mediumScattering;
      si.mediumAnisotropy = mat.mediumAnisotropy;
    }
    else {
      si.mediumType = 0;
      si.mediumExtinction = vec3(0.0);
      si.mediumScattering = vec3(0.0);
      si.mediumAnisotropy = 0.0;
    }
  }
#endif
}
`;
