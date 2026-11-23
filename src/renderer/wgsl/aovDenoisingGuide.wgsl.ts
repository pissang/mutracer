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
`;
}
