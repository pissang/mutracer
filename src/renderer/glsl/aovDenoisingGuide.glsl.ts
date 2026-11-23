/** GLSL mirror of the opaque OpenPBR denoising guides. */
export default /* glsl */ `
struct AovDenoisingGuide {
  vec3 diffuse;
  vec3 specular;
  vec4 normalRoughness;
};

AovDenoisingGuide aovDenoisingGuide(OpenPbrPreparedBsdf prepared, vec3 diffuse, vec3 specular, vec3 coat) {
  OpenPbrResolvedMaterial material = prepared.material;
  float baseAlpha = sqrt(material.alphaX * material.alphaY);
  float coatAlpha = openpbr_roughness_to_alpha(material.coatRoughness, 0.0).x;
  float baseDiffuse = smoothstep(0.0, 0.15, baseAlpha);
  float coatDiffuse = smoothstep(0.0, 0.15, coatAlpha);

  vec3 diffuseGuide = diffuse + specular * baseDiffuse + coat * coatDiffuse;
  vec3 specularGuide = specular * (1.0 - baseDiffuse) + coat * (1.0 - coatDiffuse);

  vec3 mean = vec3(1.0 / 3.0);
  vec3 weights = vec3(dot(diffuse, mean), dot(specular, mean), dot(coat, mean));
  float total = dot(weights, vec3(1.0));
  if (total <= 0.0) { return AovDenoisingGuide(diffuseGuide, specularGuide, vec4(0.0)); }
  vec3 normal = prepared.basis.normal;
  vec3 coatNormal = normal;
#ifdef USE_COAT_NORMAL_FRAMES
  coatNormal = prepared.coatBasis.normal;
#endif
  vec3 weightedNormal = (weights.x + weights.y) * normal + weights.z * coatNormal;
  float weightedRoughness = dot(weights, vec3(1.0, sqrt(baseAlpha), sqrt(coatAlpha)));
  return AovDenoisingGuide(diffuseGuide, specularGuide, vec4(weightedNormal, weightedRoughness) / total);
}
`;
