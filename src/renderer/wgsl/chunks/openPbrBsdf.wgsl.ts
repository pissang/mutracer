/*
 * OpenPBR energy-compensation, EON and thin-film portions Copyright 2026 Adobe.
 * Licensed under the Apache License, Version 2.0.
 * https://www.apache.org/licenses/LICENSE-2.0
 */

/*
 * Renderer-specific OpenPBR layered BSDF.
 *
 * The prepare/eval/sample/pdf organization and fixed-lobe composition follow:
 * - https://github.com/adobe/openpbr-bsdf
 * - https://github.com/portsmouth/OpenPBR-viewer
 *
 * This compact GPU implementation reuses the renderer's GGX VNDF and volume
 * integrator. Adobe's opaque-dielectric energy tables are used for the base
 * rough-diffuse/specular coupling; fuzz still uses an analytic approximation.
 */

import { OPENPBR_METAL_ENERGY_LUT_ROW, OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW, OPENPBR_DIELECTRIC_ENERGY_LUT_ROW, OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW, OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW } from '../../openPbrEnergyLut.js';
import type {MaterialShaderHooks} from '../materialShaderHooks.js';
const LOBE_INDICES = [0, 1, 2, 3, 4, 5, 6];

export function createOpenPbrBsdfWgsl(hasAnisotropyDirections = true, hasCoatNormals = false, materialHooks: MaterialShaderHooks = {}) {
  // Preserve the existing member position: bit 0 is texture/rotation; bit 1 is MaterialX.
  const directionFlags = !!(materialHooks.graph || materialHooks.materialXNormals);
  return /* wgsl */ `
const OPENPBR_LOBE_FUZZ: i32 = 0;
const OPENPBR_LOBE_COAT: i32 = 1;
const OPENPBR_LOBE_METAL: i32 = 2;
const OPENPBR_LOBE_SPECULAR: i32 = 3;
const OPENPBR_LOBE_TRANSMISSION: i32 = 4;
const OPENPBR_LOBE_DIFFUSE: i32 = 5;
const OPENPBR_LOBE_SUBSURFACE: i32 = 6;
const OPENPBR_LOBE_COUNT: i32 = ${LOBE_INDICES.length};

// Eager boolean operators below combine pure scalar predicates. This avoids
// multiplying short-circuit control flow when DXC inlines the layered BSDF.

struct OpenPbrBasis {
    tangent: vec3f,
    bitangent: vec3f,
    normal: vec3f,
};

struct OpenPbrPreparedBsdf {
    material: OpenPbrResolvedMaterial,
    basis: OpenPbrBasis,
${hasAnisotropyDirections ? /* wgsl */ `
    coatBasis: OpenPbrBasis,
    directionFrames: bool,
` : /* wgsl */ ``}
${hasCoatNormals ? /* wgsl */ `    coatViewLocal: vec3f,` : ''}
    viewLocal: vec3f,
    diffuseColor: vec3f,
    specularEtaTOverEtaI: f32,
    refractionEtaTOverEtaI: f32,
    transmissionReflectionIor: f32,
    thinFilmExteriorIor: f32,
    thinFilmBaseIor: f32,
    specularAlpha: f32,
    diffuseSpecularEnergyCompensation: f32,
    coatBaseScale: vec3f,
    metalMsScale: vec3f,
    metalMsFactor: f32,
    metalMsProbability: f32,

    dielectricMsReflectionScale: vec3f,
    dielectricMsTransmissionScale: vec3f,
    dielectricMsViewLoss: f32,
    dielectricMsReflectionRatio: f32,
    dielectricMsProbability: f32,

    weights: array<f32, OPENPBR_LOBE_COUNT>,
    probabilities: array<f32, OPENPBR_LOBE_COUNT>,
};

fn openpbr_luminance(color: vec3f) -> f32 {
    return dot(color, vec3f(0.212671, 0.715160, 0.072169));
}

fn openpbr_f0_from_ior(etaTOverEtaI: f32) -> f32 {
    let value = (etaTOverEtaI - 1.0) / (etaTOverEtaI + 1.0);
    return value * value;
}

fn openpbr_apply_specular_weight_to_ior(
    etaTOverEtaI: f32,
    specularWeight: f32
) -> f32 {
    let scaledF0 = min(
        openpbr_f0_from_ior(etaTOverEtaI) * specularWeight,
        0.9999
    );
    let sqrtF0 = sqrt(scaledF0);
    let externalIor = (1.0 + sqrtF0) / (1.0 - sqrtF0);
    return select(externalIor, 1.0 / externalIor, etaTOverEtaI < 1.0);
}

fn openpbr_dielectric_fresnel(cosTheta: f32, relativeIor: f32) -> f32 {
    if (abs(relativeIor - 1.0) < 1e-6) {
        return 0.0;
    }
    return sampling_dielectric_fresnel(cosTheta, relativeIor);
}

fn openpbr_energy_ior_index(ior: f32) -> f32 {
    if (ior < 1.0) {
        return 15.0 - ((1.0 / ior - 1.0) / 1.5) * 15.0;
    }
    return 16.0 + ((ior - 1.0) / 1.5) * 15.0;
}

fn openpbr_energy_fetch(cosIndex: i32, row: i32) -> f32 {
    return textureLoad(openPbrEnergyLut, vec2i(cosIndex, row), 0).r;
}

fn openpbr_energy_trilinear(
    exactIor: f32,
    exactAlpha: f32,
    exactCosine: f32
) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let cosineIndex = clamp(exactCosine, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let cosine0 = i32(floor(cosineIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let cosine1 = min(cosine0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let cosineMix = cosineIndex - f32(cosine0);

    let v000 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha0);
    let v001 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha0);
    let v010 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha1);
    let v011 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha1);
    let v100 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha0);
    let v101 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha0);
    let v110 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha1);
    let v111 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha1);
    let v00 = mix(v000, v100, iorMix);
    let v01 = mix(v001, v101, iorMix);
    let v10 = mix(v010, v110, iorMix);
    let v11 = mix(v011, v111, iorMix);
    return mix(
        mix(v00, v10, alphaMix),
        mix(v01, v11, alphaMix),
        cosineMix
    );
}

fn openpbr_energy_bilinear(exactIor: f32, exactAlpha: f32) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let v00 = openpbr_energy_fetch(alpha0, 1024 + ior0);
    let v01 = openpbr_energy_fetch(alpha1, 1024 + ior0);
    let v10 = openpbr_energy_fetch(alpha0, 1024 + ior1);
    let v11 = openpbr_energy_fetch(alpha1, 1024 + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

// Adobe c91aad1 ideal dielectric tables clamp IOR indices; unlike opaque
// dielectric data they do not extrapolate outside [0.4, 2.5].
fn openpbr_ideal_energy_trilinear(
    exactIor: f32,
    exactAlpha: f32,
    exactCosine: f32
) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let cosineIndex = clamp(exactCosine, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let cosine0 = i32(floor(cosineIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let cosine1 = min(cosine0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let cosineMix = cosineIndex - f32(cosine0);

    let v000 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha0);
    let v001 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha0);
    let v010 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha1);
    let v011 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha1);
    let v100 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha0);
    let v101 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha0);
    let v110 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha1);
    let v111 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha1);
    let v00 = mix(v000, v100, iorMix);
    let v01 = mix(v001, v101, iorMix);
    let v10 = mix(v010, v110, iorMix);
    let v11 = mix(v011, v111, iorMix);
    return mix(
        mix(v00, v10, alphaMix),
        mix(v01, v11, alphaMix),
        cosineMix
    );
}

fn openpbr_ideal_average_bilinear(exactIor: f32, exactAlpha: f32) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let v00 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior0);
    let v01 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior0);
    let v10 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior1);
    let v11 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

fn openpbr_ideal_ratio_bilinear(exactIor: f32, exactAlpha: f32) -> f32 {
    let iorIndex = clamp(exactIor, 0.0, 31.0);
    let alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    let ior0 = i32(floor(iorIndex));
    let alpha0 = i32(floor(alphaIndex));
    let ior1 = min(ior0 + 1, 31);
    let alpha1 = min(alpha0 + 1, 31);
    let iorMix = iorIndex - f32(ior0);
    let alphaMix = alphaIndex - f32(alpha0);
    let v00 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior0);
    let v01 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior0);
    let v10 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior1);
    let v11 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

fn openpbr_ideal_dielectric_loss(ior: f32, alpha: f32, cosine: f32) -> f32 {
    return openpbr_ideal_energy_trilinear(openpbr_energy_ior_index(ior), sqrt(alpha) * 31.0, cosine * 31.0);
}
fn openpbr_ideal_dielectric_average_loss(ior: f32, alpha: f32) -> f32 {
    return openpbr_ideal_average_bilinear(openpbr_energy_ior_index(ior), sqrt(alpha) * 31.0);
}
fn openpbr_ideal_dielectric_reflection_ratio(ior: f32, alpha: f32) -> f32 {
    return openpbr_ideal_ratio_bilinear(openpbr_energy_ior_index(ior), sqrt(alpha) * 31.0);
}

// Adobe openpbr_microfacet_multiple_scattering_{data,lobes}.h (c91aad1):
// ideal-metal loss E=1-singleScatterEnergy, indexed by sqrt(alpha) and cosine.
fn openpbr_metal_energy_complement(alpha: f32, cosine: f32) -> f32 {
    let roughnessIndex = clamp(sqrt(alpha) * 31.0, 0.0, 31.0);
    let cosineIndex = clamp(cosine * 31.0, 0.0, 31.0);
    let r0 = i32(floor(roughnessIndex));
    let c0 = i32(floor(cosineIndex));
    let r1 = min(r0 + 1, 31);
    let c1 = min(c0 + 1, 31);
    return mix(
        mix(openpbr_energy_fetch(c0, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r0), openpbr_energy_fetch(c1, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r0), fract(cosineIndex)),
        mix(openpbr_energy_fetch(c0, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r1), openpbr_energy_fetch(c1, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r1), fract(cosineIndex)),
        fract(roughnessIndex));
}

fn openpbr_metal_average_energy_complement(alpha: f32) -> f32 {
    let index = clamp(sqrt(alpha) * 31.0, 0.0, 31.0);
    let i0 = i32(floor(index));
    return mix(openpbr_energy_fetch(i0, ${OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW}),
        openpbr_energy_fetch(min(i0 + 1, 31), ${OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW}), fract(index));
}

fn openpbr_extrapolate_energy_complement(value: f32, ior: f32) -> f32 {
    if ((ior > 2.5) | (ior < 0.4)) {
        let maxF0 = openpbr_f0_from_ior(2.5);
        let progress = (openpbr_f0_from_ior(ior) - maxF0) / (1.0 - maxF0);
        return (1.0 - progress) * value;
    }
    return value;
}

fn openpbr_opaque_energy_complement(
    ior: f32,
    alpha: f32,
    cosine: f32
) -> f32 {
    let value = openpbr_energy_trilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0,
        cosine * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

fn openpbr_opaque_average_energy_complement(ior: f32, alpha: f32) -> f32 {
    let value = openpbr_energy_bilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

fn openpbr_to_world(basis: OpenPbrBasis, direction: vec3f) -> vec3f {
    return direction.x * basis.tangent
        + direction.y * basis.bitangent
        + direction.z * basis.normal;
}

fn openpbr_to_local(basis: OpenPbrBasis, direction: vec3f) -> vec3f {
    return vec3f(
        dot(direction, basis.tangent),
        dot(direction, basis.bitangent),
        dot(direction, basis.normal)
    );
}

fn openpbr_make_basis(
    inputTangent: vec3f,
    normal: vec3f,
    anisotropy: f32
) -> OpenPbrBasis {
    var basis: OpenPbrBasis;
    basis.normal = normal;
    var tangent = inputTangent;
    var bitangent = vec3f(0.0);
    if ((dot(tangent, tangent) < 0.001) | (anisotropy <= 0.0)) {
        sampling_orthonormal_basis(normal, &tangent, &bitangent);
    }
    else {
        bitangent = normalize(cross(normal, tangent));
        tangent = normalize(cross(bitangent, normal));
    }
    basis.tangent = tangent;
    basis.bitangent = bitangent;
    return basis;
}

fn openpbr_fresnel_s(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return (incidentIor * incidentCosine - transmittedIor * transmittedCosine)
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

fn openpbr_fresnel_p(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return (transmittedIor * incidentCosine - incidentIor * transmittedCosine)
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

fn openpbr_transmission_s(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

fn openpbr_transmission_p(
    incidentIor: f32,
    transmittedIor: f32,
    incidentCosine: f32,
    transmittedCosine: f32
) -> f32 {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

fn openpbr_complex_multiply(a: vec2f, b: vec2f) -> vec2f {
    return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn openpbr_complex_divide(a: vec2f, b: vec2f) -> vec2f {
    let denominator = max(dot(b, b), 1e-9);
    return vec2f(
        (a.x * b.x + a.y * b.y) / denominator,
        (a.y * b.x - a.x * b.y) / denominator
    );
}

fn openpbr_complex_sqrt(value: vec2f) -> vec2f {
    let magnitude = length(value);
    let realPart = sqrt(max(0.0, 0.5 * (magnitude + value.x)));
    let imaginaryMagnitude = sqrt(max(0.0, 0.5 * (magnitude - value.x)));
    return vec2f(realPart, select(-imaginaryMagnitude, imaginaryMagnitude, value.y >= 0.0));
}

fn openpbr_complex_fresnel_reflection(
    incidentCosine: f32,
    incidentIor: f32,
    transmittedIor: vec2f,
    pPolarized: bool
) -> vec2f {
    let incidentSine = sqrt(max(0.0, 1.0 - incidentCosine * incidentCosine));
    let iorRatio = openpbr_complex_divide(vec2f(incidentIor, 0.0), transmittedIor);
    let transmittedSine = iorRatio * incidentSine;
    var transmittedCosine = openpbr_complex_sqrt(
        vec2f(1.0, 0.0) - openpbr_complex_multiply(transmittedSine, transmittedSine)
    );
    if (openpbr_complex_multiply(transmittedIor, transmittedCosine).y < 0.0) {
        transmittedCosine = -transmittedCosine;
    }

    let incidentIorCosine = vec2f(incidentIor * incidentCosine, 0.0);
    let transmittedIorCosine = openpbr_complex_multiply(transmittedIor, transmittedCosine);
    if (pPolarized) {
        let transmittedIorIncidentCosine = transmittedIor * incidentCosine;
        let incidentIorTransmittedCosine = transmittedCosine * incidentIor;
        return openpbr_complex_divide(
            transmittedIorIncidentCosine - incidentIorTransmittedCosine,
            transmittedIorIncidentCosine + incidentIorTransmittedCosine
        );
    }
    return openpbr_complex_divide(
        incidentIorCosine - transmittedIorCosine,
        incidentIorCosine + transmittedIorCosine
    );
}

fn openpbr_airy_reflectance(
    reflection12: f32,
    transmission12: f32,
    reflection21: f32,
    transmission21: f32,
    reflection23: vec2f,
    phase: f32
) -> f32 {
    let phaseRotation = vec2f(cos(phase), sin(phase));
    let reflectedPhase = openpbr_complex_multiply(reflection23, phaseRotation);
    let numerator = reflectedPhase * (transmission12 * transmission21);
    let denominator = vec2f(1.0, 0.0) - reflectedPhase * reflection21;
    let totalReflection = vec2f(reflection12, 0.0)
        + openpbr_complex_divide(numerator, denominator);
    return dot(totalReflection, totalReflection);
}

fn openpbr_thin_film_reflectance_channel(
    incidentCosine: f32,
    wavelength: f32,
    thickness: f32,
    exteriorIor: f32,
    filmIor: f32,
    substrateIor: vec2f
) -> f32 {
    let safeIncidentCosine = clamp(abs(incidentCosine), 1e-5, 1.0);
    let filmSineSquared = pow(exteriorIor / filmIor, 2.0)
        * (1.0 - safeIncidentCosine * safeIncidentCosine);
    if (filmSineSquared >= 1.0) {
        return 1.0;
    }
    let filmCosine = sqrt(1.0 - filmSineSquared);
    let reflection12S = openpbr_fresnel_s(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let reflection12P = openpbr_fresnel_p(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let transmission12S = openpbr_transmission_s(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let transmission12P = openpbr_transmission_p(
        exteriorIor, filmIor, safeIncidentCosine, filmCosine
    );
    let transmission21Scale = filmIor * filmCosine
        / max(exteriorIor * safeIncidentCosine, 1e-9);
    let phase = 2.0 * PI * (2.0 * filmIor * thickness * filmCosine) / wavelength;
    var reflectance = 0.0;
    // Both polarizations share Snell's complex solve and the Airy graph.
    for (var polarization = 0u; polarization < (rtUniform.loopUnrollGuard >> 1u); polarization++) {
        let reflection12 = select(reflection12S, reflection12P, polarization == 1u);
        let transmission12 = select(transmission12S, transmission12P, polarization == 1u);
        let reflection23 = openpbr_complex_fresnel_reflection(
            filmCosine, filmIor, substrateIor, polarization == 1u);
        reflectance += openpbr_airy_reflectance(reflection12, transmission12,
            -reflection12, transmission12 * transmission21Scale, reflection23, phase);
    }
    return clamp(0.5 * reflectance, 0.0, 1.0);
}


// OpenPBR 1.1.1 Metal: analytic F82-tint correction to Schlick.
// Saturation follows Adobe impl/openpbr_lobe_utils.h, openpbr_metal_schlick_with_f82_tint.
fn openpbr_metal_fresnel(cosine: f32, f0: vec3f, tint: vec3f) -> vec3f {
    let schlick = mix(f0, vec3f(1.0), sampling_schlick_fifth_power(cosine));
    if (all(tint == vec3f(1.0))) { return schlick; }
    let edgeCosine = 1.0 / 7.0;
    let edgeComplement = 1.0 - edgeCosine;
    let edgeFresnel = mix(f0, vec3f(1.0), sampling_schlick_fifth_power(edgeCosine));
    let complement = 1.0 - cosine;
    let correction = cosine * sampling_schlick_fifth_power(cosine) * complement
        / (edgeCosine * pow(edgeComplement, 6.0));
    return clamp(schlick - correction * (edgeFresnel - tint * edgeFresnel), vec3f(0.0), vec3f(1.0));
}

fn openpbr_metal_complex_ior(f0: f32, f82Tint: f32) -> vec2f {
    let reflectivity = clamp(f0, 0.0, 0.99);
    let sqrtReflectivity = sqrt(reflectivity);
    let minimumIor = (1.0 - reflectivity) / (1.0 + reflectivity);
    let maximumIor = (1.0 + sqrtReflectivity) / max(1.0 - sqrtReflectivity, 1e-9);
    let ior = mix(maximumIor, minimumIor, clamp(f82Tint, 0.0, 1.0));
    let extinctionSquared = (
        (ior + 1.0) * (ior + 1.0) * reflectivity
        - (ior - 1.0) * (ior - 1.0)
    ) / max(1.0 - reflectivity, 1e-9);
    return vec2f(ior, sqrt(max(extinctionSquared, 0.0)));
}


fn openpbr_thin_film_presence(thickness: f32, weight: f32) -> f32 {
    return clamp(weight, 0.0, 1.0) * smoothstep(1e-9, 30.0, thickness);
}



fn openpbr_eval_diffuse(
    material: OpenPbrResolvedMaterial,
    color: vec3f,
    viewLocal: vec3f,
    lightLocal: vec3f,
    specularEnergyCompensation: f32,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3f(0.0);
    }

    let roughness = material.diffuseRoughness;
    let fonConstantA = 0.5 - 2.0 / (3.0 * PI);
    let fonConstantB = 2.0 / 3.0 - 28.0 / (15.0 * PI);
    let muInput = lightLocal.z;
    let muOutput = viewLocal.z;
    let directional = dot(lightLocal, viewLocal) - muInput * muOutput;
    let directionalOverTangent = select(
        directional,
        directional / max(max(muInput, muOutput), 1e-7),
        directional > 0.0
    );
    let singleScatterA = 1.0 / (1.0 + fonConstantA * roughness);
    let singleScatter = color * INVPI * singleScatterA
        * (1.0 + roughness * directionalOverTangent);

    let inputComplement = 1.0 - muInput;
    let outputComplement = 1.0 - muOutput;
    let inputGOverPi = inputComplement * (
        0.0571085289 + inputComplement * (
            0.491881867 + inputComplement * (
                -0.332181442 + inputComplement * 0.0714429953
            )
        )
    );
    let outputGOverPi = outputComplement * (
        0.0571085289 + outputComplement * (
            0.491881867 + outputComplement * (
                -0.332181442 + outputComplement * 0.0714429953
            )
        )
    );
    let inputAlbedo = (1.0 + roughness * inputGOverPi)
        / (1.0 + fonConstantA * roughness);
    let outputAlbedo = (1.0 + roughness * outputGOverPi)
        / (1.0 + fonConstantA * roughness);
    let averageAlbedo = singleScatterA * (1.0 + fonConstantB * roughness);
    let multipleScatterAlbedo = color * color * averageAlbedo
        / max(vec3f(1e-7), vec3f(1.0) - color * (1.0 - averageAlbedo));
    let multipleScatter = multipleScatterAlbedo * INVPI
        * max(1e-7, 1.0 - outputAlbedo)
        * max(1e-7, 1.0 - inputAlbedo)
        / max(1e-7, 1.0 - averageAlbedo);
    *pdf = lightLocal.z * INVPI;
    return (singleScatter + multipleScatter) * specularEnergyCompensation;
}

fn openpbr_fuzz_directional_albedo(viewCosine: f32, roughness: f32) -> f32 {
    let x = clamp(viewCosine, 0.0, 1.0);
    let y = clamp(roughness, 0.01, 1.0);
    let scale = y * (0.0206607 + 1.58491 * y)
        / (0.0379424 + y * (1.32227 + y));
    let mean = y * (-0.193854 + y * (-1.14885 + y * (1.7932 - 0.95943 * y * y)))
        / (0.046391 + y);
    let offset = y * (0.000654023 + (-0.0207818 + 0.119681 * y) * y)
        / (1.26264 + y * (-1.92021 + y));
    let gaussian = exp(-0.5 * pow((x - mean) / scale, 2.0))
        / (scale * sqrt(2.0 * PI));
    return max(gaussian + offset, 0.0);
}

fn openpbr_eval_fuzz(
    material: OpenPbrResolvedMaterial,
    viewLocal: vec3f,
    lightLocal: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if ((viewLocal.z <= 0.0) | (lightLocal.z <= 0.0)) {
        return vec3f(0.0);
    }
    let albedo = openpbr_fuzz_directional_albedo(
        viewLocal.z,
        material.fuzzRoughness
    );
    *pdf = lightLocal.z * INVPI;
    return material.fuzzColor * albedo * INVPI;
}

fn openpbr_eval_microfacet_reflection(
    material: OpenPbrResolvedMaterial,
    viewLocal: vec3f,
    lightLocal: vec3f,
    halfVector: vec3f,
    fresnel: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3f(0.0);
    }

    let alpha = vec2f(material.alphaX, material.alphaY);
    let distribution = sampling_ggx_ndf(halfVector, alpha);
    let masking = sampling_ggx_smith_g1(viewLocal, alpha);
    let maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);

    *pdf = masking * distribution / (4.0 * max(viewLocal.z, 1e-8));
    return fresnel * distribution * maskingShadowing
        / (4.0 * max(lightLocal.z * viewLocal.z, 1e-8));
}

fn openpbr_eval_microfacet_refraction(
    material: OpenPbrResolvedMaterial,
    relativeIor: f32,
    tint: vec3f,
    viewLocal: vec3f,
    lightLocal: vec3f,
    halfVector: vec3f,
    fresnel: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if (lightLocal.z >= 0.0) {
        return vec3f(0.0);
    }

    let lightHalf = dot(lightLocal, halfVector);
    let viewHalf = dot(viewLocal, halfVector);
    // A refracting microfacet must face the view and the opposite side of the
    // light. Backfacing configurations have no support in the VNDF proposal.
    if ((viewHalf <= 0.0) | (lightHalf >= 0.0)) {
        return vec3f(0.0);
    }
    let alpha = vec2f(material.alphaX, material.alphaY);
    let distribution = sampling_ggx_ndf(halfVector, alpha);
    let masking = sampling_ggx_smith_g1(viewLocal, alpha);
    let maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);
    var denominator = lightHalf + viewHalf * relativeIor;
    denominator *= denominator;
    let jacobian = abs(lightHalf) / max(denominator, 1e-8);
    let relativeIorSquared = relativeIor * relativeIor;

    *pdf = masking * max(0.0, viewHalf) * distribution * jacobian
        / max(viewLocal.z, 1e-8);
    return tint * (vec3f(1.0) - fresnel) * distribution * maskingShadowing
        * abs(viewHalf) * jacobian * relativeIorSquared
        / max(abs(lightLocal.z * viewLocal.z), 1e-8);
}

fn openpbr_transmission_tint(material: OpenPbrResolvedMaterial) -> vec3f {
    if (HAS_MEDIUM & (material.mediumType > 0)) {
        return vec3f(1.0);
    }
    return material.transmissionColor;
}

fn openpbr_thin_wall_fresnel(singleInterfaceFresnel: f32) -> f32 {
    return 2.0 * singleInterfaceFresnel / (1.0 + singleInterfaceFresnel);
}

fn openpbr_thin_wall_reflection_coefficient(
    singleInterfaceFresnel: vec3f,
    transmissionWeight: f32
) -> vec3f {
    let windowFresnel = 2.0 * singleInterfaceFresnel
        / (vec3f(1.0) + singleInterfaceFresnel);
    return mix(
        singleInterfaceFresnel,
        windowFresnel,
        clamp(transmissionWeight, 0.0, 1.0)
    );
}

fn openpbr_final_transmission_tint(
    material: OpenPbrResolvedMaterial,
    incidentCosine: f32,
    etaTOverEtaI: f32
) -> vec3f {
    let tint = openpbr_transmission_tint(material);
    if (!material.thinWalled) {
        return tint;
    }
    let incidentSineSquared = max(0.0, 1.0 - incidentCosine * incidentCosine);
    let transmittedSineSquared = incidentSineSquared
        / max(etaTOverEtaI * etaTOverEtaI, 1e-9);
    if (transmittedSineSquared >= 1.0) {
        return vec3f(0.0);
    }
    let transmittedCosine = sqrt(1.0 - transmittedSineSquared);
    return pow(max(tint, vec3f(0.0)), vec3f(1.0 / max(transmittedCosine, 1e-5)));
}

fn openpbr_eval_subsurface_boundary(
    material: OpenPbrResolvedMaterial,
    viewLocal: vec3f,
    lightLocal: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    *pdf = 0.0;
    if ((viewLocal.z <= 0.0) | (lightLocal.z >= 0.0)) {
        return vec3f(0.0);
    }
    let transmittedCosine = -lightLocal.z;
    let entryFresnel = sampling_dielectric_fresnel(
        viewLocal.z,
        material.relativeIor
    );
    *pdf = transmittedCosine * INVPI;
    return vec3f(1.0 - entryFresnel) * INVPI;
}

fn openpbr_normalize_probabilities(prepared: ptr<function, OpenPbrPreparedBsdf>) {
    // Keep the loops dynamically bounded: explicit unrolling regresses Metal
    // rendering performance. The uniform guard is four, covering all lobes.
    let lobeCount = min(OPENPBR_LOBE_COUNT, i32(rtUniform.loopUnrollGuard * 2u));
    var total = (*prepared).probabilities[OPENPBR_LOBE_FUZZ];
    for (var lobe = 1; lobe < lobeCount; lobe++) {
        total += (*prepared).probabilities[lobe];
    }
    if (total <= 1e-8) {
        for (var lobe = 0; lobe < lobeCount; lobe++) {
            (*prepared).probabilities[lobe] = 0.0;
        }
        return;
    }
    let inverseTotal = 1.0 / total;
    for (var lobe = 0; lobe < lobeCount; lobe++) {
        (*prepared).probabilities[lobe] *= inverseTotal;
    }
}

// Adapted from Adobe c91aad1 impl/openpbr_lobe_utils.h and
// impl/openpbr_bsdf.h::openpbr_prepare_lobes (Apache-2.0).
fn openpbr_average_fresnel(eta: f32) -> f32 {
    if (abs(eta - 1.0) < 1e-6) { return 0.0; }
    if (eta > 1.0) { return (eta - 1.0) / (4.08567 + 1.00071 * eta); }
    return 0.997118 + 0.1014 * eta - 0.965241 * eta * eta - 0.130607 * eta * eta * eta;
}

fn openpbr_metal_average_fresnel(f0: vec3f, tint: vec3f) -> vec3f {
    let edgeCosine = 1.0 / 7.0;
    let edgeFresnel = mix(f0, vec3f(1.0), sampling_schlick_fifth_power(edgeCosine));
    let b = edgeFresnel * (vec3f(1.0) - tint) / (edgeCosine * pow(1.0 - edgeCosine, 6.0));
    return clamp(f0 + (vec3f(1.0) - f0) / 21.0 - b / 126.0, vec3f(0.0), vec3f(1.0));
}

// Adobe openpbr_coating_lobe.h: one passage, using the refracted cosine.
// Partial coverage is mixed separately for each passage, as in the reference.
fn openpbr_coat_passage(material: OpenPbrResolvedMaterial, cosine: f32) -> vec3f {
    if (cosine <= 0.0) { return vec3f(1.0); }
    let refractedCosine = sqrt(max(0.0, 1.0 - (1.0 - cosine * cosine) / (material.coatIor * material.coatIor)));
    let passage = pow(max(material.coatColor, vec3f(0.0)), vec3f(0.5 / max(refractedCosine, 1e-5)));
    return mix(vec3f(1.0), passage, material.coatWeight);
}

fn openpbr_coat_energy(material: OpenPbrResolvedMaterial, cosine: f32) -> f32 {
    if (material.coatRoughness <= ROUGHNESS_MIN) {
        return openpbr_dielectric_fresnel(cosine, 1.0 / material.coatIor);
    }
    // The opaque-dielectric table is the complement of coat directional albedo.
    // Adobe uses the original isotropic alpha (r^2) even for anisotropic GGX.
    return clamp(1.0 - openpbr_opaque_energy_complement(material.coatIor,
        material.coatRoughness * material.coatRoughness, cosine), 0.0, 1.0);
}

fn openpbr_coat_darkening(prepared: OpenPbrPreparedBsdf) -> vec3f {
    let material = prepared.material;
    let dielectric = 1.0 - material.baseMetalness;
    let opaque = dielectric * (1.0 - material.transmissionWeight) * (1.0 - material.subsurfaceWeight);
    let sss = dielectric * (1.0 - material.transmissionWeight) * material.subsurfaceWeight;
    let trans = dielectric * material.transmissionWeight;
    let opaqueSpecularity = openpbr_average_fresnel(prepared.specularEtaTOverEtaI);
    let transSpecularity = openpbr_average_fresnel(1.0 / prepared.transmissionReflectionIor);
    let specularity = clamp(opaque * opaqueSpecularity + (sss + trans) * transSpecularity + material.baseMetalness, 0.0, 1.0);
    let effectiveRoughness = mix(1.0, material.specularRoughness, specularity);
    let ks = openpbr_average_fresnel(material.coatIor);
    let kr = 1.0 - (1.0 - ks) / (material.coatIor * material.coatIor);
    let k = mix(ks, kr, effectiveRoughness);
    let eb = material.baseMetalness * material.specularWeight * openpbr_metal_average_fresnel(material.baseWeight * material.baseColor, material.specularColor)
        + opaque * mix(material.baseWeight * material.baseColor, vec3f(1.0), opaqueSpecularity)
        + sss * material.subsurfaceColor + vec3f(trans);
    let delta = vec3f(1.0 - k) / max(vec3f(1.0) - eb * k, vec3f(1e-6));
    return mix(vec3f(1.0), delta, material.coatWeight * material.coatDarkening);
}

fn openpbr_coat_base_scale(prepared: OpenPbrPreparedBsdf, lightCosine: f32) -> vec3f {
    if (prepared.material.coatWeight <= 0.0) { return vec3f(1.0); }
    if (prepared.material.inside) {
        // Inside only outgoing transmission crosses the coat; no coat reflection.
        return openpbr_coat_passage(prepared.material, -lightCosine);
    }
    // Default reference mode applies energy partition on the view side only.
    return prepared.coatBaseScale * openpbr_coat_passage(prepared.material, lightCosine);
}


${hasAnisotropyDirections ? /* wgsl */ `
fn openpbr_direction_basis(fallback: OpenPbrBasis, tangent: vec3f, bitangent: vec3f, direction: vec2f) -> OpenPbrBasis {
    var t = tangent - fallback.normal * dot(fallback.normal, tangent);
    if (dot(t, t) < 1e-8) { t = fallback.tangent; }
    t = normalize(t);
    let b = cross(fallback.normal, t) * select(1.0, -1.0, dot(cross(fallback.normal, t), bitangent) < 0.0);
    t = t * direction.x + b * direction.y;
    if (dot(t, t) < 1e-8) { return fallback; }
    var basis = fallback;
    basis.tangent = normalize(t);
    basis.bitangent = normalize(cross(basis.normal, basis.tangent));
    basis.tangent = normalize(cross(basis.bitangent, basis.normal));
    return basis;
}

` : /* wgsl */ ``}
fn openpbr_prepare(
    tangent: vec3f,
    material: OpenPbrResolvedMaterial,
    viewDirection: vec3f,
    normal: vec3f
) -> OpenPbrPreparedBsdf {
    var prepared: OpenPbrPreparedBsdf;
    prepared.material = material;
    prepared.basis = openpbr_make_basis(
        tangent,
        normal,
        max(material.specularAnisotropy, material.coatAnisotropy)
    );
${hasAnisotropyDirections ? /* wgsl */ `
    ${directionFlags ? `    if((material.anisotropyDirectionEnabled & 2u) != 0u && max(material.specularAnisotropy,material.coatAnisotropy)>0.0) {
      prepared.basis = openpbr_direction_basis(prepared.basis, material.geometryTangent, material.geometryBitangent, vec2f(1.0,0.0));
    }
` : ''}prepared.coatBasis = prepared.basis;
    prepared.directionFrames = false;
${hasCoatNormals ? /* wgsl */ `
    // Adobe c91aad1 openpbr_prepare_lobes: geometry_coat_basis is independent
    // of the base shading basis; coat passage uses the same coat cosine.
    if (material.coatNormalEnabled) {
        prepared.coatBasis = openpbr_make_basis(material.geometryTangent, material.coatNormal, material.coatAnisotropy);
        prepared.directionFrames = true;
    }
` : ''}
    if ((material.specularAnisotropy > 0.0) & ${directionFlags ? "((material.anisotropyDirectionEnabled & 1u) != 0u)" : "material.anisotropyDirectionEnabled"}) {
        prepared.basis = openpbr_direction_basis(prepared.basis, material.directionTangent, material.directionBitangent, material.anisotropyDirection);
        prepared.directionFrames = true;
    }
    if ((material.coatAnisotropy > 0.0) & (material.coatAnisotropyRotation != 0.0)) {
        prepared.coatBasis = openpbr_direction_basis(prepared.coatBasis, material.geometryTangent, material.geometryBitangent, vec2f(cos(material.coatAnisotropyRotation), sin(material.coatAnisotropyRotation)));
        prepared.directionFrames = true;
    }
` : /* wgsl */ ``}
    prepared.viewLocal = openpbr_to_local(prepared.basis, viewDirection);
${hasCoatNormals ? /* wgsl */ `    prepared.coatViewLocal = openpbr_to_local(prepared.coatBasis, viewDirection);` : ''}
    prepared.diffuseColor = material.baseColor;

    let dielectricBaseWeight = 1.0 - material.baseMetalness;
    let opaqueDielectricWeight = dielectricBaseWeight
        * (1.0 - material.transmissionWeight);
    prepared.weights[OPENPBR_LOBE_FUZZ] = material.fuzzWeight;
    prepared.weights[OPENPBR_LOBE_COAT] = material.coatWeight;
    if (material.inside) { prepared.weights[OPENPBR_LOBE_COAT] = 0.0; }
    prepared.weights[OPENPBR_LOBE_METAL] = material.baseMetalness;
    prepared.weights[OPENPBR_LOBE_SPECULAR] = dielectricBaseWeight;
    prepared.weights[OPENPBR_LOBE_TRANSMISSION] = dielectricBaseWeight
        * material.transmissionWeight;
    prepared.weights[OPENPBR_LOBE_DIFFUSE] = opaqueDielectricWeight
        * (1.0 - material.subsurfaceWeight) * material.baseWeight;
    prepared.weights[OPENPBR_LOBE_SUBSURFACE] = opaqueDielectricWeight
        * material.subsurfaceWeight;

    prepared.specularEtaTOverEtaI = openpbr_apply_specular_weight_to_ior(
        1.0 / material.relativeIor,
        material.specularWeight
    );
    prepared.material.relativeIor = 1.0 / prepared.specularEtaTOverEtaI;
    prepared.refractionEtaTOverEtaI = prepared.specularEtaTOverEtaI;
    prepared.transmissionReflectionIor = prepared.material.relativeIor;
    // Adobe openpbr_bsdf.h::openpbr_prepare_lobes: reflect relative to
    // the weighted coat, refract relative to ambient air. Inside ignores coat.
    if (material.coatWeight > 0.0) {
        var weightedCoatIor = 1.0;
        if (!material.inside) { weightedCoatIor = mix(1.0, material.coatIor, material.coatWeight); }
        let weightedBaseIor = weightedCoatIor * openpbr_apply_specular_weight_to_ior(
            material.specularIor / weightedCoatIor, material.specularWeight);
        var reflectionEta = weightedBaseIor / weightedCoatIor;
        if ((weightedCoatIor > weightedBaseIor) & (weightedBaseIor >= 1.0)) {
            reflectionEta = 1.0 / reflectionEta;
        }
        prepared.specularEtaTOverEtaI = reflectionEta;
        prepared.transmissionReflectionIor = 1.0 / reflectionEta;
        prepared.refractionEtaTOverEtaI = weightedBaseIor;
        if (material.inside) {
            prepared.refractionEtaTOverEtaI = 1.0 / weightedBaseIor;
            prepared.transmissionReflectionIor = weightedBaseIor;
        }
        prepared.material.relativeIor = 1.0 / prepared.refractionEtaTOverEtaI;
    }

    // Adobe openpbr_bsdf.h::openpbr_prepare_lobes: absolute thin-film media.
    // Preserve the existing optical solve for uncoated materials.
    prepared.thinFilmExteriorIor = 1.0;
    prepared.thinFilmBaseIor = prepared.specularEtaTOverEtaI;
    if (material.coatWeight > 0.0) {
        if (material.inside) {
            prepared.thinFilmExteriorIor = 1.0 / prepared.refractionEtaTOverEtaI;
            prepared.thinFilmBaseIor = 1.0;
        }
        else {
            prepared.thinFilmExteriorIor = mix(1.0, material.coatIor, material.coatWeight);
            prepared.thinFilmBaseIor = prepared.refractionEtaTOverEtaI;
        }
    }
    prepared.specularAlpha = material.specularRoughness
        * material.specularRoughness;
    let viewCosine = abs(prepared.viewLocal.z);
    let singleInterfaceFresnel = openpbr_dielectric_fresnel(
        viewCosine,
        1.0 / prepared.specularEtaTOverEtaI
    );
    let dielectricFresnelEstimate = material.specularColor * select(
        singleInterfaceFresnel,
        mix(
            singleInterfaceFresnel,
            openpbr_thin_wall_fresnel(singleInterfaceFresnel),
            material.transmissionWeight
        ),
        material.thinWalled
    );
    let metalFresnelEstimate = material.specularWeight * openpbr_metal_fresnel(
        viewCosine,
        material.baseWeight * material.baseColor,
        material.specularColor
    );
    let transmissionFresnel = select(
        openpbr_dielectric_fresnel(viewCosine, prepared.transmissionReflectionIor),
        openpbr_thin_wall_fresnel(openpbr_dielectric_fresnel(viewCosine, prepared.transmissionReflectionIor)),
        material.thinWalled
    );
    let transmissionTint = openpbr_final_transmission_tint(
        material,
        viewCosine,
        prepared.refractionEtaTOverEtaI
    );
    let viewEnergyComplement = openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI,
        prepared.specularAlpha,
        viewCosine
    );
    let averageEnergyComplement = openpbr_opaque_average_energy_complement(
        prepared.specularEtaTOverEtaI,
        prepared.specularAlpha
    );
    prepared.diffuseSpecularEnergyCompensation = viewEnergyComplement
        / max(averageEnergyComplement, 1e-12);

    prepared.probabilities[OPENPBR_LOBE_FUZZ] = prepared.weights[OPENPBR_LOBE_FUZZ]
        * openpbr_luminance(material.fuzzColor)
        * max(openpbr_fuzz_directional_albedo(
            viewCosine,
            material.fuzzRoughness
        ), 0.02);
    prepared.probabilities[OPENPBR_LOBE_COAT] = 0.0;
    prepared.coatBaseScale = vec3f(1.0);
    if ((material.coatWeight > 0.0) & !material.inside) {
        ${hasCoatNormals ? /* wgsl */ `let coatViewCosine = select(viewCosine, max(prepared.coatViewLocal.z, 0.0), material.coatNormalEnabled);` : ''}
        let coatEnergy = openpbr_coat_energy(material, ${hasCoatNormals ? 'coatViewCosine' : 'viewCosine'});
        prepared.probabilities[OPENPBR_LOBE_COAT] = prepared.weights[OPENPBR_LOBE_COAT] * coatEnergy;
        prepared.coatBaseScale = openpbr_coat_passage(material, ${hasCoatNormals ? 'coatViewCosine' : 'viewCosine'})
            * (1.0 - prepared.weights[OPENPBR_LOBE_COAT] * coatEnergy) * openpbr_coat_darkening(prepared);
    }
    prepared.probabilities[OPENPBR_LOBE_METAL] = prepared.weights[OPENPBR_LOBE_METAL]
        * openpbr_luminance(metalFresnelEstimate);
    prepared.metalMsScale = vec3f(0.0);
    prepared.metalMsFactor = 0.0;
    prepared.metalMsProbability = 0.0;
    // Reference suppresses loss below roughness .04 and uses the original
    // isotropic alpha even when the single-scattering lobe is anisotropic.
    if ((material.specularRoughness >= 0.04) & (prepared.weights[OPENPBR_LOBE_METAL] > 0.0)) {
        let averageFresnel = openpbr_metal_average_fresnel(material.baseWeight * material.baseColor, material.specularColor);
        prepared.metalMsScale = material.specularWeight * averageFresnel * averageFresnel;
        let viewLoss = openpbr_metal_energy_complement(prepared.specularAlpha, viewCosine);
        prepared.metalMsFactor = viewLoss / max(openpbr_metal_average_energy_complement(prepared.specularAlpha), 1e-12);
        let msEstimate = prepared.weights[OPENPBR_LOBE_METAL] * openpbr_luminance(prepared.metalMsScale) * viewLoss;
        prepared.probabilities[OPENPBR_LOBE_METAL] += msEstimate;
        prepared.metalMsProbability = msEstimate / max(prepared.probabilities[OPENPBR_LOBE_METAL], 1e-12);
    }
    prepared.probabilities[OPENPBR_LOBE_SPECULAR] = prepared.weights[OPENPBR_LOBE_SPECULAR]
        * openpbr_luminance(dielectricFresnelEstimate);
    prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] = prepared.weights[OPENPBR_LOBE_TRANSMISSION]
        * (1.0 - transmissionFresnel)
        * openpbr_luminance(transmissionTint);
    // OpenPBR_DielectricMicrofacetMultipleScatteringLobe, Adobe c91aad1
    // (Apache-2.0). Use the refraction IOR even when coat reflection uses a
    // different ratio. Restrict this addition to solid transmissive materials;
    // opaque/subsurface-only and thin-wall paths retain their existing model.
    // Keep the renderer's exact null boundary discrete: upstream avoids eta=1
    // for refraction, and its tabulation has small nonzero loss there.
    prepared.dielectricMsReflectionScale = vec3f(0.0);
    prepared.dielectricMsTransmissionScale = vec3f(0.0);
    prepared.dielectricMsViewLoss = 0.0;
    prepared.dielectricMsReflectionRatio = 0.0;
    prepared.dielectricMsProbability = 0.0;
    if (!material.thinWalled & (material.transmissionWeight > 0.0) &
        (prepared.specularAlpha >= 0.0016) & (prepared.weights[OPENPBR_LOBE_TRANSMISSION] > 0.0) &
        (abs(prepared.refractionEtaTOverEtaI - 1.0) > 1e-6)) {
        let nonOpaqueWeight = prepared.weights[OPENPBR_LOBE_TRANSMISSION] + prepared.weights[OPENPBR_LOBE_SUBSURFACE];
        prepared.dielectricMsReflectionScale = select(material.specularColor, vec3f(1.0), material.inside) * nonOpaqueWeight;
        prepared.dielectricMsTransmissionScale = transmissionTint * prepared.weights[OPENPBR_LOBE_TRANSMISSION]
            + vec3f(prepared.weights[OPENPBR_LOBE_SUBSURFACE]);
        prepared.dielectricMsReflectionRatio = openpbr_ideal_dielectric_reflection_ratio(prepared.refractionEtaTOverEtaI, prepared.specularAlpha);
        prepared.dielectricMsViewLoss = openpbr_ideal_dielectric_loss(prepared.refractionEtaTOverEtaI, prepared.specularAlpha, viewCosine);
        let averageScale = mix(prepared.dielectricMsTransmissionScale, prepared.dielectricMsReflectionScale, prepared.dielectricMsReflectionRatio);
        let msEstimate = openpbr_luminance(averageScale) * prepared.dielectricMsViewLoss;
        prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] += msEstimate;
        prepared.dielectricMsProbability = msEstimate / max(prepared.probabilities[OPENPBR_LOBE_TRANSMISSION], 1e-12);
    }
    prepared.probabilities[OPENPBR_LOBE_DIFFUSE] = prepared.weights[OPENPBR_LOBE_DIFFUSE]
        * openpbr_luminance(prepared.diffuseColor)
        * prepared.diffuseSpecularEnergyCompensation;
    prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] = prepared.weights[OPENPBR_LOBE_SUBSURFACE]
        * (1.0 - transmissionFresnel)
        * openpbr_luminance(material.subsurfaceColor)
        * prepared.diffuseSpecularEnergyCompensation;
    // Index-matched base interfaces can still reflect through thin film.
    // Keep proposal support without duplicating the Airy optical solve here.
    if ((material.coatWeight > 0.0) & HAS_THIN_FILM & (material.thinFilmWeight > 0.0)) {
        let filmSupport = 0.02 * openpbr_thin_film_presence(material.thinFilmThickness, material.thinFilmWeight);
        prepared.probabilities[OPENPBR_LOBE_SPECULAR] = max(prepared.probabilities[OPENPBR_LOBE_SPECULAR], prepared.weights[OPENPBR_LOBE_SPECULAR] * filmSupport);
        prepared.probabilities[OPENPBR_LOBE_METAL] = max(prepared.probabilities[OPENPBR_LOBE_METAL], prepared.weights[OPENPBR_LOBE_METAL] * material.specularWeight * filmSupport);
    }
    if ((material.coatWeight > 0.0) & !material.inside) {
        let baseScale = max(max(prepared.coatBaseScale.x, prepared.coatBaseScale.y), prepared.coatBaseScale.z);
        prepared.probabilities[OPENPBR_LOBE_METAL] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_SPECULAR] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_DIFFUSE] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] *= baseScale;
    }
    openpbr_normalize_probabilities(&prepared);
    return prepared;
}


fn openpbr_substrate_fresnel(prepared: OpenPbrPreparedBsdf, cosine: f32, reflection: bool) -> f32 {
    if (prepared.material.coatWeight <= 0.0) {
        return openpbr_dielectric_fresnel(cosine, prepared.material.relativeIor);
    }
    let transFresnel = openpbr_dielectric_fresnel(cosine, prepared.transmissionReflectionIor);
    if (!reflection) { return transFresnel; }
    let opaqueFresnel = openpbr_dielectric_fresnel(cosine, 1.0 / prepared.specularEtaTOverEtaI);
    let nonOpaque = prepared.material.transmissionWeight + (1.0 - prepared.material.transmissionWeight) * prepared.material.subsurfaceWeight;
    return mix(opaqueFresnel, transFresnel, nonOpaque);
}

fn openpbr_eval_prepared_lobe(
    prepared: OpenPbrPreparedBsdf,
    lightDirection: vec3f,
    allowedLobe: i32,
    pdf: ptr<function, f32>
) -> vec3f {
    let material = prepared.material;
    let viewLocal = prepared.viewLocal;
    let lightLocal = openpbr_to_local(prepared.basis, lightDirection);
    let reflection = lightLocal.z * viewLocal.z > 0.0;
${hasCoatNormals ? /* wgsl */ `
    let independentCoat = material.coatNormalEnabled;
    let geometricReflection = dot(material.geometricNormal, lightDirection) > 0.0;
    let coatLightCosine = dot(prepared.coatBasis.normal, lightDirection);
    let coatReflection = geometricReflection & (prepared.coatViewLocal.z > 0.0) & (coatLightCosine > 0.0);
` : ''}

    var halfVector: vec3f;
    if (reflection) {
        halfVector = normalize(lightLocal + viewLocal);
    }
    else {
        halfVector = normalize(lightLocal + viewLocal * material.relativeIor);
    }
    if (halfVector.z < 0.0) {
        halfVector = -halfVector;
    }

    var response = vec3f(0.0);
    *pdf = 0.0;
    var lobePdf = 0.0;
    let allowAll = allowedLobe < 0;
    let allowFuzz = allowAll | (allowedLobe == OPENPBR_LOBE_FUZZ);
    let allowCoat = allowAll | (allowedLobe == OPENPBR_LOBE_COAT);
    let allowMetal = allowAll | (allowedLobe == OPENPBR_LOBE_METAL);
    let allowSpecular = allowAll | (allowedLobe == OPENPBR_LOBE_SPECULAR);
    let allowTransmission = allowAll | (allowedLobe == OPENPBR_LOBE_TRANSMISSION);
    let allowDiffuse = allowAll | (allowedLobe == OPENPBR_LOBE_DIFFUSE);
    let allowSubsurface = allowAll | (allowedLobe == OPENPBR_LOBE_SUBSURFACE);
    let viewHalf = abs(dot(viewLocal, halfVector));
    // Reflection, solid refraction and thin-wall transmission share the same
    // dielectric optical solve. Select its half angle before evaluating the
    // film, instead of inlining that large solve in each transport branch.
    var thinWallHalf = halfVector;
    var dielectricViewHalf = viewHalf;
    if (!reflection & material.thinWalled) {
        thinWallHalf = normalize(vec3f(lightLocal.xy, -lightLocal.z) + viewLocal);
        if (thinWallHalf.z < 0.0) { thinWallHalf = -thinWallHalf; }
        dielectricViewHalf = abs(dot(viewLocal, thinWallHalf));
    }
    let evaluateDielectric =
        (reflection & (prepared.weights[OPENPBR_LOBE_SPECULAR] > 0.0) & allowSpecular) |
        (!reflection & (prepared.weights[OPENPBR_LOBE_TRANSMISSION] > 0.0) & allowTransmission);
    let evaluateMetal = reflection & (prepared.weights[OPENPBR_LOBE_METAL] > 0.0) & allowMetal;
    var fresnels: array<vec3f, 2>;
    if (evaluateDielectric) {
        fresnels[0] = vec3f(openpbr_substrate_fresnel(prepared, dielectricViewHalf, reflection));
    }
    if (evaluateMetal) {
        fresnels[1] = openpbr_metal_fresnel(viewHalf, material.baseWeight * material.baseColor, material.specularColor);
    }
    if (HAS_THIN_FILM & (material.thinFilmWeight > 0.0)) {
        let wavelengths = vec3f(620.0, 540.0, 450.0);
        // Dielectric and conductor substrates share one complete optical graph.
        for (var substrate = 0u; substrate < (rtUniform.loopUnrollGuard >> 1u); substrate++) {
            if (!select(evaluateDielectric, evaluateMetal, substrate == 1u)) { continue; }
            var film = vec3f(0.0);
            let incidentCosine = select(dielectricViewHalf, viewHalf, substrate == 1u);
            for (var channel = 0u; channel + 1u < rtUniform.loopUnrollGuard; channel++) {
                var ior = vec2f(prepared.thinFilmBaseIor, 0.0);
                if (substrate == 1u) {
                    ior = openpbr_metal_complex_ior(material.baseWeight * material.baseColor[channel], material.specularColor[channel]);
                }
                film[channel] = openpbr_thin_film_reflectance_channel(incidentCosine,
                    wavelengths[channel], material.thinFilmThickness, prepared.thinFilmExteriorIor, material.thinFilmIor, ior);
            }
            fresnels[substrate] = mix(fresnels[substrate], film,
                openpbr_thin_film_presence(material.thinFilmThickness, material.thinFilmWeight));
        }
    }
    let substrateFresnel = fresnels[0];
    let diffuseSpecularEnergyCompensation =
        prepared.diffuseSpecularEnergyCompensation
        * openpbr_opaque_energy_complement(
            prepared.specularEtaTOverEtaI,
            prepared.specularAlpha,
            abs(lightLocal.z)
        );

${hasCoatNormals ? /* wgsl */ `
    // Each lobe retains its own shading hemisphere; topology is geometric.
    if (!independentCoat | ((lightLocal.z != 0.0) & (reflection == geometricReflection))) {
` : ''}
    if (reflection) {
        if ((prepared.weights[OPENPBR_LOBE_DIFFUSE] > 0.0) & allowDiffuse) {
            response += prepared.weights[OPENPBR_LOBE_DIFFUSE] * openpbr_eval_diffuse(
                material,
                prepared.diffuseColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                &lobePdf
            );
            *pdf += prepared.probabilities[OPENPBR_LOBE_DIFFUSE] * lobePdf;
        }

        if ((prepared.weights[OPENPBR_LOBE_SUBSURFACE] > 0.0) & material.thinWalled & allowSubsurface) {
            response += 0.5 * prepared.weights[OPENPBR_LOBE_SUBSURFACE] * openpbr_eval_diffuse(
                material,
                material.subsurfaceColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                &lobePdf
            );
            *pdf += prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] * 0.5 * lobePdf;
        }

        if ((prepared.weights[OPENPBR_LOBE_SPECULAR] > 0.0) & allowSpecular) {
            var dielectricFresnel = substrateFresnel;
            if (material.thinWalled) {
                dielectricFresnel = openpbr_thin_wall_reflection_coefficient(
                    dielectricFresnel,
                    material.transmissionWeight
                );
            }
            let fresnel = material.specularColor * dielectricFresnel;
            response += prepared.weights[OPENPBR_LOBE_SPECULAR] * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                &lobePdf
            );
            *pdf += prepared.probabilities[OPENPBR_LOBE_SPECULAR] * lobePdf;
        }

        if ((prepared.weights[OPENPBR_LOBE_METAL] > 0.0) & allowMetal) {
            let fresnel = material.specularWeight * fresnels[1];
            response += prepared.weights[OPENPBR_LOBE_METAL] * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                &lobePdf
            );
            if (prepared.metalMsFactor > 0.0) {
                let factor = min(prepared.metalMsFactor * openpbr_metal_energy_complement(prepared.specularAlpha, lightLocal.z), 1.0 / max(lightLocal.z, 1e-8));
                response += prepared.weights[OPENPBR_LOBE_METAL] * prepared.metalMsScale * factor * INVPI;
                lobePdf = mix(lobePdf, 0.5 * INVPI, prepared.metalMsProbability);
            }
            *pdf += prepared.probabilities[OPENPBR_LOBE_METAL] * lobePdf;
        }
    }
    else {
        let fresnel = substrateFresnel;
        if ((prepared.weights[OPENPBR_LOBE_TRANSMISSION] > 0.0) & allowTransmission) {
            if (material.thinWalled) {
                let mirroredLight = vec3f(lightLocal.xy, -lightLocal.z);
                let windowFresnel = openpbr_thin_wall_reflection_coefficient(
                    substrateFresnel,
                    1.0
                );
                let tint = openpbr_final_transmission_tint(
                    material,
                    abs(viewLocal.z),
                    prepared.refractionEtaTOverEtaI
                );
                response += prepared.weights[OPENPBR_LOBE_TRANSMISSION]
                    * openpbr_eval_microfacet_reflection(
                        material,
                        viewLocal,
                        mirroredLight,
                        thinWallHalf,
                        tint * (vec3f(1.0) - windowFresnel),
                        &lobePdf
                    );
            }
            else {
                response += prepared.weights[OPENPBR_LOBE_TRANSMISSION]
                    * openpbr_eval_microfacet_refraction(
                        material,
                        material.relativeIor,
                        openpbr_transmission_tint(material),
                        viewLocal,
                        lightLocal,
                        halfVector,
                        fresnel,
                        &lobePdf
                    );
            }
            if (prepared.dielectricMsProbability > 0.0) {
                lobePdf *= 1.0 - prepared.dielectricMsProbability;
            }
            *pdf += prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] * lobePdf;
        }
        if ((prepared.weights[OPENPBR_LOBE_SUBSURFACE] > 0.0) & allowSubsurface) {
            if (material.thinWalled) {
                let flippedLight = vec3f(lightLocal.xy, -lightLocal.z);
                response += 0.5 * prepared.weights[OPENPBR_LOBE_SUBSURFACE]
                    * openpbr_eval_diffuse(
                        material,
                        material.subsurfaceColor,
                        viewLocal,
                        flippedLight,
                        diffuseSpecularEnergyCompensation,
                        &lobePdf
                    );
                lobePdf *= 0.5;
            }
            else {
                response += prepared.weights[OPENPBR_LOBE_SUBSURFACE] * openpbr_eval_subsurface_boundary(
                    material,
                    viewLocal,
                    lightLocal,
                    &lobePdf
                );
            }
            *pdf += prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] * lobePdf;
        }
    }

    // Reference value includes the hemisphere ratio before the grazing clamp.
    // Reference scale_trans has no extra eta^2 factor; single refraction keeps
    // its existing radiance Jacobian. Both proposals share the aggregate PDF.
    if ((prepared.dielectricMsProbability > 0.0) & allowTransmission) {
        let cosine = abs(lightLocal.z);
        if (cosine > 0.0) {
            let ior = select(1.0 / prepared.refractionEtaTOverEtaI, prepared.refractionEtaTOverEtaI, reflection);
            let ratio = select(1.0 - prepared.dielectricMsReflectionRatio, prepared.dielectricMsReflectionRatio, reflection);
            let factors = prepared.dielectricMsViewLoss * openpbr_ideal_dielectric_loss(ior, prepared.specularAlpha, cosine)
                / max(openpbr_ideal_dielectric_average_loss(ior, prepared.specularAlpha), 1e-12);
            let factor = min(factors * ratio, 1.0 / cosine);
            let scale = select(prepared.dielectricMsTransmissionScale, prepared.dielectricMsReflectionScale, reflection);
            response += scale * factor * INVPI;
            *pdf += prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] * prepared.dielectricMsProbability * ratio * 0.5 * INVPI;
        }
    }

${hasCoatNormals ? /* wgsl */ `    } // base hemisphere support` : ''}
    if (material.coatWeight > 0.0) {
        response *= openpbr_coat_base_scale(prepared, ${hasCoatNormals ? 'select(lightLocal.z, coatLightCosine, independentCoat)' : 'lightLocal.z'});
    }
${hasCoatNormals ? /* wgsl */ `
    // Values are BSDF*cos in world solid angle before the frames are combined.
    if (independentCoat) { response *= abs(lightLocal.z); }
` : ''}

${hasAnisotropyDirections ? /* wgsl */ `
    if (${hasCoatNormals ? 'select(reflection, coatReflection, independentCoat)' : 'reflection'} & (prepared.weights[OPENPBR_LOBE_COAT] > 0.0)) {
        var coatView = viewLocal;
        var coatLight = lightLocal;
        var coatHalf = halfVector;
        var coatViewHalf = viewHalf;
        if (prepared.directionFrames) {
            coatView = ${hasCoatNormals ? 'select(openpbr_to_local(prepared.coatBasis, openpbr_to_world(prepared.basis, viewLocal)), prepared.coatViewLocal, independentCoat)' : 'openpbr_to_local(prepared.coatBasis, openpbr_to_world(prepared.basis, viewLocal))'};
            coatLight = openpbr_to_local(prepared.coatBasis, lightDirection);
            coatHalf = normalize(coatLight + coatView);
            if (coatHalf.z < 0.0) { coatHalf = -coatHalf; }
            coatViewHalf = abs(dot(coatView, coatHalf));
        }

        let coatFresnel = vec3f(openpbr_dielectric_fresnel(
            coatViewHalf,
            1.0 / material.coatIor
        ));
        var coatMaterial = material;
        let coatAlpha = openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy);
        coatMaterial.alphaX = coatAlpha.x;
        coatMaterial.alphaY = coatAlpha.y;
        if (allowCoat) {
            response += prepared.weights[OPENPBR_LOBE_COAT]${hasCoatNormals ? ' * select(1.0, max(coatLightCosine, 0.0), independentCoat)' : ''} * openpbr_eval_microfacet_reflection(
                coatMaterial,
                coatView,
                coatLight,
                coatHalf,
                coatFresnel,
                &lobePdf
            );
            *pdf += prepared.probabilities[OPENPBR_LOBE_COAT] * lobePdf;
        }
    }
` : /* wgsl */ `
    if (${hasCoatNormals ? 'select(reflection, coatReflection, independentCoat)' : 'reflection'} & (prepared.weights[OPENPBR_LOBE_COAT] > 0.0)) {
        let coatFresnel = vec3f(openpbr_dielectric_fresnel(
            viewHalf,
            1.0 / material.coatIor
        ));
        var coatMaterial = material;
        let coatAlpha = openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy);
        coatMaterial.alphaX = coatAlpha.x;
        coatMaterial.alphaY = coatAlpha.y;
        if (allowCoat) {
            response += prepared.weights[OPENPBR_LOBE_COAT]${hasCoatNormals ? ' * select(1.0, max(coatLightCosine, 0.0), independentCoat)' : ''} * openpbr_eval_microfacet_reflection(
                coatMaterial,
                viewLocal,
                lightLocal,
                halfVector,
                coatFresnel,
                &lobePdf
            );
            *pdf += prepared.probabilities[OPENPBR_LOBE_COAT] * lobePdf;
        }
    }
`}

    if (${hasCoatNormals ? 'select(reflection, geometricReflection, independentCoat)' : 'reflection'} & (prepared.weights[OPENPBR_LOBE_FUZZ] > 0.0)) {
        let fuzzAlbedo = openpbr_fuzz_directional_albedo(
            abs(viewLocal.z),
            material.fuzzRoughness
        );
        response *= max(
            vec3f(0.0),
            vec3f(1.0 - prepared.weights[OPENPBR_LOBE_FUZZ] * fuzzAlbedo)
        );
        if (allowFuzz) {
            response += prepared.weights[OPENPBR_LOBE_FUZZ]${hasCoatNormals ? ' * select(1.0, max(lightLocal.z, 0.0), independentCoat)' : ''} * openpbr_eval_fuzz(
                material,
                viewLocal,
                lightLocal,
                &lobePdf
            );
            *pdf += prepared.probabilities[OPENPBR_LOBE_FUZZ] * lobePdf;
        }
    }

    return response * ${hasCoatNormals ? 'select(abs(lightLocal.z), 1.0, independentCoat)' : 'abs(lightLocal.z)'};
}

