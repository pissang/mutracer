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
import { glsl } from '../../shader.js';

import { OPENPBR_METAL_ENERGY_LUT_ROW, OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW, OPENPBR_DIELECTRIC_ENERGY_LUT_ROW, OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW, OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW } from '../../openPbrEnergyLut.js';

export default glsl`
const int OPENPBR_LOBE_FUZZ = 0;
const int OPENPBR_LOBE_COAT = 1;
const int OPENPBR_LOBE_METAL = 2;
const int OPENPBR_LOBE_SPECULAR = 3;
const int OPENPBR_LOBE_TRANSMISSION = 4;
const int OPENPBR_LOBE_DIFFUSE = 5;
const int OPENPBR_LOBE_SUBSURFACE = 6;
const int OPENPBR_LOBE_COUNT = 7;

struct OpenPbrBasis {
    vec3 tangent;
    vec3 bitangent;
    vec3 normal;
};

struct OpenPbrPreparedBsdf {
    OpenPbrResolvedMaterial material;
    OpenPbrBasis basis;
    OpenPbrBasis coatBasis;
    bool directionFrames;
#ifdef USE_COAT_NORMAL_FRAMES
    vec3 coatViewLocal;
#endif
    vec3 viewLocal;
    vec3 diffuseColor;
    float specularEtaTOverEtaI;
    float refractionEtaTOverEtaI;
    float transmissionReflectionIor;
    float thinFilmExteriorIor;
    float thinFilmBaseIor;
    float specularAlpha;
    float diffuseSpecularEnergyCompensation;
    vec3 coatBaseScale;
    vec3 metalMsScale;
    float metalMsFactor;
    float metalMsProbability;

    vec3 dielectricMsReflectionScale;
    vec3 dielectricMsTransmissionScale;
    float dielectricMsViewLoss;
    float dielectricMsReflectionRatio;
    float dielectricMsProbability;

    float weights[OPENPBR_LOBE_COUNT];
    float probabilities[OPENPBR_LOBE_COUNT];
};

float openpbr_luminance(vec3 color) {
    return dot(color, vec3(0.212671, 0.715160, 0.072169));
}

float openpbr_f0_from_ior(float etaTOverEtaI) {
    float value = (etaTOverEtaI - 1.0) / (etaTOverEtaI + 1.0);
    return value * value;
}

float openpbr_apply_specular_weight_to_ior(
    float etaTOverEtaI,
    float specularWeight
) {
    float scaledF0 = min(
        openpbr_f0_from_ior(etaTOverEtaI) * specularWeight,
        0.9999
    );
    float sqrtF0 = sqrt(scaledF0);
    float externalIor = (1.0 + sqrtF0) / (1.0 - sqrtF0);
    return etaTOverEtaI < 1.0 ? 1.0 / externalIor : externalIor;
}

float openpbr_dielectric_fresnel(float cosTheta, float relativeIor) {
    if (abs(relativeIor - 1.0) < 1e-6) {
        return 0.0;
    }
    return sampling_dielectric_fresnel(cosTheta, relativeIor);
}

float openpbr_energy_ior_index(float ior) {
    if (ior < 1.0) {
        return 15.0 - ((1.0 / ior - 1.0) / 1.5) * 15.0;
    }
    return 16.0 + ((ior - 1.0) / 1.5) * 15.0;
}

float openpbr_energy_fetch(int cosIndex, int row) {
    return texelFetch(openPbrEnergyLut, ivec2(cosIndex, row), 0).r;
}

float openpbr_energy_trilinear(
    float exactIor,
    float exactAlpha,
    float exactCosine
) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    float cosineIndex = clamp(exactCosine, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int cosine0 = int(floor(cosineIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    int cosine1 = min(cosine0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float cosineMix = cosineIndex - float(cosine0);

    float v000 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha0);
    float v001 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha0);
    float v010 = openpbr_energy_fetch(cosine0, ior0 * 32 + alpha1);
    float v011 = openpbr_energy_fetch(cosine1, ior0 * 32 + alpha1);
    float v100 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha0);
    float v101 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha0);
    float v110 = openpbr_energy_fetch(cosine0, ior1 * 32 + alpha1);
    float v111 = openpbr_energy_fetch(cosine1, ior1 * 32 + alpha1);
    float v00 = mix(v000, v100, iorMix);
    float v01 = mix(v001, v101, iorMix);
    float v10 = mix(v010, v110, iorMix);
    float v11 = mix(v011, v111, iorMix);
    return mix(
        mix(v00, v10, alphaMix),
        mix(v01, v11, alphaMix),
        cosineMix
    );
}

float openpbr_energy_bilinear(float exactIor, float exactAlpha) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float v00 = openpbr_energy_fetch(alpha0, 1024 + ior0);
    float v01 = openpbr_energy_fetch(alpha1, 1024 + ior0);
    float v10 = openpbr_energy_fetch(alpha0, 1024 + ior1);
    float v11 = openpbr_energy_fetch(alpha1, 1024 + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

// Adobe c91aad1 ideal dielectric tables clamp IOR indices; unlike opaque
// dielectric data they do not extrapolate outside [0.4, 2.5].
float openpbr_ideal_energy_trilinear(
    float exactIor,
    float exactAlpha,
    float exactCosine
) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    float cosineIndex = clamp(exactCosine, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int cosine0 = int(floor(cosineIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    int cosine1 = min(cosine0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float cosineMix = cosineIndex - float(cosine0);

    float v000 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha0);
    float v001 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha0);
    float v010 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha1);
    float v011 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior0 * 32 + alpha1);
    float v100 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha0);
    float v101 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha0);
    float v110 = openpbr_energy_fetch(cosine0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha1);
    float v111 = openpbr_energy_fetch(cosine1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_ROW} + ior1 * 32 + alpha1);
    float v00 = mix(v000, v100, iorMix);
    float v01 = mix(v001, v101, iorMix);
    float v10 = mix(v010, v110, iorMix);
    float v11 = mix(v011, v111, iorMix);
    return mix(
        mix(v00, v10, alphaMix),
        mix(v01, v11, alphaMix),
        cosineMix
    );
}

float openpbr_ideal_average_bilinear(float exactIor, float exactAlpha) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float v00 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior0);
    float v01 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior0);
    float v10 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior1);
    float v11 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW} + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

float openpbr_ideal_ratio_bilinear(float exactIor, float exactAlpha) {
    float iorIndex = clamp(exactIor, 0.0, 31.0);
    float alphaIndex = clamp(exactAlpha, 0.0, 31.0);
    int ior0 = int(floor(iorIndex));
    int alpha0 = int(floor(alphaIndex));
    int ior1 = min(ior0 + 1, 31);
    int alpha1 = min(alpha0 + 1, 31);
    float iorMix = iorIndex - float(ior0);
    float alphaMix = alphaIndex - float(alpha0);
    float v00 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior0);
    float v01 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior0);
    float v10 = openpbr_energy_fetch(alpha0, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior1);
    float v11 = openpbr_energy_fetch(alpha1, ${OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW} + ior1);
    return mix(
        mix(v00, v10, iorMix),
        mix(v01, v11, iorMix),
        alphaMix
    );
}

float openpbr_ideal_dielectric_loss(float ior, float alpha, float cosine) {
    return openpbr_ideal_energy_trilinear(openpbr_energy_ior_index(ior), sqrt(alpha) * 31.0, cosine * 31.0);
}
float openpbr_ideal_dielectric_average_loss(float ior, float alpha) {
    return openpbr_ideal_average_bilinear(openpbr_energy_ior_index(ior), sqrt(alpha) * 31.0);
}
float openpbr_ideal_dielectric_reflection_ratio(float ior, float alpha) {
    return openpbr_ideal_ratio_bilinear(openpbr_energy_ior_index(ior), sqrt(alpha) * 31.0);
}

// Adobe openpbr_microfacet_multiple_scattering_{data,lobes}.h (c91aad1).
float openpbr_metal_energy_complement(float alpha, float cosine) {
    float roughnessIndex = clamp(sqrt(alpha) * 31.0, 0.0, 31.0);
    float cosineIndex = clamp(cosine * 31.0, 0.0, 31.0);
    int r0 = int(floor(roughnessIndex));
    int c0 = int(floor(cosineIndex));
    int r1 = min(r0 + 1, 31);
    int c1 = min(c0 + 1, 31);
    return mix(
        mix(openpbr_energy_fetch(c0, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r0), openpbr_energy_fetch(c1, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r0), fract(cosineIndex)),
        mix(openpbr_energy_fetch(c0, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r1), openpbr_energy_fetch(c1, ${OPENPBR_METAL_ENERGY_LUT_ROW} + r1), fract(cosineIndex)),
        fract(roughnessIndex));
}

float openpbr_metal_average_energy_complement(float alpha) {
    float index = clamp(sqrt(alpha) * 31.0, 0.0, 31.0);
    int i0 = int(floor(index));
    return mix(openpbr_energy_fetch(i0, ${OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW}),
        openpbr_energy_fetch(min(i0 + 1, 31), ${OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW}), fract(index));
}

float openpbr_extrapolate_energy_complement(float value, float ior) {
    if (ior > 2.5 || ior < 0.4) {
        float maxF0 = openpbr_f0_from_ior(2.5);
        float progress = (openpbr_f0_from_ior(ior) - maxF0) / (1.0 - maxF0);
        return (1.0 - progress) * value;
    }
    return value;
}

float openpbr_opaque_energy_complement(
    float ior,
    float alpha,
    float cosine
) {
    float value = openpbr_energy_trilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0,
        cosine * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

float openpbr_opaque_average_energy_complement(float ior, float alpha) {
    float value = openpbr_energy_bilinear(
        openpbr_energy_ior_index(ior),
        sqrt(alpha) * 31.0
    );
    return openpbr_extrapolate_energy_complement(value, ior);
}

vec3 openpbr_to_world(OpenPbrBasis basis, vec3 direction) {
    return direction.x * basis.tangent
        + direction.y * basis.bitangent
        + direction.z * basis.normal;
}

vec3 openpbr_to_local(OpenPbrBasis basis, vec3 direction) {
    return vec3(
        dot(direction, basis.tangent),
        dot(direction, basis.bitangent),
        dot(direction, basis.normal)
    );
}

OpenPbrBasis openpbr_make_basis(
    vec3 inputTangent,
    vec3 normal,
    float anisotropy
) {
    OpenPbrBasis basis;
    basis.normal = normal;
    basis.tangent = vec3(0.0);
#ifdef USE_TANGENT
    basis.tangent = inputTangent;
#endif
    if (dot(basis.tangent, basis.tangent) < 0.001 || anisotropy <= 0.0) {
        sampling_orthonormal_basis(normal, basis.tangent, basis.bitangent);
    }
    else {
        basis.bitangent = normalize(cross(normal, basis.tangent));
        basis.tangent = normalize(cross(basis.bitangent, normal));
    }
    return basis;
}

float openpbr_fresnel_s(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return (incidentIor * incidentCosine - transmittedIor * transmittedCosine)
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

float openpbr_fresnel_p(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return (transmittedIor * incidentCosine - incidentIor * transmittedCosine)
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

float openpbr_transmission_s(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * incidentCosine + transmittedIor * transmittedCosine);
}

float openpbr_transmission_p(
    float incidentIor,
    float transmittedIor,
    float incidentCosine,
    float transmittedCosine
) {
    return 2.0 * incidentIor * incidentCosine
        / (incidentIor * transmittedCosine + transmittedIor * incidentCosine);
}

vec2 openpbr_complex_multiply(vec2 a, vec2 b) {
    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 openpbr_complex_divide(vec2 a, vec2 b) {
    float denominator = max(dot(b, b), 1e-9);
    return vec2(
        (a.x * b.x + a.y * b.y) / denominator,
        (a.y * b.x - a.x * b.y) / denominator
    );
}

vec2 openpbr_complex_sqrt(vec2 value) {
    float magnitude = length(value);
    float realPart = sqrt(max(0.0, 0.5 * (magnitude + value.x)));
    float imaginaryMagnitude = sqrt(max(0.0, 0.5 * (magnitude - value.x)));
    return vec2(realPart, value.y >= 0.0 ? imaginaryMagnitude : -imaginaryMagnitude);
}

vec2 openpbr_complex_fresnel_reflection(
    float incidentCosine,
    float incidentIor,
    vec2 transmittedIor,
    bool pPolarized
) {
    float incidentSine = sqrt(max(0.0, 1.0 - incidentCosine * incidentCosine));
    vec2 iorRatio = openpbr_complex_divide(vec2(incidentIor, 0.0), transmittedIor);
    vec2 transmittedSine = iorRatio * incidentSine;
    vec2 transmittedCosine = openpbr_complex_sqrt(
        vec2(1.0, 0.0) - openpbr_complex_multiply(transmittedSine, transmittedSine)
    );
    if (openpbr_complex_multiply(transmittedIor, transmittedCosine).y < 0.0) {
        transmittedCosine = -transmittedCosine;
    }

    vec2 incidentIorCosine = vec2(incidentIor * incidentCosine, 0.0);
    vec2 transmittedIorCosine = openpbr_complex_multiply(transmittedIor, transmittedCosine);
    if (pPolarized) {
        vec2 transmittedIorIncidentCosine = transmittedIor * incidentCosine;
        vec2 incidentIorTransmittedCosine = transmittedCosine * incidentIor;
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

float openpbr_airy_reflectance(
    float reflection12,
    float transmission12,
    float reflection21,
    float transmission21,
    vec2 reflection23,
    float phase
) {
    vec2 phaseRotation = vec2(cos(phase), sin(phase));
    vec2 reflectedPhase = openpbr_complex_multiply(reflection23, phaseRotation);
    vec2 numerator = reflectedPhase * (transmission12 * transmission21);
    vec2 denominator = vec2(1.0, 0.0) - reflectedPhase * reflection21;
    vec2 totalReflection = vec2(reflection12, 0.0)
        + openpbr_complex_divide(numerator, denominator);
    return dot(totalReflection, totalReflection);
}

float openpbr_thin_film_reflectance_channel(
    float incidentCosine,
    float wavelength,
    float thickness,
    float exteriorIor,
    float filmIor,
    vec2 substrateIor
) {
    incidentCosine = clamp(abs(incidentCosine), 1e-5, 1.0);
    float filmSineSquared = pow(exteriorIor / filmIor, 2.0)
        * (1.0 - incidentCosine * incidentCosine);
    if (filmSineSquared >= 1.0) {
        return 1.0;
    }
    float filmCosine = sqrt(1.0 - filmSineSquared);
    float reflection12S = openpbr_fresnel_s(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float reflection12P = openpbr_fresnel_p(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float transmission12S = openpbr_transmission_s(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float transmission12P = openpbr_transmission_p(
        exteriorIor, filmIor, incidentCosine, filmCosine
    );
    float transmission21Scale = filmIor * filmCosine
        / max(exteriorIor * incidentCosine, 1e-9);
    vec2 reflection23S = openpbr_complex_fresnel_reflection(
        filmCosine, filmIor, substrateIor, false
    );
    vec2 reflection23P = openpbr_complex_fresnel_reflection(
        filmCosine, filmIor, substrateIor, true
    );
    float phase = 2.0 * PI * (2.0 * filmIor * thickness * filmCosine) / wavelength;
    float reflectanceS = openpbr_airy_reflectance(
        reflection12S,
        transmission12S,
        -reflection12S,
        transmission12S * transmission21Scale,
        reflection23S,
        phase
    );
    float reflectanceP = openpbr_airy_reflectance(
        reflection12P,
        transmission12P,
        -reflection12P,
        transmission12P * transmission21Scale,
        reflection23P,
        phase
    );
    return clamp(0.5 * (reflectanceS + reflectanceP), 0.0, 1.0);
}

vec3 openpbr_thin_film_dielectric_reflectance(
    float incidentCosine,
    float thickness,
    float filmIor,
    float substrateIor,
    float exteriorIor
) {
    return vec3(
        openpbr_thin_film_reflectance_channel(
            incidentCosine, 620.0, thickness, exteriorIor, filmIor, vec2(substrateIor, 0.0)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine, 540.0, thickness, exteriorIor, filmIor, vec2(substrateIor, 0.0)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine, 450.0, thickness, exteriorIor, filmIor, vec2(substrateIor, 0.0)
        )
    );
}

// OpenPBR 1.1.1 Metal: analytic F82-tint correction to Schlick.
// Saturation follows Adobe impl/openpbr_lobe_utils.h, openpbr_metal_schlick_with_f82_tint.
vec3 openpbr_metal_fresnel(float cosine, vec3 f0, vec3 tint) {
    vec3 schlick = mix(f0, vec3(1.0), sampling_schlick_fifth_power(cosine));
    if (all(equal(tint, vec3(1.0)))) { return schlick; }
    float edgeCosine = 1.0 / 7.0;
    float edgeComplement = 1.0 - edgeCosine;
    vec3 edgeFresnel = mix(f0, vec3(1.0), sampling_schlick_fifth_power(edgeCosine));
    float complement = 1.0 - cosine;
    float correction = cosine * sampling_schlick_fifth_power(cosine) * complement
        / (edgeCosine * pow(edgeComplement, 6.0));
    return clamp(schlick - correction * (edgeFresnel - tint * edgeFresnel), vec3(0.0), vec3(1.0));
}

vec2 openpbr_metal_complex_ior(float f0, float f82Tint) {
    float reflectivity = clamp(f0, 0.0, 0.99);
    float sqrtReflectivity = sqrt(reflectivity);
    float minimumIor = (1.0 - reflectivity) / (1.0 + reflectivity);
    float maximumIor = (1.0 + sqrtReflectivity) / max(1.0 - sqrtReflectivity, 1e-9);
    float ior = mix(maximumIor, minimumIor, clamp(f82Tint, 0.0, 1.0));
    float extinctionSquared = (
        (ior + 1.0) * (ior + 1.0) * reflectivity
        - (ior - 1.0) * (ior - 1.0)
    ) / max(1.0 - reflectivity, 1e-9);
    return vec2(ior, sqrt(max(extinctionSquared, 0.0)));
}

vec3 openpbr_thin_film_metal_reflectance(
    float incidentCosine,
    float thickness,
    float filmIor,
    vec3 metalF0,
    vec3 metalF82Tint,
    float exteriorIor
) {
    return vec3(
        openpbr_thin_film_reflectance_channel(
            incidentCosine,
            620.0,
            thickness,
            exteriorIor,
            filmIor,
            openpbr_metal_complex_ior(metalF0.r, metalF82Tint.r)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine,
            540.0,
            thickness,
            exteriorIor,
            filmIor,
            openpbr_metal_complex_ior(metalF0.g, metalF82Tint.g)
        ),
        openpbr_thin_film_reflectance_channel(
            incidentCosine,
            450.0,
            thickness,
            exteriorIor,
            filmIor,
            openpbr_metal_complex_ior(metalF0.b, metalF82Tint.b)
        )
    );
}

float openpbr_thin_film_presence(float thickness, float weight) {
    return clamp(weight, 0.0, 1.0) * smoothstep(1e-9, 30.0, thickness);
}

vec3 openpbr_apply_dielectric_thin_film(
    vec3 substrateFresnel,
    float incidentCosine,
    float thickness,
    float filmIor,
    float substrateIor,
    float weight,
    float exteriorIor
) {
    vec3 filmFresnel = openpbr_thin_film_dielectric_reflectance(
        incidentCosine,
        thickness,
        filmIor,
        substrateIor,
        exteriorIor
    );
    return mix(
        substrateFresnel,
        filmFresnel,
        openpbr_thin_film_presence(thickness, weight)
    );
}

vec3 openpbr_apply_metal_thin_film(
    vec3 substrateFresnel,
    float incidentCosine,
    float thickness,
    float filmIor,
    vec3 metalF0,
    vec3 metalF82Tint,
    float weight,
    float exteriorIor
) {
    vec3 filmFresnel = openpbr_thin_film_metal_reflectance(
        incidentCosine,
        thickness,
        filmIor,
        metalF0,
        metalF82Tint,
        exteriorIor
    );
    return mix(
        substrateFresnel,
        filmFresnel,
        openpbr_thin_film_presence(thickness, weight)
    );
}

vec3 openpbr_eval_diffuse(
    OpenPbrResolvedMaterial material,
    vec3 color,
    vec3 viewLocal,
    vec3 lightLocal,
    float specularEnergyCompensation,
    out float pdf
) {
    pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3(0.0);
    }

    float roughness = material.diffuseRoughness;
    float fonConstantA = 0.5 - 2.0 / (3.0 * PI);
    float fonConstantB = 2.0 / 3.0 - 28.0 / (15.0 * PI);
    float muInput = lightLocal.z;
    float muOutput = viewLocal.z;
    float directional = dot(lightLocal, viewLocal) - muInput * muOutput;
    float directionalOverTangent = directional > 0.0
        ? directional / max(max(muInput, muOutput), 1e-7)
        : directional;
    float singleScatterA = 1.0 / (1.0 + fonConstantA * roughness);
    vec3 singleScatter = color * INVPI * singleScatterA
        * (1.0 + roughness * directionalOverTangent);

    float inputComplement = 1.0 - muInput;
    float outputComplement = 1.0 - muOutput;
    float inputGOverPi = inputComplement * (
        0.0571085289 + inputComplement * (
            0.491881867 + inputComplement * (
                -0.332181442 + inputComplement * 0.0714429953
            )
        )
    );
    float outputGOverPi = outputComplement * (
        0.0571085289 + outputComplement * (
            0.491881867 + outputComplement * (
                -0.332181442 + outputComplement * 0.0714429953
            )
        )
    );
    float inputAlbedo = (1.0 + roughness * inputGOverPi)
        / (1.0 + fonConstantA * roughness);
    float outputAlbedo = (1.0 + roughness * outputGOverPi)
        / (1.0 + fonConstantA * roughness);
    float averageAlbedo = singleScatterA * (1.0 + fonConstantB * roughness);
    vec3 multipleScatterAlbedo = color * color * averageAlbedo
        / max(vec3(1e-7), vec3(1.0) - color * (1.0 - averageAlbedo));
    vec3 multipleScatter = multipleScatterAlbedo * INVPI
        * max(1e-7, 1.0 - outputAlbedo)
        * max(1e-7, 1.0 - inputAlbedo)
        / max(1e-7, 1.0 - averageAlbedo);
    pdf = lightLocal.z * INVPI;
    return (singleScatter + multipleScatter) * specularEnergyCompensation;
}

float openpbr_fuzz_directional_albedo(float viewCosine, float roughness) {
    float x = clamp(viewCosine, 0.0, 1.0);
    float y = clamp(roughness, 0.01, 1.0);
    float scale = y * (0.0206607 + 1.58491 * y)
        / (0.0379424 + y * (1.32227 + y));
    float mean = y * (-0.193854 + y * (-1.14885 + y * (1.7932 - 0.95943 * y * y)))
        / (0.046391 + y);
    float offset = y * (0.000654023 + (-0.0207818 + 0.119681 * y) * y)
        / (1.26264 + y * (-1.92021 + y));
    float gaussian = exp(-0.5 * pow((x - mean) / scale, 2.0))
        / (scale * sqrt(2.0 * PI));
    return max(gaussian + offset, 0.0);
}

vec3 openpbr_eval_fuzz(
    OpenPbrResolvedMaterial material,
    vec3 viewLocal,
    vec3 lightLocal,
    out float pdf
) {
    pdf = 0.0;
    if (viewLocal.z <= 0.0 || lightLocal.z <= 0.0) {
        return vec3(0.0);
    }
    float albedo = openpbr_fuzz_directional_albedo(
        viewLocal.z,
        material.fuzzRoughness
    );
    pdf = lightLocal.z * INVPI;
    return material.fuzzColor * albedo * INVPI;
}

vec3 openpbr_eval_microfacet_reflection(
    OpenPbrResolvedMaterial material,
    vec3 viewLocal,
    vec3 lightLocal,
    vec3 halfVector,
    vec3 fresnel,
    out float pdf
) {
    pdf = 0.0;
    if (lightLocal.z <= 0.0) {
        return vec3(0.0);
    }

    vec2 alpha = vec2(material.alphaX, material.alphaY);
    float distribution = sampling_ggx_ndf(halfVector, alpha);
    float masking = sampling_ggx_smith_g1(viewLocal, alpha);
    float maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);

    pdf = masking * distribution / (4.0 * max(viewLocal.z, 1e-8));
    return fresnel * distribution * maskingShadowing
        / (4.0 * max(lightLocal.z * viewLocal.z, 1e-8));
}

vec3 openpbr_eval_microfacet_refraction(
    OpenPbrResolvedMaterial material,
    float relativeIor,
    vec3 tint,
    vec3 viewLocal,
    vec3 lightLocal,
    vec3 halfVector,
    vec3 fresnel,
    out float pdf
) {
    pdf = 0.0;
    if (lightLocal.z >= 0.0) {
        return vec3(0.0);
    }

    float lightHalf = dot(lightLocal, halfVector);
    float viewHalf = dot(viewLocal, halfVector);
    // A refracting microfacet must face the view and the opposite side of the
    // light. Backfacing configurations have no support in the VNDF proposal.
    if (viewHalf <= 0.0 || lightHalf >= 0.0) {
        return vec3(0.0);
    }
    vec2 alpha = vec2(material.alphaX, material.alphaY);
    float distribution = sampling_ggx_ndf(halfVector, alpha);
    float masking = sampling_ggx_smith_g1(viewLocal, alpha);
    float maskingShadowing = masking
        * sampling_ggx_smith_g1(lightLocal, alpha);
    float denominator = lightHalf + viewHalf * relativeIor;
    denominator *= denominator;
    float jacobian = abs(lightHalf) / max(denominator, 1e-8);
    float relativeIorSquared = relativeIor * relativeIor;

    pdf = masking * max(0.0, viewHalf) * distribution * jacobian
        / max(viewLocal.z, 1e-8);
    return tint * (vec3(1.0) - fresnel) * distribution * maskingShadowing
        * abs(viewHalf) * jacobian * relativeIorSquared
        / max(abs(lightLocal.z * viewLocal.z), 1e-8);
}

vec3 openpbr_transmission_tint(OpenPbrResolvedMaterial material) {
#ifdef HAS_MEDIUM
    if (material.mediumType > 0) {
        return vec3(1.0);
    }
#endif
    return material.transmissionColor;
}

float openpbr_thin_wall_fresnel(float singleInterfaceFresnel) {
    return 2.0 * singleInterfaceFresnel / (1.0 + singleInterfaceFresnel);
}

vec3 openpbr_thin_wall_reflection_coefficient(
    vec3 singleInterfaceFresnel,
    float transmissionWeight
) {
    vec3 windowFresnel = 2.0 * singleInterfaceFresnel
        / (vec3(1.0) + singleInterfaceFresnel);
    return mix(
        singleInterfaceFresnel,
        windowFresnel,
        clamp(transmissionWeight, 0.0, 1.0)
    );
}

vec3 openpbr_final_transmission_tint(
    OpenPbrResolvedMaterial material,
    float incidentCosine,
    float etaTOverEtaI
) {
    vec3 tint = openpbr_transmission_tint(material);
    if (!material.thinWalled) {
        return tint;
    }
    float incidentSineSquared = max(0.0, 1.0 - incidentCosine * incidentCosine);
    float transmittedSineSquared = incidentSineSquared
        / max(etaTOverEtaI * etaTOverEtaI, 1e-9);
    if (transmittedSineSquared >= 1.0) {
        return vec3(0.0);
    }
    float transmittedCosine = sqrt(1.0 - transmittedSineSquared);
    return pow(max(tint, vec3(0.0)), vec3(1.0 / max(transmittedCosine, 1e-5)));
}

vec3 openpbr_eval_subsurface_boundary(
    OpenPbrResolvedMaterial material,
    vec3 viewLocal,
    vec3 lightLocal,
    out float pdf
) {
    pdf = 0.0;
    if (viewLocal.z <= 0.0 || lightLocal.z >= 0.0) {
        return vec3(0.0);
    }
    float transmittedCosine = -lightLocal.z;
    float entryFresnel = sampling_dielectric_fresnel(
        viewLocal.z,
        material.relativeIor
    );
    pdf = transmittedCosine * INVPI;
    return vec3(1.0 - entryFresnel) * INVPI;
}

void openpbr_normalize_probabilities(inout OpenPbrPreparedBsdf prepared) {
    float total = prepared.probabilities[OPENPBR_LOBE_FUZZ];
    for (int lobe = 1; lobe < OPENPBR_LOBE_COUNT; lobe++) {
        total += prepared.probabilities[lobe];
    }
    if (total <= 1e-8) {
        for (int lobe = 0; lobe < OPENPBR_LOBE_COUNT; lobe++) {
            prepared.probabilities[lobe] = 0.0;
        }
        return;
    }
    float inverseTotal = 1.0 / total;
    for (int lobe = 0; lobe < OPENPBR_LOBE_COUNT; lobe++) {
        prepared.probabilities[lobe] *= inverseTotal;
    }
}

// Adapted from Adobe c91aad1 impl/openpbr_lobe_utils.h and
// impl/openpbr_bsdf.h::openpbr_prepare_lobes (Apache-2.0).
float openpbr_average_fresnel(float eta) {
    if (abs(eta - 1.0) < 1e-6) { return 0.0; }
    if (eta > 1.0) { return (eta - 1.0) / (4.08567 + 1.00071 * eta); }
    return 0.997118 + 0.1014 * eta - 0.965241 * eta * eta - 0.130607 * eta * eta * eta;
}

vec3 openpbr_metal_average_fresnel(vec3 f0, vec3 tint) {
    float edgeCosine = 1.0 / 7.0;
    vec3 edgeFresnel = mix(f0, vec3(1.0), sampling_schlick_fifth_power(edgeCosine));
    vec3 b = edgeFresnel * (vec3(1.0) - tint) / (edgeCosine * pow(1.0 - edgeCosine, 6.0));
    return clamp(f0 + (vec3(1.0) - f0) / 21.0 - b / 126.0, vec3(0.0), vec3(1.0));
}

// Adobe openpbr_coating_lobe.h: one passage, using the refracted cosine.
// Partial coverage is mixed separately for each passage, as in the reference.
vec3 openpbr_coat_passage(OpenPbrResolvedMaterial material, float cosine) {
    if (cosine <= 0.0) { return vec3(1.0); }
    float refractedCosine = sqrt(max(0.0, 1.0 - (1.0 - cosine * cosine) / (material.coatIor * material.coatIor)));
    vec3 passage = pow(max(material.coatColor, vec3(0.0)), vec3(0.5 / max(refractedCosine, 1e-5)));
    return mix(vec3(1.0), passage, material.coatWeight);
}

float openpbr_coat_energy(OpenPbrResolvedMaterial material, float cosine) {
    if (material.coatRoughness <= ROUGHNESS_MIN) {
        return openpbr_dielectric_fresnel(cosine, 1.0 / material.coatIor);
    }
    // The opaque-dielectric table is the complement of coat directional albedo.
    // Adobe uses the original isotropic alpha (r^2) even for anisotropic GGX.
    return clamp(1.0 - openpbr_opaque_energy_complement(material.coatIor,
        material.coatRoughness * material.coatRoughness, cosine), 0.0, 1.0);
}

vec3 openpbr_coat_darkening(OpenPbrPreparedBsdf prepared) {
    OpenPbrResolvedMaterial material = prepared.material;
    float dielectric = 1.0 - material.baseMetalness;
    float opaque = dielectric * (1.0 - material.transmissionWeight) * (1.0 - material.subsurfaceWeight);
    float sss = dielectric * (1.0 - material.transmissionWeight) * material.subsurfaceWeight;
    float trans = dielectric * material.transmissionWeight;
    float opaqueSpecularity = openpbr_average_fresnel(prepared.specularEtaTOverEtaI);
    float transSpecularity = openpbr_average_fresnel(1.0 / prepared.transmissionReflectionIor);
    float specularity = clamp(opaque * opaqueSpecularity + (sss + trans) * transSpecularity + material.baseMetalness, 0.0, 1.0);
    float effectiveRoughness = mix(1.0, material.specularRoughness, specularity);
    float ks = openpbr_average_fresnel(material.coatIor);
    float kr = 1.0 - (1.0 - ks) / (material.coatIor * material.coatIor);
    float k = mix(ks, kr, effectiveRoughness);
    vec3 eb = material.baseMetalness * material.specularWeight * openpbr_metal_average_fresnel(material.baseWeight * material.baseColor, material.specularColor)
        + opaque * mix(material.baseWeight * material.baseColor, vec3(1.0), opaqueSpecularity)
        + sss * material.subsurfaceColor + vec3(trans);
    vec3 delta = vec3(1.0 - k) / max(vec3(1.0) - eb * k, vec3(1e-6));
    return mix(vec3(1.0), delta, material.coatWeight * material.coatDarkening);
}

vec3 openpbr_coat_base_scale(OpenPbrPreparedBsdf prepared, float lightCosine) {
    if (prepared.material.coatWeight <= 0.0) { return vec3(1.0); }
    if (prepared.material.inside) {
        // Inside only outgoing transmission crosses the coat; no coat reflection.
        return openpbr_coat_passage(prepared.material, -lightCosine);
    }
    // Default reference mode applies energy partition on the view side only.
    return prepared.coatBaseScale * openpbr_coat_passage(prepared.material, lightCosine);
}


OpenPbrBasis openpbr_direction_basis(OpenPbrBasis fallback, vec3 tangent, vec3 bitangent, vec2 direction) {
    vec3 t = tangent - fallback.normal * dot(fallback.normal, tangent);
    if (dot(t, t) < 1e-8) { t = fallback.tangent; }
    t = normalize(t);
    vec3 b = cross(fallback.normal, t) * (dot(cross(fallback.normal, t), bitangent) < 0.0 ? -1.0 : 1.0);
    t = t * direction.x + b * direction.y;
    if (dot(t, t) < 1e-8) { return fallback; }
    OpenPbrBasis basis = fallback;
    basis.tangent = normalize(t);
    basis.bitangent = normalize(cross(basis.normal, basis.tangent));
    basis.tangent = normalize(cross(basis.bitangent, basis.normal));
    return basis;
}

OpenPbrPreparedBsdf openpbr_prepare(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 viewDirection,
    vec3 normal
) {
    OpenPbrPreparedBsdf prepared;
    prepared.material = material;
    prepared.basis = openpbr_make_basis(
        tangent,
        normal,
        max(material.specularAnisotropy, material.coatAnisotropy)
    );
#ifdef USE_MATERIALX_NORMAL_MAPS
    if ((material.anisotropyDirectionEnabled & 2) != 0 && max(material.specularAnisotropy, material.coatAnisotropy) > 0.0) {
      prepared.basis = openpbr_direction_basis(prepared.basis, material.geometryTangent, material.geometryBitangent, vec2(1.0, 0.0));
    }
#endif
    prepared.coatBasis = prepared.basis;
    prepared.directionFrames = false;
#ifdef USE_COAT_NORMAL_FRAMES
    // Adobe c91aad1 openpbr_prepare_lobes: geometry_coat_basis is independent
    // of the base shading basis; coat passage uses the same coat cosine.
    if (material.coatNormalEnabled) {
        prepared.coatBasis = openpbr_make_basis(material.geometryTangent, material.coatNormal, material.coatAnisotropy);
        prepared.directionFrames = true;
    }
#endif
    if (material.specularAnisotropy > 0.0 && (material.anisotropyDirectionEnabled & 1) != 0) {
        prepared.basis = openpbr_direction_basis(prepared.basis, material.directionTangent, material.directionBitangent, material.anisotropyDirection);
        prepared.directionFrames = true;
    }
    if (material.coatAnisotropy > 0.0 && material.coatAnisotropyRotation != 0.0) {
        prepared.coatBasis = openpbr_direction_basis(prepared.coatBasis, material.geometryTangent, material.geometryBitangent, vec2(cos(material.coatAnisotropyRotation), sin(material.coatAnisotropyRotation)));
        prepared.directionFrames = true;
    }
    prepared.viewLocal = openpbr_to_local(prepared.basis, viewDirection);
#ifdef USE_COAT_NORMAL_FRAMES
    prepared.coatViewLocal = openpbr_to_local(prepared.coatBasis, viewDirection);
#endif
    prepared.diffuseColor = material.baseColor;

    float dielectricBaseWeight = 1.0 - material.baseMetalness;
    float opaqueDielectricWeight = dielectricBaseWeight
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
        float weightedCoatIor = 1.0;
        if (!material.inside) { weightedCoatIor = mix(1.0, material.coatIor, material.coatWeight); }
        float weightedBaseIor = weightedCoatIor * openpbr_apply_specular_weight_to_ior(
            material.specularIor / weightedCoatIor, material.specularWeight);
        float reflectionEta = weightedBaseIor / weightedCoatIor;
        if (weightedCoatIor > weightedBaseIor && weightedBaseIor >= 1.0) {
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
    float viewCosine = abs(prepared.viewLocal.z);
    float singleInterfaceFresnel = openpbr_dielectric_fresnel(
        viewCosine,
        1.0 / prepared.specularEtaTOverEtaI
    );
    vec3 dielectricFresnelEstimate = material.specularColor * (
        material.thinWalled
            ? mix(
                singleInterfaceFresnel,
                openpbr_thin_wall_fresnel(singleInterfaceFresnel),
                material.transmissionWeight
            )
            : singleInterfaceFresnel
    );
    vec3 metalFresnelEstimate = material.specularWeight * openpbr_metal_fresnel(
        viewCosine,
        material.baseWeight * material.baseColor,
        material.specularColor
    );
    float transmissionFresnel = material.thinWalled
        ? openpbr_thin_wall_fresnel(openpbr_dielectric_fresnel(viewCosine, prepared.transmissionReflectionIor))
        : openpbr_dielectric_fresnel(viewCosine, prepared.transmissionReflectionIor);
    vec3 transmissionTint = openpbr_final_transmission_tint(
        material,
        viewCosine,
        prepared.refractionEtaTOverEtaI
    );
    float viewEnergyComplement = openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI,
        prepared.specularAlpha,
        viewCosine
    );
    float averageEnergyComplement = openpbr_opaque_average_energy_complement(
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
    prepared.coatBaseScale = vec3(1.0);
    if (material.coatWeight > 0.0 && !material.inside) {
#ifdef USE_COAT_NORMAL_FRAMES
        float coatViewCosine = material.coatNormalEnabled ? max(prepared.coatViewLocal.z, 0.0) : viewCosine;
        float coatEnergy = openpbr_coat_energy(material, coatViewCosine);
#else
        float coatEnergy = openpbr_coat_energy(material, viewCosine);
#endif
        prepared.probabilities[OPENPBR_LOBE_COAT] = prepared.weights[OPENPBR_LOBE_COAT] * coatEnergy;
        prepared.coatBaseScale = openpbr_coat_passage(material,
#ifdef USE_COAT_NORMAL_FRAMES
            coatViewCosine
#else
            viewCosine
#endif
        )
            * (1.0 - prepared.weights[OPENPBR_LOBE_COAT] * coatEnergy) * openpbr_coat_darkening(prepared);
    }
    prepared.probabilities[OPENPBR_LOBE_METAL] = prepared.weights[OPENPBR_LOBE_METAL]
        * openpbr_luminance(metalFresnelEstimate);
    prepared.metalMsScale = vec3(0.0);
    prepared.metalMsFactor = 0.0;
    prepared.metalMsProbability = 0.0;
    if (material.specularRoughness >= 0.04 && prepared.weights[OPENPBR_LOBE_METAL] > 0.0) {
        vec3 averageFresnel = openpbr_metal_average_fresnel(material.baseWeight * material.baseColor, material.specularColor);
        prepared.metalMsScale = material.specularWeight * averageFresnel * averageFresnel;
        float viewLoss = openpbr_metal_energy_complement(prepared.specularAlpha, viewCosine);
        prepared.metalMsFactor = viewLoss / max(openpbr_metal_average_energy_complement(prepared.specularAlpha), 1e-12);
        float msEstimate = prepared.weights[OPENPBR_LOBE_METAL] * openpbr_luminance(prepared.metalMsScale) * viewLoss;
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
    prepared.dielectricMsReflectionScale = vec3(0.0);
    prepared.dielectricMsTransmissionScale = vec3(0.0);
    prepared.dielectricMsViewLoss = 0.0;
    prepared.dielectricMsReflectionRatio = 0.0;
    prepared.dielectricMsProbability = 0.0;
    if (!material.thinWalled && material.transmissionWeight > 0.0 &&
        prepared.specularAlpha >= 0.0016 && prepared.weights[OPENPBR_LOBE_TRANSMISSION] > 0.0 &&
        abs(prepared.refractionEtaTOverEtaI - 1.0) > 1e-6) {
        float nonOpaqueWeight = prepared.weights[OPENPBR_LOBE_TRANSMISSION] + prepared.weights[OPENPBR_LOBE_SUBSURFACE];
        prepared.dielectricMsReflectionScale = (material.inside ? vec3(1.0) : material.specularColor) * nonOpaqueWeight;
        prepared.dielectricMsTransmissionScale = transmissionTint * prepared.weights[OPENPBR_LOBE_TRANSMISSION]
            + vec3(prepared.weights[OPENPBR_LOBE_SUBSURFACE]);
        prepared.dielectricMsReflectionRatio = openpbr_ideal_dielectric_reflection_ratio(prepared.refractionEtaTOverEtaI, prepared.specularAlpha);
        prepared.dielectricMsViewLoss = openpbr_ideal_dielectric_loss(prepared.refractionEtaTOverEtaI, prepared.specularAlpha, viewCosine);
        vec3 averageScale = mix(prepared.dielectricMsTransmissionScale, prepared.dielectricMsReflectionScale, prepared.dielectricMsReflectionRatio);
        float msEstimate = openpbr_luminance(averageScale) * prepared.dielectricMsViewLoss;
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
    if (material.coatWeight > 0.0 && material.thinFilmWeight > 0.0) {
        float filmSupport = 0.02 * openpbr_thin_film_presence(material.thinFilmThickness, material.thinFilmWeight);
        prepared.probabilities[OPENPBR_LOBE_SPECULAR] = max(prepared.probabilities[OPENPBR_LOBE_SPECULAR], prepared.weights[OPENPBR_LOBE_SPECULAR] * filmSupport);
        prepared.probabilities[OPENPBR_LOBE_METAL] = max(prepared.probabilities[OPENPBR_LOBE_METAL], prepared.weights[OPENPBR_LOBE_METAL] * material.specularWeight * filmSupport);
    }
    if (material.coatWeight > 0.0 && !material.inside) {
        float baseScale = max(max(prepared.coatBaseScale.x, prepared.coatBaseScale.y), prepared.coatBaseScale.z);
        prepared.probabilities[OPENPBR_LOBE_METAL] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_SPECULAR] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_DIFFUSE] *= baseScale;
        prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] *= baseScale;
    }
    openpbr_normalize_probabilities(prepared);
    return prepared;
}

float openpbr_substrate_fresnel(OpenPbrPreparedBsdf prepared, float cosine, bool reflection) {
    if (prepared.material.coatWeight <= 0.0) {
        return openpbr_dielectric_fresnel(cosine, prepared.material.relativeIor);
    }
    float transFresnel = openpbr_dielectric_fresnel(cosine, prepared.transmissionReflectionIor);
    if (!reflection) { return transFresnel; }
    float opaqueFresnel = openpbr_dielectric_fresnel(cosine, 1.0 / prepared.specularEtaTOverEtaI);
    float nonOpaque = prepared.material.transmissionWeight + (1.0 - prepared.material.transmissionWeight) * prepared.material.subsurfaceWeight;
    return mix(opaqueFresnel, transFresnel, nonOpaque);
}

vec3 openpbr_eval_prepared(
    OpenPbrPreparedBsdf prepared,
    vec3 lightDirection,
    out float pdf
) {
    OpenPbrResolvedMaterial material = prepared.material;
    vec3 viewLocal = prepared.viewLocal;
    vec3 lightLocal = openpbr_to_local(prepared.basis, lightDirection);
    bool reflection = lightLocal.z * viewLocal.z > 0.0;
#ifdef USE_COAT_NORMAL_FRAMES
    bool independentCoat = material.coatNormalEnabled;
    bool geometricReflection = dot(material.geometricNormal, lightDirection) > 0.0;
    float coatLightCosine = dot(prepared.coatBasis.normal, lightDirection);
    bool coatReflection = geometricReflection && prepared.coatViewLocal.z > 0.0 && coatLightCosine > 0.0;
#endif

    vec3 halfVector;
    if (reflection) {
        halfVector = normalize(lightLocal + viewLocal);
    }
    else {
        halfVector = normalize(lightLocal + viewLocal * material.relativeIor);
    }
    if (halfVector.z < 0.0) {
        halfVector = -halfVector;
    }

    vec3 response = vec3(0.0);
    pdf = 0.0;
    float lobePdf = 0.0;
    float viewHalf = abs(dot(viewLocal, halfVector));
    float diffuseSpecularEnergyCompensation =
        prepared.diffuseSpecularEnergyCompensation
        * openpbr_opaque_energy_complement(
            prepared.specularEtaTOverEtaI,
            prepared.specularAlpha,
            abs(lightLocal.z)
        );

#ifdef USE_COAT_NORMAL_FRAMES
    if (!independentCoat || (lightLocal.z != 0.0 && reflection == geometricReflection)) {
#endif
    if (reflection) {
        if (prepared.weights[OPENPBR_LOBE_DIFFUSE] > 0.0) {
            response += prepared.weights[OPENPBR_LOBE_DIFFUSE] * openpbr_eval_diffuse(
                material,
                prepared.diffuseColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                lobePdf
            );
            pdf += prepared.probabilities[OPENPBR_LOBE_DIFFUSE] * lobePdf;
        }

        if (prepared.weights[OPENPBR_LOBE_SUBSURFACE] > 0.0 && material.thinWalled) {
            response += 0.5 * prepared.weights[OPENPBR_LOBE_SUBSURFACE] * openpbr_eval_diffuse(
                material,
                material.subsurfaceColor,
                viewLocal,
                lightLocal,
                diffuseSpecularEnergyCompensation,
                lobePdf
            );
            pdf += prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] * 0.5 * lobePdf;
        }

        if (prepared.weights[OPENPBR_LOBE_SPECULAR] > 0.0) {
            vec3 dielectricFresnel = vec3(openpbr_substrate_fresnel(prepared, viewHalf, true));
            if (material.thinFilmWeight > 0.0) {
                dielectricFresnel = openpbr_apply_dielectric_thin_film(
                    dielectricFresnel,
                    viewHalf,
                    material.thinFilmThickness,
                    material.thinFilmIor,
                    prepared.thinFilmBaseIor,
                    material.thinFilmWeight,
                    prepared.thinFilmExteriorIor
                );
            }
            if (material.thinWalled) {
                dielectricFresnel = openpbr_thin_wall_reflection_coefficient(
                    dielectricFresnel,
                    material.transmissionWeight
                );
            }
            vec3 fresnel = material.specularColor * dielectricFresnel;
            response += prepared.weights[OPENPBR_LOBE_SPECULAR] * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                lobePdf
            );
            pdf += prepared.probabilities[OPENPBR_LOBE_SPECULAR] * lobePdf;
        }

        if (prepared.weights[OPENPBR_LOBE_METAL] > 0.0) {
            vec3 fresnel = openpbr_metal_fresnel(
                viewHalf,
                material.baseWeight * material.baseColor,
                material.specularColor
            );
            if (material.thinFilmWeight > 0.0) {
                fresnel = openpbr_apply_metal_thin_film(
                    fresnel,
                    viewHalf,
                    material.thinFilmThickness,
                    material.thinFilmIor,
                    material.baseWeight * material.baseColor,
                    material.specularColor,
                    material.thinFilmWeight,
                    prepared.thinFilmExteriorIor
                );
            }
            fresnel *= material.specularWeight;
            response += prepared.weights[OPENPBR_LOBE_METAL] * openpbr_eval_microfacet_reflection(
                material,
                viewLocal,
                lightLocal,
                halfVector,
                fresnel,
                lobePdf
            );
            if (prepared.metalMsFactor > 0.0) {
                float factor = min(prepared.metalMsFactor * openpbr_metal_energy_complement(prepared.specularAlpha, lightLocal.z), 1.0 / max(lightLocal.z, 1e-8));
                response += prepared.weights[OPENPBR_LOBE_METAL] * prepared.metalMsScale * factor * INVPI;
                lobePdf = mix(lobePdf, 0.5 * INVPI, prepared.metalMsProbability);
            }
            pdf += prepared.probabilities[OPENPBR_LOBE_METAL] * lobePdf;
        }
    }
    else {
        vec3 fresnel = vec3(openpbr_substrate_fresnel(prepared, viewHalf, false));
        if (material.thinFilmWeight > 0.0) {
            fresnel = openpbr_apply_dielectric_thin_film(
                fresnel,
                viewHalf,
                material.thinFilmThickness,
                material.thinFilmIor,
                prepared.thinFilmBaseIor,
                material.thinFilmWeight,
                prepared.thinFilmExteriorIor
            );
        }
        if (prepared.weights[OPENPBR_LOBE_TRANSMISSION] > 0.0) {
            if (material.thinWalled) {
                vec3 mirroredLight = vec3(lightLocal.xy, -lightLocal.z);
                vec3 thinWallHalf = normalize(mirroredLight + viewLocal);
                if (thinWallHalf.z < 0.0) {
                    thinWallHalf = -thinWallHalf;
                }
                float thinWallViewHalf = abs(dot(viewLocal, thinWallHalf));
                vec3 thinWallFresnel = vec3(openpbr_substrate_fresnel(prepared, thinWallViewHalf, false));
                if (material.thinFilmWeight > 0.0) {
                    thinWallFresnel = openpbr_apply_dielectric_thin_film(
                        thinWallFresnel,
                        thinWallViewHalf,
                        material.thinFilmThickness,
                        material.thinFilmIor,
                        prepared.thinFilmBaseIor,
                        material.thinFilmWeight,
                        prepared.thinFilmExteriorIor
                    );
                }
                vec3 windowFresnel = openpbr_thin_wall_reflection_coefficient(
                    thinWallFresnel,
                    1.0
                );
                vec3 tint = openpbr_final_transmission_tint(
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
                        tint * (vec3(1.0) - windowFresnel),
                        lobePdf
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
                        lobePdf
                    );
            }
            if (prepared.dielectricMsProbability > 0.0) {
                lobePdf *= 1.0 - prepared.dielectricMsProbability;
            }
            pdf += prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] * lobePdf;
        }
        if (prepared.weights[OPENPBR_LOBE_SUBSURFACE] > 0.0) {
            if (material.thinWalled) {
                vec3 flippedLight = vec3(lightLocal.xy, -lightLocal.z);
                response += 0.5 * prepared.weights[OPENPBR_LOBE_SUBSURFACE]
                    * openpbr_eval_diffuse(
                        material,
                        material.subsurfaceColor,
                        viewLocal,
                        flippedLight,
                        diffuseSpecularEnergyCompensation,
                        lobePdf
                    );
                lobePdf *= 0.5;
            }
            else {
                response += prepared.weights[OPENPBR_LOBE_SUBSURFACE] * openpbr_eval_subsurface_boundary(
                    material,
                    viewLocal,
                    lightLocal,
                    lobePdf
                );
            }
            pdf += prepared.probabilities[OPENPBR_LOBE_SUBSURFACE] * lobePdf;
        }
    }

    // Reference value includes the hemisphere ratio before the grazing clamp.
    // Reference scale_trans has no extra eta^2 factor; single refraction keeps
    // its existing radiance Jacobian. Both proposals share the aggregate PDF.
    if (prepared.dielectricMsProbability > 0.0) {
        float cosine = abs(lightLocal.z);
        if (cosine > 0.0) {
            float ior = (reflection ? prepared.refractionEtaTOverEtaI : 1.0 / prepared.refractionEtaTOverEtaI);
            float ratio = (reflection ? prepared.dielectricMsReflectionRatio : 1.0 - prepared.dielectricMsReflectionRatio);
            float factors = prepared.dielectricMsViewLoss * openpbr_ideal_dielectric_loss(ior, prepared.specularAlpha, cosine)
                / max(openpbr_ideal_dielectric_average_loss(ior, prepared.specularAlpha), 1e-12);
            float factor = min(factors * ratio, 1.0 / cosine);
            vec3 scale = (reflection ? prepared.dielectricMsReflectionScale : prepared.dielectricMsTransmissionScale);
            response += scale * factor * INVPI;
            pdf += prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] * prepared.dielectricMsProbability * ratio * 0.5 * INVPI;
        }
    }

#ifdef USE_COAT_NORMAL_FRAMES
    } // base hemisphere support
#endif
    if (material.coatWeight > 0.0) {
        response *= openpbr_coat_base_scale(prepared,
#ifdef USE_COAT_NORMAL_FRAMES
            independentCoat ? coatLightCosine : lightLocal.z
#else
            lightLocal.z
#endif
        );
    }
#ifdef USE_COAT_NORMAL_FRAMES
    if (independentCoat) { response *= abs(lightLocal.z); }
#endif

    if (
#ifdef USE_COAT_NORMAL_FRAMES
        (independentCoat ? coatReflection : reflection)
#else
        reflection
#endif
        && prepared.weights[OPENPBR_LOBE_COAT] > 0.0) {
        vec3 coatView = viewLocal;
        vec3 coatLight = lightLocal;
        vec3 coatHalf = halfVector;
        float coatViewHalf = viewHalf;
        if (prepared.directionFrames) {
            coatView = openpbr_to_local(prepared.coatBasis, openpbr_to_world(prepared.basis, viewLocal));
#ifdef USE_COAT_NORMAL_FRAMES
            if (independentCoat) { coatView = prepared.coatViewLocal; }
#endif
            coatLight = openpbr_to_local(prepared.coatBasis, lightDirection);
            coatHalf = normalize(coatLight + coatView);
            if (coatHalf.z < 0.0) { coatHalf = -coatHalf; }
            coatViewHalf = abs(dot(coatView, coatHalf));
        }

        vec3 coatFresnel = vec3(openpbr_dielectric_fresnel(
            coatViewHalf,
            1.0 / material.coatIor
        ));
        OpenPbrResolvedMaterial coatMaterial = material;
        vec2 coatAlpha = openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy);
        coatMaterial.alphaX = coatAlpha.x;
        coatMaterial.alphaY = coatAlpha.y;
        response += prepared.weights[OPENPBR_LOBE_COAT]
#ifdef USE_COAT_NORMAL_FRAMES
            * (independentCoat ? max(coatLightCosine, 0.0) : 1.0)
#endif
            * openpbr_eval_microfacet_reflection(
            coatMaterial,
            coatView,
            coatLight,
            coatHalf,
            coatFresnel,
            lobePdf
        );
        pdf += prepared.probabilities[OPENPBR_LOBE_COAT] * lobePdf;
    }

    if (
#ifdef USE_COAT_NORMAL_FRAMES
        (independentCoat ? geometricReflection : reflection)
#else
        reflection
#endif
        && prepared.weights[OPENPBR_LOBE_FUZZ] > 0.0) {
        float fuzzAlbedo = openpbr_fuzz_directional_albedo(
            abs(viewLocal.z),
            material.fuzzRoughness
        );
        response *= max(
            vec3(0.0),
            vec3(1.0 - prepared.weights[OPENPBR_LOBE_FUZZ] * fuzzAlbedo)
        );
        response += prepared.weights[OPENPBR_LOBE_FUZZ]
#ifdef USE_COAT_NORMAL_FRAMES
            * (independentCoat ? max(lightLocal.z, 0.0) : 1.0)
#endif
            * openpbr_eval_fuzz(
            material,
            viewLocal,
            lightLocal,
            lobePdf
        );
        pdf += prepared.probabilities[OPENPBR_LOBE_FUZZ] * lobePdf;
    }

#ifdef USE_COAT_NORMAL_FRAMES
    if (independentCoat) { return response; }
#endif
    return response * abs(lightLocal.z);
}

vec3 openpbr_eval(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 viewDirection,
    vec3 normal,
    vec3 lightDirection,
    out float pdf
) {
    OpenPbrPreparedBsdf prepared = openpbr_prepare(
        tangent,
        material,
        viewDirection,
        normal
    );
    return openpbr_eval_prepared(prepared, lightDirection, pdf);
}

float openpbr_pdf(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 viewDirection,
    vec3 normal,
    vec3 lightDirection
) {
    float pdf;
    openpbr_eval(
        tangent,
        material,
        viewDirection,
        normal,
        lightDirection,
        pdf
    );
    return pdf;
}

vec3 openpbr_sample_prepared(
    OpenPbrPreparedBsdf prepared,
    vec3 randomSamples,
    out vec3 lightDirection,
    out float pdf,
    out bool isTransmissionEvent
) {
    OpenPbrResolvedMaterial material = prepared.material;
    vec3 viewLocal = prepared.viewLocal;
    float randomX = randomSamples.x;
    float randomY = randomSamples.y;
    float lobeSample = randomSamples.z;
    pdf = 0.0;
    isTransmissionEvent = false;
    lightDirection = prepared.basis.normal;

    // At eta=1 the solid-refraction half vector is the zero vector. Treat the
    // physically null interface as straight, unit-throughput transmission.
    if (!prepared.material.thinWalled &&
        abs(prepared.material.relativeIor - 1.0) <= 1e-6 &&
        prepared.probabilities[OPENPBR_LOBE_TRANSMISSION] >= 1.0 - 1e-6) {
        lightDirection = openpbr_to_world(prepared.basis, -viewLocal);
        pdf = 1.0;
        isTransmissionEvent = true;
        return (openpbr_transmission_tint(prepared.material) * openpbr_coat_base_scale(prepared,
#ifdef USE_COAT_NORMAL_FRAMES
            prepared.material.coatNormalEnabled ? dot(prepared.coatBasis.normal, lightDirection) : -prepared.viewLocal.z
#else
            -prepared.viewLocal.z
#endif
        ));
    }

    float cdf[OPENPBR_LOBE_COUNT];
    cdf[OPENPBR_LOBE_FUZZ] = prepared.probabilities[OPENPBR_LOBE_FUZZ];
    for (int lobe = 1; lobe < OPENPBR_LOBE_COUNT; lobe++) {
        cdf[lobe] = cdf[lobe - 1] + prepared.probabilities[lobe];
    }
    if (cdf[OPENPBR_LOBE_SUBSURFACE] <= 0.0) {
        return vec3(0.0);
    }

    vec3 lightLocal;
    if (lobeSample < cdf[OPENPBR_LOBE_FUZZ] || (
        lobeSample >= cdf[OPENPBR_LOBE_TRANSMISSION] && lobeSample < cdf[OPENPBR_LOBE_DIFFUSE]
    )) {
        lightLocal = sampling_cosine_hemisphere(vec2(randomX, randomY));
    }
    else if (lobeSample < cdf[OPENPBR_LOBE_COAT]) {
        vec3 coatView = viewLocal;
        if (prepared.directionFrames) { coatView = openpbr_to_local(prepared.coatBasis, openpbr_to_world(prepared.basis, viewLocal)); }
#ifdef USE_COAT_NORMAL_FRAMES
        if (material.coatNormalEnabled) { coatView = prepared.coatViewLocal; }
#endif
        vec3 halfVector = sampling_ggx_visible_normal(
            coatView,
            // The VNDF must use the same alpha as the evaluated coat PDF.
            openpbr_roughness_to_alpha(material.coatRoughness, material.coatAnisotropy),
            vec2(randomX, randomY)
        );
        if (halfVector.z < 0.0) {
            halfVector = -halfVector;
        }
        lightLocal = normalize(reflect(-coatView, halfVector));
#ifdef USE_COAT_NORMAL_FRAMES
        if (material.coatNormalEnabled) {
            lightDirection = openpbr_to_world(prepared.coatBasis, lightLocal);
            if (lightLocal.z <= 0.0 || dot(material.geometricNormal, lightDirection) <= 0.0) { return vec3(0.0); }
            return openpbr_eval_prepared(prepared, lightDirection, pdf);
        }
#endif
        if (prepared.directionFrames) { lightLocal = openpbr_to_local(prepared.basis, openpbr_to_world(prepared.coatBasis, lightLocal)); }
    }
    else if (lobeSample < cdf[OPENPBR_LOBE_SPECULAR]) {
        bool isMetal = lobeSample < cdf[OPENPBR_LOBE_METAL];
        float metalDraw = (lobeSample - cdf[OPENPBR_LOBE_COAT]) / max(prepared.probabilities[OPENPBR_LOBE_METAL], 1e-12);
        if (isMetal && metalDraw < prepared.metalMsProbability) {
            float z = randomX;
            float radial = sqrt(max(0.0, 1.0 - z * z));
            float azimuth = TWOPI * randomY;
            lightLocal = vec3(radial * cos(azimuth), radial * sin(azimuth), z);
        }
        else {
            vec3 halfVector = sampling_ggx_visible_normal(
                viewLocal,
                vec2(material.alphaX, material.alphaY),
                vec2(randomX, randomY)
            );
            if (halfVector.z < 0.0) {
                halfVector = -halfVector;
            }
            lightLocal = normalize(reflect(-viewLocal, halfVector));
        }
    }
    else if (lobeSample < cdf[OPENPBR_LOBE_TRANSMISSION]) {
        isTransmissionEvent = true;
        // Split the existing BSDF_LOBE interval. BSDF_DIRECTION retains its
        // two dimensions; rand.x selects and remaps the reference hemisphere.
        float msDraw = (lobeSample - cdf[OPENPBR_LOBE_SPECULAR]) / max(prepared.probabilities[OPENPBR_LOBE_TRANSMISSION], 1e-12);
        if (prepared.dielectricMsProbability > 0.0 && msDraw < prepared.dielectricMsProbability) {
            float ratio = prepared.dielectricMsReflectionRatio;
            bool reflectMs = randomX < ratio;
            float z;
            if (reflectMs) { z = min(randomX / ratio, 0.99999994); }
            else { z = -min((randomX - ratio) / (1.0 - ratio), 0.99999994); }
            float radial = sqrt(max(0.0, 1.0 - z * z));
            float azimuth = TWOPI * randomY;
            lightLocal = vec3(radial * cos(azimuth), radial * sin(azimuth), z);
            isTransmissionEvent = !reflectMs;
        }
        else {
            vec3 halfVector = sampling_ggx_visible_normal(
                viewLocal,
                vec2(material.alphaX, material.alphaY),
                vec2(randomX, randomY)
            );
            if (halfVector.z < 0.0) {
                halfVector = -halfVector;
            }
            float viewHalf = abs(dot(viewLocal, halfVector));
            vec3 fresnel = vec3(openpbr_dielectric_fresnel(
                viewHalf,
                prepared.material.relativeIor
            ));
            if (material.thinFilmWeight > 0.0) {
                fresnel = openpbr_apply_dielectric_thin_film(
                    fresnel,
                    viewHalf,
                    material.thinFilmThickness,
                    material.thinFilmIor,
                    prepared.thinFilmBaseIor,
                    material.thinFilmWeight,
                    prepared.thinFilmExteriorIor
                );
            }
            if (material.thinWalled) {
                vec3 reflectedLocal = normalize(reflect(-viewLocal, halfVector));
                lightLocal = vec3(reflectedLocal.xy, -reflectedLocal.z);
            }
            else {
                lightLocal = refract(
                    -viewLocal,
                    halfVector,
                    prepared.material.relativeIor
                );
                if (dot(lightLocal, lightLocal) <= 1e-8) {
                    isTransmissionEvent = false;
                    return vec3(0.0);
                }
                lightLocal = normalize(lightLocal);
            }
        }
    }
    else {
        isTransmissionEvent = true;
        if (material.thinWalled) {
            float hemisphereSample = randomX;
            bool transmit = hemisphereSample >= 0.5;
            randomX = transmit
                ? (hemisphereSample - 0.5) * 2.0
                : hemisphereSample * 2.0;
            lightLocal = sampling_cosine_hemisphere(vec2(randomX, randomY));
            if (transmit) {
                lightLocal.z = -lightLocal.z;
            }
            else {
                isTransmissionEvent = false;
            }
        }
        else {
            lightLocal = sampling_cosine_hemisphere(vec2(randomX, randomY));
            lightLocal.z = -lightLocal.z;
        }
    }

    lightDirection = openpbr_to_world(prepared.basis, lightLocal);
    // Reject VNDF draws on the wrong side before aggregate BSDF evaluation.
    if (lightLocal.z == 0.0 || (lightLocal.z < 0.0) != isTransmissionEvent) {
        return vec3(0.0);
    }
#ifdef USE_COAT_NORMAL_FRAMES
    if (material.coatNormalEnabled &&
        ((dot(material.geometricNormal, lightDirection) <= 0.0) != isTransmissionEvent)) { return vec3(0.0); }
#endif
    return openpbr_eval_prepared(prepared, lightDirection, pdf);
}

vec3 openpbr_sample(
    vec3 tangent,
    OpenPbrResolvedMaterial material,
    vec3 randomSamples,
    vec3 viewDirection,
    vec3 normal,
    out vec3 lightDirection,
    out float pdf,
    out bool isTransmissionEvent
) {
    OpenPbrPreparedBsdf prepared = openpbr_prepare(tangent, material, viewDirection, normal);
    return openpbr_sample_prepared(prepared, randomSamples, lightDirection, pdf, isTransmissionEvent);
}`;
