import proposals from './aovReflectanceSamples.wgsl.js';

// Directional-hemispherical quadrature of the supported OpenPBR
// reflection lobes. Keep the original 256 cosine/VNDF proposals and weights;
// integrate the substrate and the narrower coat with their own proposals.
export const unsupportedCoatReflectanceWgsl =
  'material.coatWeight > 0.0 && (material.coatAnisotropy > 0.0 || material.transmissionWeight > 0.0)';

export function createAovReflectanceWgsl(layered = false, hasCoatNormals = false) {
  return proposals + /* wgsl */ `
struct MtReflectance {
  diffuse: vec3f,
  specular: vec3f,${layered ? '\n  coat: vec3f,' : ''}
}
${layered ? /* wgsl */ `fn mtCoatReflectance(prepared: OpenPbrPreparedBsdf, count: u32) -> vec3f {
  var material = prepared.material;
  let view = ${hasCoatNormals ? 'select(prepared.viewLocal, prepared.coatViewLocal, material.coatNormalEnabled)' : 'prepared.viewLocal'};
${hasCoatNormals ? /* wgsl */ `  if (view.z <= 1e-6) { return vec3f(0.0); }
` : ''}  let alpha = openpbr_roughness_to_alpha(material.coatRoughness, 0.0);
  material.alphaX = alpha.x;
  material.alphaY = alpha.y;
  var sum = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let u = vec2f((f32(i) + 0.5) / f32(count),
      fract(f32(reverseBits(i)) * 2.3283064365386963e-10 + 0.37));
    let half = sampling_ggx_visible_normal(view, alpha, u);
    let light = reflect(-view, half);
    if (light.z <= 0.0) { continue; }
${hasCoatNormals ? /* wgsl */ `    if (material.coatNormalEnabled &&
        dot(material.geometricNormal, openpbr_to_world(prepared.coatBasis, light)) <= 0.0) { continue; }
` : ''}    let fresnel = vec3f(openpbr_dielectric_fresnel(abs(dot(view, half)), 1.0 / material.coatIor));
    var pdf = 0.0;
    let response = openpbr_eval_microfacet_reflection(material, view, light, half, fresnel, &pdf);
    if (pdf > 0.0) { sum += response * (light.z / pdf); }
  }
  return (prepared.weights[OPENPBR_LOBE_COAT] / f32(count)) * sum;
}
` : ''}fn mtFrameReflectanceComponents(prepared: OpenPbrPreparedBsdf, wantDiffuse: bool, wantSpecular: bool) -> MtReflectance {
  var result = MtReflectance();
  let view = prepared.viewLocal;
  if (view.z <= 1e-6) { return result; }
  let material = prepared.material;${layered ? '\n  let coated = material.coatWeight > 0.0;' : ''}
  let alpha = vec2f(material.alphaX, material.alphaY);
  let viewMasking = sampling_ggx_smith_g1(view, alpha);
  let diffuseWeight = prepared.weights[OPENPBR_LOBE_DIFFUSE];
  let metalWeight = prepared.weights[OPENPBR_LOBE_METAL];
  let specularWeight = prepared.weights[OPENPBR_LOBE_SPECULAR];
  var dielectricAverageLoss = 1.0;
  if (wantSpecular && prepared.dielectricMsProbability > 0.0) {
    dielectricAverageLoss = max(openpbr_ideal_dielectric_average_loss(prepared.refractionEtaTOverEtaI, prepared.specularAlpha), 1e-12);
  }
  let sphericalView = normalize(vec3f(alpha, 1.0) * view);
  let viewZ = min(sphericalView.z, 1.0);
  let capSpan = 1.0 + viewZ;
  let count = 256u * min(rtUniform.loopUnrollGuard, 4u) / 4u;
  for (var i = 0u; i < count; i++) {
    let pair = i / 2u;
    let u = vec2f((f32(pair) + 0.5) / f32(count / 2u),
      fract(f32(reverseBits(pair)) * 2.3283064365386963e-10 + 0.37));
    let proposal = mtReflectanceProposals[pair];
    // Retain runtime proposals near delta lobes: tiny device-specific sin/cos
    // rounding differences can otherwise be magnified by their narrow PDFs.
    let runtimeProposal = prepared.specularAlpha < 0.001 || count != 256u;
    var light = vec3f(proposal.xy, sqrt(max(0.0, 1.0 - dot(proposal.xy, proposal.xy))));
    if (runtimeProposal) { light = sampling_cosine_hemisphere(u); }
    if ((i & 1u) != 0u) {
      let normalZ = (1.0 - u.y) * capSpan;
      let radial = sqrt(max(0.0, (normalZ + (1.0 - viewZ)) * (u.y * capSpan)));
      var half = normalize(vec3f(alpha, 1.0) * vec3f(sphericalView.xy + radial * proposal.zw, normalZ));
      if (runtimeProposal) { half = sampling_ggx_visible_normal(view, alpha, u); }
      light = reflect(-view, half);
    }
    // Rejected VNDF proposals retain their weight in the denominator.
    if (light.z <= 0.0) { continue; }
    let half = normalize(view + light);
    let specularPdf = viewMasking * sampling_ggx_ndf(half, alpha) / (4.0 * view.z);
    let pdf = 0.5 * (light.z * INVPI + specularPdf);
    // Preserve the production evaluator's frame round trip, including FP32
    // rounding near narrow highlights. Proposal PDFs use the original light.
${hasCoatNormals ? /* wgsl */ `    let evaluatedWorld = openpbr_to_world(prepared.basis, light);
    let evaluatedLight = openpbr_to_local(prepared.basis, evaluatedWorld);
    if (evaluatedLight.z <= 0.0) { continue; }
    if (material.coatNormalEnabled && dot(material.geometricNormal, evaluatedWorld) <= 0.0) { continue; }
