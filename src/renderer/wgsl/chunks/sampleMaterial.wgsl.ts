// Next-event estimation with resampled importance sampling over the light
// candidates, followed by BSDF (or phase function) sampling, as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral
export function createSampleMaterialWgsl(hasAnisotropyDirections = true, hasCoatNormals = false) {
  return /* wgsl */ `

struct ShadowRayWork {
  ray: Ray,
  maxDistance: f32,
  triangleIndex: i32,
  contribution: vec3f,
  // RIS target of the candidate. The discrete light-selection PMF is excluded
  // and represented by the candidate's unbiased contribution weight instead.
  risTarget: f32,
  lightSelectionPmf: f32,
  valid: bool,
}

fn finishDirectLight(
  si: ptr<function, SurfaceInteraction>,
  ma: OpenPbrResolvedMaterial,
  path: ptr<function, Path>,
  ffnormal: vec3f,
  isSurface: bool,
  lightSample: LightSampleRec,
  f: vec3f,
  scatteringPdf: f32,
  shadowWork: ptr<function, ShadowRayWork>
) -> bool {
  (*shadowWork).valid = false;
  (*shadowWork).lightSelectionPmf = 0.0;
  (*shadowWork).risTarget = 0.0;
  var Li = lightSample.emission;

  let lightDir = lightSample.direction;
  let viewDir = -(*path).ray.d;
  let lightPdf = lightSample.pdf;
  let lightSelectionPmf = lightSample.selectionPmf;
  // Keep direct-light culling consistent with the two-sided BSDF evaluation.
  // The raw imported normal can point away from the camera on interior walls.
  ${hasCoatNormals ? /* wgsl */ `var cosThetaL = dot(ffnormal, lightDir);
  if (isSurface && ma.coatNormalEnabled) { cosThetaL = dot(ma.geometricNormal, lightDir); }` : 'let cosThetaL = dot(ffnormal, lightDir);'}

  if ((lightPdf <= 0.0) | (lightSelectionPmf <= 0.0) |
      (max(max(Li.x, Li.y), Li.z) <= 0.0)) {
    return false;
  }

  if ((scatteringPdf <= 0.0) | (max(max(f.x, f.y), f.z) <= 0.0)) {
    return false;
  }

  var lightRay: Ray;
  var shadowOrigin = (*si).position + EPS * lightDir;
  if (isSurface) {
    shadowOrigin = offsetSurfaceRay((*si).position, (*si).faceNormal, lightDir);
    let shadowTerminatorCutoff = 0.1;
    var normalLight = dot((*si).normal, lightDir);
${hasCoatNormals ? /* wgsl */ `    if (ma.coatNormalEnabled) { normalLight = dot((*si).faceNormal, lightDir); }` : ''}
    let geometricNormal = select(
      (*si).faceNormal,
      -(*si).faceNormal,
      normalLight < 0.0
    );
    normalLight = abs(normalLight);
    let geometricLight = dot(geometricNormal, lightDir);
    let offsetAmount = select(
      clamp(1.0 - geometricLight / shadowTerminatorCutoff, 0.0, 1.0),
      clamp(
        2.0 - (geometricLight + normalLight) / shadowTerminatorCutoff,
        0.0,
        1.0
      ),
      normalLight < shadowTerminatorCutoff
    );
    shadowOrigin += (*si).shadowOffset * offsetAmount;
  }
  // Falcor offsets sampled emissive positions along the light normal, then
  // derives the visibility ray from that offset endpoint. Without the target
  // offset, our any-hit traversal sees the sampled light triangle itself and
  // rejects virtually every emissive NEE sample as occluded.
  var visibilityDirection = lightDir;
  var visibilityDistance = lightSample.dist - EPS;
  if (lightSample.sourceType == 1u) {
    let lightEndpoint =
      (*si).position + lightSample.direction * lightSample.dist;
    let offsetLightEndpoint = lightEndpoint + EPS * lightSample.normal;
    let toOffsetLight = offsetLightEndpoint - shadowOrigin;
    visibilityDistance = length(toOffsetLight);
    visibilityDirection = normalize(toOffsetLight);
  }
  initRay(&lightRay, shadowOrigin, visibilityDirection);

  // The continuation of a surface transmission sees the displayed background.
  // Evaluate that same endpoint for the environment proposal, so both MIS
  // strategies estimate the same radiance even for a separate/grounded skybox.
  if (isSurface & (cosThetaL < 0.0) & (lightSample.sourceType == 0u)) {
    let background = sampleSceneBackground(lightRay);
    Li = background.rgb * background.a;
  }
  if (SPECTRAL) {
    Li = sampling_spectral_rgb_filter(Li, (*si).wavelength);
  }

  // A directional source is a delta distribution and cannot be reached by
  // the BSDF-sampling strategy, so its light-sampled contribution has weight 1.
  let misWeight = select(
    neeMISWeight(lightPdf, scatteringPdf),
    1.0,
    lightSample.isDelta
  );
  if (misWeight > 0.0) {
    let unweightedContribution = Li * f / lightPdf * (*path).beta;
    (*shadowWork).risTarget = max(
      dot(max(unweightedContribution * lightSelectionPmf, vec3f(0.0)), luminance),
      0.0
    );
    (*shadowWork).ray = lightRay;
    (*shadowWork).maxDistance = visibilityDistance;
    (*shadowWork).triangleIndex = (*si).triangleIndex;
    (*shadowWork).contribution = misWeight * unweightedContribution;
    (*shadowWork).lightSelectionPmf = lightSelectionPmf;
    (*shadowWork).valid = true;
    return true;
  }
  return false;
}

struct ScatteringWork {
  direction: vec3f,
  response: vec3f,
  pdf: f32,
  transmission: bool,
}

fn sampleScattering(
  si: ptr<function, SurfaceInteraction>,
  ma: OpenPbrResolvedMaterial,
  prepared: OpenPbrPreparedBsdf,
  path: ptr<function, Path>,
  ffnormal: vec3f,
  isSurface: bool
) -> ScatteringWork {
  let candidateCount = neeCandidateCount();
  var selected: ShadowRayWork;
  selected.valid = false;
  var selectedTarget = 0.0;
  var scalarWeightSum = 0.0;
  var result: ScatteringWork;
  // The final iteration samples the continuation after NEE and its shadow ray.
  // Both proposals use one BSDF evaluation call site, avoiding a second inlined
  // optical graph. Keep all random draws and visibility queries in their
  // original order, including the short-circuit reservoir replacement draw.
  for (var event = 0u; event <= candidateCount; event++) {
    let continuation = event == candidateCount;
    var lightSample: LightSampleRec;
    var lightDir: vec3f;
    var scatteringPdf = 0.0;
    var response = vec3f(0.0);
    var discrete = false;
    if (continuation) {
      var candidateUCW = 1.0;
      var valid = selected.valid;
      if (candidateCount > 1u) {
        valid = valid & (selectedTarget > 0.0);
        if (valid) {
          candidateUCW = selected.lightSelectionPmf * scalarWeightSum /
            (f32(candidateCount) * selectedTarget);
        }
      }
      if (valid && !intersectSceneShadow(selected.ray, selected.maxDistance, selected.triangleIndex)) {
        (*path).li += selected.contribution * candidateUCW;
      }
      if (!isSurface) {
        result.direction = sampling_henyey_greenstein(-(*path).ray.d,
          (*si).mediumAnisotropy, sample2D(bounceDim(PHASE_DIRECTION)));
        result.pdf = sampling_henyey_greenstein_phase(
          dot(result.direction, -(*path).ray.d), (*si).mediumAnisotropy);
        return result;
      }
      let matRnd = vec3f(sample2D(bounceDim(BSDF_DIRECTION)), sample1D(bounceDim(BSDF_LOBE)));
      discrete = !prepared.material.thinWalled &
        (abs(prepared.material.relativeIor - 1.0) <= 1e-6) &
        (prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] >= 1.0 - 1e-6);
      if (discrete) {
        lightDir = openpbr_to_world(prepared.basis, -prepared.viewLocal);
        response = openpbr_transmission_tint(prepared.material) * openpbr_coat_base_scale(prepared,
          ${hasCoatNormals ? 'select(-prepared.viewLocal.z, dot(prepared.coatBasis.normal, lightDir), prepared.material.coatNormalEnabled)' : '-prepared.viewLocal.z'});
        scatteringPdf = 1.0;
        result.transmission = true;
      } else {
        var roughness = 1.0; var specular = false; var diffuse = true;
        var lobe = u32(OPENPBR_LOBE_DIFFUSE);
        // Use locals rather than member pointers for Naga's SPIR-V writer.
        var transmission = false;
        if (!openpbr_sample_direction(prepared, matRnd, &lightDir, &transmission,
            &roughness, &specular, &diffuse, &lobe)) { return result; }
        result.transmission = transmission;
      }
    } else {
      let lightRnd = vec3f(sample2D(lightDim(event, 1u)), sample1D(lightDim(event, 0u)));
      sampleLightForNEECandidate((*si).position, lightRnd, event, candidateCount, &lightSample);
      lightDir = lightSample.direction;
      if ((lightSample.pdf <= 0.0) | (lightSample.selectionPmf <= 0.0) |
          (max(max(lightSample.emission.x, lightSample.emission.y), lightSample.emission.z) <= 0.0)) { continue; }
      ${hasCoatNormals ? /* wgsl */ `var cosThetaL = dot(ffnormal, lightDir);
      if (isSurface & ma.coatNormalEnabled) { cosThetaL = dot(ma.geometricNormal, lightDir); }` : /* wgsl */ `let cosThetaL = dot(ffnormal, lightDir);`}
      if (isSurface & (cosThetaL <= 0.0) & (ma.transmissionWeight <= 0.0) & (ma.subsurfaceWeight <= 0.0)) { continue; }
    }
    if (!discrete) {
      if (isSurface) {
        response = openpbr_eval_prepared(prepared, lightDir, &scatteringPdf);
      } else {
        scatteringPdf = sampling_henyey_greenstein_phase(
          dot(-(*path).ray.d, lightDir), (*si).mediumAnisotropy);
        response = vec3f(scatteringPdf);
      }
    }
    if (continuation) {
      result.direction = lightDir; result.response = response; result.pdf = scatteringPdf;
      return result;
    }
    var candidate: ShadowRayWork;
    let candidateValid = finishDirectLight(si, ma, path, ffnormal, isSurface,
      lightSample, response, scatteringPdf, &candidate);
    if (!candidateValid) { continue; }
    if (candidateCount == 1u) {
      selected = candidate;
      continue;
    }
    let scalarWeight = candidate.risTarget / max(candidate.lightSelectionPmf, 1e-20);
    if (!(scalarWeight > 0.0) | (scalarWeight != scalarWeight)) { continue; }
    scalarWeightSum += scalarWeight;
    if (!selected.valid ||
        lightCandidateRandom(event) * scalarWeightSum <= scalarWeight) {
      selected = candidate;
      selectedTarget = candidate.risTarget;
    }
  }
  return result;
}

fn emissiveHitMisWeight(
  si: ptr<function, SurfaceInteraction>,
  path: ptr<function, Path>
) -> f32 {
  // Secondary traversal accepts back faces for transmission; a one-sided
  // emitter still radiates only into its front hemisphere.
  let cosLight = dot((*si).faceNormal, -(*path).ray.d);
  if (cosLight <= 0.0 && materialsBuffer[(*si).materialIndex].doubleSided < 0.5) { return 0.0; }
  if ((*path).fromEye | (rtUniform.lightWeightTotal <= 0.0) |
      (i32(materialsBuffer[(*si).materialIndex].matType) == UNLIT)) {
    return 1.0;
  }
  let samplingLuminance = dot(
    materialsBuffer[(*si).materialIndex].emission,
    luminance
  );
  if ((samplingLuminance <= 0.0) | (cosLight <= 0.0)) {
    return 1.0;
  }
  let hitDistance = distance((*si).position, (*path).ray.o);
  let lightPdf = samplingLuminance / rtUniform.lightWeightTotal *
    hitDistance * hitDistance / max(cosLight, 1e-8);
  return bsdfMISWeight((*path).scatteringPdf, lightPdf);
}

${hasCoatNormals ? /* wgsl */ `
// Keep each shading frame in the geometric/view hemisphere. This correction
// does not replace the face normal used for topology or ray offsets.
fn coat_frame_normal(input: vec3f, face: vec3f, view: vec3f) -> vec3f {
  let front = dot(face, view) >= 0.0;
  let ffFace = select(-face, face, front);
  let ffInput = select(-input, input, front);
  if ((dot(input, face) <= 0.0) | (dot(ffInput, view) <= 1e-6)) { return ffFace; }
  return ffInput;
}
` : ''}
fn SampleMaterial(
  si: ptr<function, SurfaceInteraction>,
  ma: ptr<function, OpenPbrResolvedMaterial>,
  path: ptr<function, Path>
) {
${hasCoatNormals ? /* wgsl */ `
  let originalFace = (*si).faceNormal;
  let originalNormal = (*si).normal;
` : ''}
  var ndv1: f32 = -dot((*si).faceNormal, (*path).ray.d);
  var ndv2: f32 = -dot((*si).normal, (*path).ray.d);
  if ((((*ma).transmissionWeight > 0.0) | ((*ma).subsurfaceWeight > 0.0)) & (*ma).thinWalled) {
    // Always treat thin material as entering medium
    if (ndv1 < 0.0) {
      (*si).faceNormal = -(*si).faceNormal;
      ndv1 = -ndv1;
    }
    if (ndv2 < 0.0) {
      (*si).normal = -(*si).normal;
      ndv2 = -ndv2;
    }
  }
  // In same edge cases normal is not torwards the camera while we can still see the face.
  // We need to choose faceNormal in this case.
  var useFaceN: bool = (ndv1 >= 0.0) & (ndv2 < 0.0);
  var ndv: f32 = select(ndv2, ndv1, useFaceN);
  var N: vec3f = select((*si).normal, (*si).faceNormal, useFaceN);

  (*ma).inside = (ndv <= 0.0) & !(*ma).thinWalled;
  // In or out
  (*ma).relativeIor = select((*ma).specularIor, (1.0 / (*ma).specularIor), ndv > 0.0);
  var ffnormal = select(-N, N, ndv >= 0.0);
${hasCoatNormals ? /* wgsl */ `
  if ((*ma).coatNormalEnabled) {
    let view = -(*path).ray.d;
    let geometricView = dot(originalFace, view);
    (*ma).geometricNormal = select(-originalFace, originalFace, geometricView >= 0.0);
    ffnormal = coat_frame_normal(originalNormal, originalFace, view);
    (*ma).coatNormal = coat_frame_normal((*si).coatNormal, originalFace, view);
    (*ma).inside = (geometricView <= 0.0) & !(*ma).thinWalled;
    (*ma).relativeIor = select((*ma).specularIor, 1.0 / (*ma).specularIor, (geometricView > 0.0) | (*ma).thinWalled);
  }
` : ''}

  (*path).scatteringIsDelta = false;
  var mediumSampled = false;
  var crossedBoundary = false;
  let mediumType = (*si).mediumType;

  var scatteringPdf: f32;
  var scatterDir: vec3f;

  if (HAS_MEDIUM) {
    let d = distance((*si).position, (*path).ray.o);
    let segmentOrigin = (*path).ray.o;
    let extinction = (*si).mediumExtinction;
    let scattering = min((*si).mediumScattering, extinction);
    let majorant = max(max(extinction.x, extinction.y), extinction.z);
    if ((mediumType > 0) & (majorant > 0.0)) {
      // Sample one RGB extinction channel and divide by the mixture PDF. This
      // avoids high-variance majorant weights for channel-dependent SSS radii.
      let mediumChannel = min(i32(sample1D(bounceDim(MEDIUM_CHANNEL)) * 3.0), 2);
      let channelExtinction = extinction[mediumChannel];
      let scatterDist = select(
        d,
        min(-log(max(sample1D(bounceDim(MEDIUM_DISTANCE)), 1e-7)) / channelExtinction, d),
        channelExtinction > 0.0
      );
      mediumSampled = scatterDist < d;
      let transmittance = exp(-extinction * scatterDist);
      let density = select(
        transmittance,
        extinction * transmittance,
        mediumSampled
      );
      let mediumPdf = max((density.x + density.y + density.z) / 3.0, 1e-8);
      if (mediumSampled) {
        (*path).beta *= transmittance * scattering / mediumPdf;
        // Move from the start of the segment, not from its end surface.
        (*path).ray.o = segmentOrigin + scatterDist * (*path).ray.d;
        (*si).position = (*path).ray.o;
      }
      else {
        (*path).beta *= transmittance / mediumPdf;
      }
    }
  }

  if (!mediumSampled) {
    (*path).li += emissiveHitMisWeight(si, path) * (*ma).emission * (*path).beta;
  }
  if ((*ma).materialType == UNLIT) {
    (*path).abort = true;
    return;
  }
  // Surface and medium events share the light estimator. Emission is added
  // before NEE, then the continuation direction is sampled.
  var prepared: OpenPbrPreparedBsdf;
  if (!mediumSampled) {
${hasAnisotropyDirections ? /* wgsl */ `
    (*ma).directionTangent = (*si).directionTangent;
    (*ma).directionBitangent = (*si).directionBitangent;
    (*ma).geometryTangent = (*si).geometryTangent;
    (*ma).geometryBitangent = (*si).geometryBitangent;
` : /* wgsl */ ``}
    prepared = openpbr_prepare((*si).tangent, *ma, -(*path).ray.d, ffnormal);
  }
  let scattered = sampleScattering(si, *ma, prepared, path, ffnormal, !mediumSampled);
  scatterDir = scattered.direction;
  scatteringPdf = scattered.pdf;
  if (!mediumSampled) {
    let f = scattered.response;
    let isNextRefraction = scattered.transmission;
    // A rejected microfacet proposal (including failed refraction), or a
    // material with no scattering lobes, has no continuation. Keep emission
    // and NEE already accumulated at this vertex, but never trace a default
    // direction with the incoming throughput: that invents extra light paths.
    if (!(scatteringPdf > 0.0) |
        !all(f == f) | !all(abs(f) < vec3f(3.402823e38)) |
        (dot(scatterDir, scatterDir) < 0.5)) {
      (*path).scatteringPdf = 0.0;
      (*path).abort = true;
      return;
    }
    // Exactly index-matched solid transmission is a discrete null boundary;
    // environment NEE has no competing density for that event.
    (*path).scatteringIsDelta = !prepared.material.thinWalled &
      (abs(prepared.material.relativeIor - 1.0) <= 1e-6) &
      (prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] >= 1.0 - 1e-6);
    (*path).beta *= f / scatteringPdf;

    crossedBoundary = isNextRefraction & !(*ma).thinWalled;
    (*path).isNextRefraction = isNextRefraction;
    // TODO prefer the opaque surface when transmission surface and opaque surface are overlapped.
    // Or the ray go out from transmission material will miss the opque surface.
    (*path).ray.o = (*si).position + EPS * scatterDir;
${hasCoatNormals ? /* wgsl */ `
    if ((*ma).coatNormalEnabled) { (*path).ray.o = (*si).position + EPS * select(-originalFace, originalFace, dot(originalFace, scatterDir) >= 0.0); }
` : ''}
  }
  (*path).scatteringPdf = scatteringPdf;
  (*path).ray.d = scatterDir;
  if (mediumSampled) {
    (*path).isNextRefraction = false;
  }

  (*path).fromEye = false;

  if (HAS_MEDIUM) {
    // Reflections stay in the current medium. Enter or leave only after the
    // BSDF actually sampled transmission through a medium boundary.
    if (!mediumSampled & crossedBoundary & ((*ma).mediumType > 0)) {
      if (ndv1 >= 0.0) {
        (*si).mediumType = (*ma).mediumType;
        (*si).mediumExtinction = (*ma).mediumExtinction;
        (*si).mediumScattering = (*ma).mediumScattering;
        (*si).mediumAnisotropy = (*ma).mediumAnisotropy;
      }
      else {
        (*si).mediumType = 0;
        (*si).mediumExtinction = vec3f(0.0);
        (*si).mediumScattering = vec3f(0.0);
        (*si).mediumAnisotropy = 0.0;
      }
    }
  }
}
`;

}

export default createSampleMaterialWgsl();