fn openpbr_eval_prepared(
    prepared: OpenPbrPreparedBsdf,
    lightDirection: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    return openpbr_eval_prepared_lobe(prepared, lightDirection, -1, pdf);
}





fn openpbr_eval(
    tangent: vec3f,
    material: OpenPbrResolvedMaterial,
    viewDirection: vec3f,
    normal: vec3f,
    lightDirection: vec3f,
    pdf: ptr<function, f32>
) -> vec3f {
    let prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    return openpbr_eval_prepared(prepared, lightDirection, pdf);
}




// Direction-only proposals do not require the layered response or film optics.
fn openpbr_sample_direction(
    prepared: OpenPbrPreparedBsdf, randomSamples: vec3f,
    lightDirection: ptr<function, vec3f>, isTransmissionEvent: ptr<function, bool>,
    sampledLobeRoughness: ptr<function, f32>, sampledLobeSpecular: ptr<function, bool>,
    sampledLobeDiffuse: ptr<function, bool>, sampledLobeIndex: ptr<function, u32>
) -> bool {
    let material = prepared.material;
    let viewLocal = prepared.viewLocal;
    var randomX = randomSamples.x;
    let randomY = randomSamples.y;
    let lobeSample = randomSamples.z;
    *isTransmissionEvent = false;
    *sampledLobeRoughness = 1.0;
    *sampledLobeSpecular = false;
    *sampledLobeDiffuse = false;
    *sampledLobeIndex = u32(OPENPBR_LOBE_DIFFUSE);
    *lightDirection = prepared.basis.normal;

    var cdf: array<f32, OPENPBR_LOBE_COUNT>;
    cdf[OPENPBR_LOBE_FUZZ] = prepared.probabilities[OPENPBR_LOBE_FUZZ];
    ${LOBE_INDICES.slice(1).map(i => /* wgsl */ `cdf[${i}] = cdf[${i - 1}] + prepared.probabilities[${i}];`).join('\n    ')}
    if (cdf[OPENPBR_LOBE_SUBSURFACE] <= 0.0) {
        return false;
    }

    var lightLocal: vec3f;
    if ((lobeSample < cdf[OPENPBR_LOBE_FUZZ]) | (
        (lobeSample >= cdf[OPENPBR_LOBE_TRANSMISSION]) & (lobeSample < cdf[OPENPBR_LOBE_DIFFUSE])
    )) {
        let sampledFuzz = lobeSample < cdf[OPENPBR_LOBE_FUZZ];
        *sampledLobeRoughness = select(
            1.0,
            material.fuzzRoughness,
            sampledFuzz
        );
        *sampledLobeDiffuse = !sampledFuzz;
        *sampledLobeIndex = select(
            u32(OPENPBR_LOBE_DIFFUSE),
            u32(OPENPBR_LOBE_FUZZ),
            sampledFuzz
        );
        lightLocal = sampling_cosine_hemisphere(vec2f(randomX, randomY));
    }
${hasAnisotropyDirections ? /* wgsl */ `
    else if (lobeSample < cdf[OPENPBR_LOBE_COAT]) {
        *sampledLobeRoughness = material.coatRoughness;
        *sampledLobeSpecular = true;
        *sampledLobeIndex = u32(OPENPBR_LOBE_COAT);
        var coatView = viewLocal;
        if (prepared.directionFrames) { coatView = ${hasCoatNormals ? 'select(openpbr_to_local(prepared.coatBasis, openpbr_to_world(prepared.basis, viewLocal)), prepared.coatViewLocal, material.coatNormalEnabled)' : 'openpbr_to_local(prepared.coatBasis, openpbr_to_world(prepared.basis, viewLocal))'}; }
        var halfVector = sampling_ggx_visible_normal(
            coatView,
            // The VNDF must use the same alpha as the evaluated coat PDF.
            openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy),
            vec2f(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-coatView, halfVector));
${hasCoatNormals ? /* wgsl */ `
        if (material.coatNormalEnabled) {
            // Validate against the sampled coat frame, never the base normal.
            *lightDirection = openpbr_to_world(prepared.coatBasis, lightLocal);
            return (lightLocal.z > 0.0) & (dot(material.geometricNormal, *lightDirection) > 0.0);
        }
` : ''}
        if (prepared.directionFrames) { lightLocal = openpbr_to_local(prepared.basis, openpbr_to_world(prepared.coatBasis, lightLocal)); }
    }
` : /* wgsl */ `
    else if (lobeSample < cdf[OPENPBR_LOBE_COAT]) {
        *sampledLobeRoughness = material.coatRoughness;
        *sampledLobeSpecular = true;
        *sampledLobeIndex = u32(OPENPBR_LOBE_COAT);
        var halfVector = sampling_ggx_visible_normal(
            viewLocal,
            // The VNDF must use the same alpha as the evaluated coat PDF.
            openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy),
            vec2f(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-viewLocal, halfVector));
    }
`}
    else if (lobeSample < cdf[OPENPBR_LOBE_SPECULAR]) {
        *sampledLobeRoughness = material.specularRoughness;
        *sampledLobeSpecular = true;
        *sampledLobeIndex = select(
            u32(OPENPBR_LOBE_SPECULAR),
            u32(OPENPBR_LOBE_METAL),
            lobeSample < cdf[OPENPBR_LOBE_METAL]
        );
        let isMetal = lobeSample < cdf[OPENPBR_LOBE_METAL];
        let metalDraw = (lobeSample - cdf[OPENPBR_LOBE_COAT]) / max(prepared.probabilities[OPENPBR_LOBE_METAL], 1e-12);
        if (isMetal & (metalDraw < prepared.metalMsProbability)) {
            let z = randomX;
            let radial = sqrt(max(0.0, 1.0 - z * z));
            let azimuth = TWOPI * randomY;
            lightLocal = vec3f(radial * cos(azimuth), radial * sin(azimuth), z);
        }
        else {
            var halfVector = sampling_ggx_visible_normal(
                viewLocal,
                vec2f(material.alphaX, material.alphaY),
                vec2f(randomX, randomY)
            );
            if (halfVector.z < 0.0) {
                halfVector = -halfVector;
            }
            lightLocal = normalize(reflect(-viewLocal, halfVector));
        }
    }
    else if (lobeSample < cdf[OPENPBR_LOBE_TRANSMISSION]) {
        *sampledLobeRoughness = material.specularRoughness;
        *sampledLobeSpecular = true;
        *isTransmissionEvent = true;
        *sampledLobeIndex = u32(OPENPBR_LOBE_TRANSMISSION);
        // Split the existing BSDF_LOBE interval. BSDF_DIRECTION retains its
        // two dimensions; rand.x selects and remaps the reference hemisphere.
        let msDraw = (lobeSample - cdf[OPENPBR_LOBE_SPECULAR]) / max(prepared.probabilities[OPENPBR_LOBE_TRANSMISSION], 1e-12);
        if ((prepared.dielectricMsProbability > 0.0) & (msDraw < prepared.dielectricMsProbability)) {
            let ratio = prepared.dielectricMsReflectionRatio;
            let reflectMs = randomX < ratio;
            var z: f32;
            if (reflectMs) { z = min(randomX / ratio, 0.99999994); }
            else { z = -min((randomX - ratio) / (1.0 - ratio), 0.99999994); }
            let radial = sqrt(max(0.0, 1.0 - z * z));
            let azimuth = TWOPI * randomY;
            lightLocal = vec3f(radial * cos(azimuth), radial * sin(azimuth), z);
            *isTransmissionEvent = !reflectMs;
            *sampledLobeIndex = select(u32(OPENPBR_LOBE_TRANSMISSION), u32(OPENPBR_LOBE_SPECULAR), reflectMs);
        }
        else {
            var halfVector = sampling_ggx_visible_normal(
                viewLocal,
                vec2f(material.alphaX, material.alphaY),
                vec2f(randomX, randomY)
            );
            if (halfVector.z < 0.0) {
                halfVector = -halfVector;
            }
            if (material.thinWalled) {
                let reflectedLocal = normalize(reflect(-viewLocal, halfVector));
                lightLocal = vec3f(reflectedLocal.xy, -reflectedLocal.z);
            }
            else {
                lightLocal = refract(
                    -viewLocal,
                    halfVector,
                    prepared.material.relativeIor
                );
                if (dot(lightLocal, lightLocal) <= 1e-8) {
                    *isTransmissionEvent = false;
                    return false;
                }
                lightLocal = normalize(lightLocal);
            }
        }
    }
    else {
        *sampledLobeRoughness = 1.0;
        *sampledLobeDiffuse = true;
        *isTransmissionEvent = true;
        *sampledLobeIndex = u32(OPENPBR_LOBE_SUBSURFACE);
        if (material.thinWalled) {
            let transmit = randomX >= 0.5;
            if (transmit) {
                randomX = (randomX - 0.5) * 2.0;
            }
            else {
                randomX *= 2.0;
            }
            lightLocal = sampling_cosine_hemisphere(vec2f(randomX, randomY));
            if (transmit) {
                lightLocal.z = -lightLocal.z;
            }
            else {
                *isTransmissionEvent = false;
            }
        }
        else {
            lightLocal = sampling_cosine_hemisphere(vec2f(randomX, randomY));
            lightLocal.z = -lightLocal.z;
        }
    }

    *lightDirection = openpbr_to_world(prepared.basis, lightLocal);
    // VNDF reflection may land below the macrosurface. A mirrored thin-wall
    // transmission draw can likewise land above it. Reject that draw before
    // aggregate evaluation can accidentally turn it into the opposite lobe.
    if ((lightLocal.z == 0.0) | ((lightLocal.z < 0.0) != *isTransmissionEvent)) {
        return false;
    }
${hasCoatNormals ? /* wgsl */ `
    if (material.coatNormalEnabled &
        ((dot(material.geometricNormal, *lightDirection) <= 0.0) != *isTransmissionEvent)) { return false; }
` : ''}
    return true;
}