` : /* wgsl */ `    let evaluatedLight = openpbr_to_local(prepared.basis, openpbr_to_world(prepared.basis, light));
    if (evaluatedLight.z <= 0.0) { continue; }
`}    let scale = abs(evaluatedLight.z) / (pdf * f32(count));
${layered ? /* wgsl */ `    var substrateScale = vec3f(1.0);
    if (coated) { substrateScale = openpbr_coat_base_scale(prepared, ${hasCoatNormals ? 'select(evaluatedLight.z, dot(prepared.coatBasis.normal, evaluatedWorld), material.coatNormalEnabled)' : 'evaluatedLight.z'}); }
` : ''}    if (wantDiffuse && diffuseWeight > 0.0) {
      let compensation = prepared.diffuseSpecularEnergyCompensation * openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI, prepared.specularAlpha, abs(evaluatedLight.z));
      var unusedPdf = 0.0;
      result.diffuse += diffuseWeight * openpbr_eval_diffuse(material, prepared.diffuseColor,
        view, evaluatedLight, compensation, &unusedPdf) * scale${layered ? ' * substrateScale' : ''};
    }
    if (wantSpecular) {
      let evaluatedHalf = normalize(view + evaluatedLight);
      let viewHalf = abs(dot(view, evaluatedHalf));
      var fresnel = vec3f(0.0);
      if (specularWeight > 0.0) {
        var dielectric = vec3f(${layered ? 'openpbr_substrate_fresnel(prepared, viewHalf, true)' : 'openpbr_dielectric_fresnel(viewHalf, material.relativeIor)'});
        if (material.thinWalled) { dielectric = openpbr_thin_wall_reflection_coefficient(dielectric, material.transmissionWeight); }
        fresnel += specularWeight * material.specularColor * dielectric;
      }
      if (metalWeight > 0.0) {
        fresnel += metalWeight * material.specularWeight * openpbr_metal_fresnel(viewHalf,
          material.baseWeight * material.baseColor, material.specularColor);
      }
      let microfacet = sampling_ggx_ndf(evaluatedHalf, alpha) * viewMasking
        * sampling_ggx_smith_g1(evaluatedLight, alpha) / (4.0 * max(evaluatedLight.z * view.z, 1e-8));
      var reflection = fresnel * microfacet;
      if (metalWeight > 0.0 && prepared.metalMsFactor > 0.0) {
        let factor = min(prepared.metalMsFactor * openpbr_metal_energy_complement(prepared.specularAlpha, evaluatedLight.z), 1.0 / max(evaluatedLight.z, 1e-8));
        reflection += metalWeight * prepared.metalMsScale * factor * INVPI;
      }
      if (prepared.dielectricMsProbability > 0.0) {
        let factors = prepared.dielectricMsViewLoss * openpbr_ideal_dielectric_loss(
          prepared.refractionEtaTOverEtaI, prepared.specularAlpha, abs(evaluatedLight.z)) / dielectricAverageLoss;
        let factor = min(factors * prepared.dielectricMsReflectionRatio, 1.0 / abs(evaluatedLight.z));
        reflection += prepared.dielectricMsReflectionScale * factor * INVPI;
      }
      result.specular += reflection * scale${layered ? ' * substrateScale' : ''};
    }
  }
${layered ? /* wgsl */ `  if (wantSpecular && prepared.weights[OPENPBR_LOBE_COAT] > 0.0) {
    result.coat = mtCoatReflectance(prepared, count / 2u);
  }
` : ''}  return result;
}
fn mtFrameReflectance(prepared: OpenPbrPreparedBsdf) -> MtReflectance {
  return mtFrameReflectanceComponents(prepared, true, true);
}
`;
}

export default createAovReflectanceWgsl();
