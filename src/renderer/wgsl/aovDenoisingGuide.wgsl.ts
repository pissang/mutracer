/** Builds opaque denoising guides from the OpenPBR reflectance components. */
export function createAovDenoisingGuideWgsl(hasCoatNormals: boolean) {
  // Follow the closure weighting in Cycles 5.3's kernel/film/denoising_passes.h.
  return /* wgsl */ `
struct AovDenoisingGuide {
  diffuse: vec3f,
  specular: vec3f,
  normalRoughness: vec4f,
}

fn aovDenoisingGuide(prepared: OpenPbrPreparedBsdf, reflectance: MtReflectance) -> AovDenoisingGuide {
  let material = prepared.material;
  let baseAlpha = sqrt(material.alphaX * material.alphaY);
  let coatAlpha = openpbr_roughness_to_alpha(material.coatRoughness, 0.0).x;
  let baseDiffuse = smoothstep(0.0, 0.15, baseAlpha);
  let coatDiffuse = smoothstep(0.0, 0.15, coatAlpha);

  let diffuse = reflectance.diffuse + reflectance.specular * baseDiffuse + reflectance.coat * coatDiffuse;
  let specular = reflectance.specular * (1.0 - baseDiffuse) + reflectance.coat * (1.0 - coatDiffuse);

  // Cycles weights feature vectors by the RGB mean of the closure's albedo.
  let mean = vec3f(1.0 / 3.0);
  let weights = vec3f(dot(reflectance.diffuse, mean), dot(reflectance.specular, mean), dot(reflectance.coat, mean));
  let total = dot(weights, vec3f(1.0));
  if (total <= 0.0) { return AovDenoisingGuide(diffuse, specular, vec4f(0.0)); }
  let normal = prepared.basis.normal;
  let coatNormal = ${hasCoatNormals ? 'prepared.coatBasis.normal' : 'normal'};
  let weightedNormal = (weights.x + weights.y) * normal + weights.z * coatNormal;
  let weightedRoughness = dot(weights, vec3f(1.0, sqrt(baseAlpha), sqrt(coatAlpha)));
  return AovDenoisingGuide(diffuse, specular, vec4f(weightedNormal, weightedRoughness) / total);
}

struct AovDenoisingPathGuide {
  throughput: vec3f,
  diffuse: vec3f,
  normal: vec3f,
  depth: f32,
}

// Each hit receives the feature weight carried by the sampled path. The
// caller supplies its traced segment length and keeps first-hit specular
// albedo and roughness separately.
fn aovFollowDenoisingPath(path: ptr<function, AovDenoisingPathGuide>, surface: AovDenoisingGuide, segmentLength: f32) {
  let throughput = (*path).throughput;
  let mean = vec3f(1.0 / 3.0);
  let diffuseWeight = dot(surface.diffuse, mean);
  let totalWeight = diffuseWeight + dot(surface.specular, mean);
  var here = 0.0;
  if (totalWeight > 0.0) { here = smoothstep(0.0, 0.5, diffuseWeight / totalWeight); }

  let incomingWeight = dot(throughput, mean);
  (*path).depth += incomingWeight * segmentLength;
  (*path).normal += (incomingWeight * here) * surface.normalRoughness.xyz;
  (*path).diffuse += here * throughput * surface.diffuse;

  let deferred = (1.0 - here) * surface.specular;
  let largest = max(max(deferred.x, deferred.y), deferred.z);
  (*path).throughput = select(vec3f(0.0), throughput * deferred, largest > 1e-4);
}
`;
}