fn openpbr_sample_prepared(
    prepared: OpenPbrPreparedBsdf,
    randomSamples: vec3f,
    lightDirection: ptr<function, vec3f>,
    pdf: ptr<function, f32>,
    isTransmissionEvent: ptr<function, bool>,
    sampledLobeRoughness: ptr<function, f32>,
    sampledLobeSpecular: ptr<function, bool>,
    sampledLobeDiffuse: ptr<function, bool>,
    sampledLobeIndex: ptr<function, u32>,
    marginalPdf: ptr<function, f32>,
    fullResponse: ptr<function, vec3f>
) -> vec3f {
    *pdf = 0.0;
    *marginalPdf = 0.0;
    *fullResponse = vec3f(0.0);
    // Solid microfacet refraction is singular at exactly eta=1: the usual
    // half vector normalizes light + eta * view, which is zero for straight
    // transmission. Resolve the physically null boundary as a discrete,
    // unit-throughput continuation instead of losing the path to NaNs.
    if (!prepared.material.thinWalled &
        (abs(prepared.material.relativeIor - 1.0) <= 1e-6) &
        (prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] >= 1.0 - 1e-6)) {
        *lightDirection = openpbr_to_world(
            prepared.basis,
            -prepared.viewLocal
        );
        let nullBoundaryTint = openpbr_transmission_tint(prepared.material)
            * openpbr_coat_base_scale(prepared, ${hasCoatNormals ? 'select(-prepared.viewLocal.z, dot(prepared.coatBasis.normal, *lightDirection), prepared.material.coatNormalEnabled)' : '-prepared.viewLocal.z'});
        *pdf = 1.0;
        *marginalPdf = 1.0;
        *fullResponse = nullBoundaryTint;
        *isTransmissionEvent = true;
        *sampledLobeRoughness = 0.0;
        *sampledLobeSpecular = true;
        *sampledLobeDiffuse = false;
        *sampledLobeIndex = u32(OPENPBR_LOBE_TRANSMISSION);
        return nullBoundaryTint;
    }
    if (!openpbr_sample_direction(prepared, randomSamples, lightDirection,
        isTransmissionEvent, sampledLobeRoughness, sampledLobeSpecular,
        sampledLobeDiffuse, sampledLobeIndex)) { return vec3f(0.0); }
    let response = openpbr_eval_prepared(prepared, *lightDirection, pdf);
    *marginalPdf = *pdf;
    *fullResponse = response;
    return response;
}

fn openpbr_sample(
    tangent: vec3f,
    material: OpenPbrResolvedMaterial,
    randomSamples: vec3f,
    viewDirection: vec3f,
    normal: vec3f,
    lightDirection: ptr<function, vec3f>,
    pdf: ptr<function, f32>,
    isTransmissionEvent: ptr<function, bool>,
    sampledLobeRoughness: ptr<function, f32>,
    sampledLobeSpecular: ptr<function, bool>,
    sampledLobeDiffuse: ptr<function, bool>,
    sampledLobeIndex: ptr<function, u32>,
    marginalPdf: ptr<function, f32>
) -> vec3f {
    let prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    var fullResponse = vec3f(0.0);
    return openpbr_sample_prepared(
        prepared,
        randomSamples,
        lightDirection,
        pdf,
        isTransmissionEvent,
        sampledLobeRoughness,
        sampledLobeSpecular,
        sampledLobeDiffuse,
        sampledLobeIndex,
        marginalPdf,
        &fullResponse
    );
}`;

}

export default createOpenPbrBsdfWgsl();
