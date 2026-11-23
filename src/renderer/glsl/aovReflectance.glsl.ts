import proposals from './aovReflectanceSamples.glsl.js';

// GLSL mirror of the shared 256-proposal, fused OpenPBR reflection quadrature.
export default proposals + /* glsl */ `
vec3 aovCoatReflectance(OpenPbrPreparedBsdf prepared) {
  OpenPbrResolvedMaterial material = prepared.material;
  vec3 view = prepared.viewLocal;
#ifdef USE_COAT_NORMAL_FRAMES
  if (material.coatNormalEnabled) { view = prepared.coatViewLocal; }
#endif
  if (view.z <= 1e-6) { return vec3(0.0); }
  vec2 alpha = openpbr_roughness_to_alpha(material.coatRoughness, 0.0);
  material.alphaX = alpha.x;
  material.alphaY = alpha.y;
  vec3 sum = vec3(0.0);
  for (uint i = 0u; i < uint(NO_UNROLL(128)); i++) {
    vec2 u = vec2((float(i) + 0.5) / 128.0,
      fract(float(reverseBits(i)) * 2.3283064365386963e-10 + 0.37));
    vec3 halfVector = sampling_ggx_visible_normal(view, alpha, u);
    vec3 light = reflect(-view, halfVector);
    if (light.z <= 0.0) { continue; }
#ifdef USE_COAT_NORMAL_FRAMES
    if (material.coatNormalEnabled &&
        dot(material.geometricNormal, openpbr_to_world(prepared.coatBasis, light)) <= 0.0) { continue; }
#endif
    vec3 fresnel = vec3(openpbr_dielectric_fresnel(abs(dot(view, halfVector)), 1.0 / material.coatIor));
    float pdf = 0.0;
    vec3 response = openpbr_eval_microfacet_reflection(material, view, light, halfVector, fresnel, pdf);
    if (pdf > 0.0) { sum += response * (light.z / pdf); }
  }
  return (prepared.weights[OPENPBR_LOBE_COAT] / 128.0) * sum;
}
void aovReflectance(OpenPbrPreparedBsdf prepared, bool wantDiffuse, bool wantSpecular, out vec3 diffuse, out vec3 specular, out vec3 coat) {
  diffuse=vec3(0.0); specular=vec3(0.0);
  coat = vec3(0.0);
  vec3 view = prepared.viewLocal;
  if (view.z <= 1e-6) { return; }
  OpenPbrResolvedMaterial material = prepared.material;
  bool coated = material.coatWeight > 0.0;
  vec2 alpha = vec2(material.alphaX, material.alphaY);
  float viewMasking = sampling_ggx_smith_g1(view, alpha);
  float diffuseWeight = prepared.weights[OPENPBR_LOBE_DIFFUSE];
  float metalWeight = prepared.weights[OPENPBR_LOBE_METAL];
  float specularWeight = prepared.weights[OPENPBR_LOBE_SPECULAR];
  float dielectricAverageLoss = 1.0;
  if (wantSpecular && prepared.dielectricMsProbability > 0.0) {
    dielectricAverageLoss = max(openpbr_ideal_dielectric_average_loss(prepared.refractionEtaTOverEtaI, prepared.specularAlpha), 1e-12);
  }
  vec3 sphericalView = normalize(vec3(alpha, 1.0) * view);
  float viewZ = min(sphericalView.z, 1.0);
  float capSpan = 1.0 + viewZ;
  uint count = 256u;
  for (uint i = 0u; i < uint(NO_UNROLL(256)); i++) {
    uint pair = i / 2u;
    vec2 u = vec2((float(pair) + 0.5) / float(count / 2u),
      fract(float(reverseBits(pair)) * 2.3283064365386963e-10 + 0.37));
    vec4 proposal = mtReflectanceProposals[pair];
    // Same near-delta runtime fallback as WGSL.
    bool runtimeProposal = prepared.specularAlpha < 0.001;
    vec3 light = vec3(proposal.xy, sqrt(max(0.0, 1.0 - dot(proposal.xy, proposal.xy))));
    if (runtimeProposal) { light = sampling_cosine_hemisphere(u); }
    if ((i & 1u) != 0u) {
      float normalZ = (1.0 - u.y) * capSpan;
      float radial = sqrt(max(0.0, (normalZ + (1.0 - viewZ)) * (u.y * capSpan)));
      vec3 halfVector = normalize(vec3(alpha, 1.0) * vec3(sphericalView.xy + radial * proposal.zw, normalZ));
      if (runtimeProposal) { halfVector = sampling_ggx_visible_normal(view, alpha, u); }
      light = reflect(-view, halfVector);
    }
    // Rejected VNDF proposals retain their weight in the denominator.
    if (light.z <= 0.0) { continue; }
    vec3 halfVector = normalize(view + light);
    float specularPdf = viewMasking * sampling_ggx_ndf(halfVector, alpha) / (4.0 * view.z);
    float pdf = 0.5 * (light.z * INVPI + specularPdf);
    // Preserve the production evaluator's frame round trip, including FP32
    // rounding near narrow highlights. Proposal PDFs use the original light.
    vec3 evaluatedWorld = openpbr_to_world(prepared.basis, light);
    vec3 evaluatedLight = openpbr_to_local(prepared.basis, evaluatedWorld);
    if (evaluatedLight.z <= 0.0) { continue; }
#ifdef USE_COAT_NORMAL_FRAMES
    if (material.coatNormalEnabled && dot(material.geometricNormal, evaluatedWorld) <= 0.0) { continue; }
#endif
    float scale = abs(evaluatedLight.z) / (pdf * float(count));
    vec3 substrateScale = vec3(1.0);
    if (coated) {
      float coatCosine = evaluatedLight.z;
#ifdef USE_COAT_NORMAL_FRAMES
      if (material.coatNormalEnabled) { coatCosine = dot(prepared.coatBasis.normal, evaluatedWorld); }
#endif
      substrateScale = openpbr_coat_base_scale(prepared, coatCosine);
    }
    if (wantDiffuse && diffuseWeight > 0.0) {
      float compensation = prepared.diffuseSpecularEnergyCompensation * openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI, prepared.specularAlpha, abs(evaluatedLight.z));
      float unusedPdf = 0.0;
      diffuse += diffuseWeight * openpbr_eval_diffuse(material, prepared.diffuseColor,
        view, evaluatedLight, compensation, unusedPdf) * scale * substrateScale;
    }
    if (wantSpecular) {
      vec3 evaluatedHalf = normalize(view + evaluatedLight);
      float viewHalf = abs(dot(view, evaluatedHalf));
      vec3 fresnel = vec3(0.0);
      if (specularWeight > 0.0) {
        vec3 dielectric = vec3(openpbr_substrate_fresnel(prepared, viewHalf, true));
        if (material.thinWalled) { dielectric = openpbr_thin_wall_reflection_coefficient(dielectric, material.transmissionWeight); }
        fresnel += specularWeight * material.specularColor * dielectric;
      }
      if (metalWeight > 0.0) {
        fresnel += metalWeight * material.specularWeight * openpbr_metal_fresnel(viewHalf,
          material.baseWeight * material.baseColor, material.specularColor);
      }
      float microfacet = sampling_ggx_ndf(evaluatedHalf, alpha) * viewMasking
        * sampling_ggx_smith_g1(evaluatedLight, alpha) / (4.0 * max(evaluatedLight.z * view.z, 1e-8));
      vec3 reflection = fresnel * microfacet;
      if (metalWeight > 0.0 && prepared.metalMsFactor > 0.0) {
        float factor = min(prepared.metalMsFactor * openpbr_metal_energy_complement(prepared.specularAlpha, evaluatedLight.z), 1.0 / max(evaluatedLight.z, 1e-8));
        reflection += metalWeight * prepared.metalMsScale * factor * INVPI;
      }
      if (prepared.dielectricMsProbability > 0.0) {
        float factors = prepared.dielectricMsViewLoss * openpbr_ideal_dielectric_loss(
          prepared.refractionEtaTOverEtaI, prepared.specularAlpha, abs(evaluatedLight.z)) / dielectricAverageLoss;
        float factor = min(factors * prepared.dielectricMsReflectionRatio, 1.0 / abs(evaluatedLight.z));
        reflection += prepared.dielectricMsReflectionScale * factor * INVPI;
      }
      specular += reflection * scale * substrateScale;
    }
  }
  if (wantSpecular && prepared.weights[OPENPBR_LOBE_COAT] > 0.0) {
    coat = aovCoatReflectance(prepared);
  }
}
`;
