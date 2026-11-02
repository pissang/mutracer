import { glsl } from '../../shader.js';

export default glsl`
// The GGX distribution and spherical-cap VNDF sampler are adapted from
// adobe/openpbr-bsdf, Copyright 2026 Adobe, Apache-2.0. Other routines are
// project implementations of their stated analytic distributions.

vec3 sampling_ggx_visible_normal(vec3 view, vec2 alpha, vec2 samplePoint) {
    vec3 stretch = vec3(alpha, 1.0);
    vec3 sphericalView = normalize(stretch * view);
    float viewZ = min(sphericalView.z, 1.0);
    float capSpan = 1.0 + viewZ;
    float normalZ = (1.0 - samplePoint.y) * capSpan;
    float oneMinusZ = samplePoint.y * capSpan;
    float onePlusZ = normalZ + (1.0 - viewZ);
    float radial = sqrt(max(0.0, onePlusZ * oneMinusZ));
    float azimuth = TWOPI * samplePoint.x;
    vec3 sphericalNormal = vec3(
        sphericalView.x + radial * cos(azimuth),
        sphericalView.y + radial * sin(azimuth),
        normalZ
    );
    return normalize(stretch * sphericalNormal);
}

float sampling_ggx_ndf(vec3 halfway, vec2 alpha) {
    vec3 ellipsoidNormal = vec3(
        halfway.x / alpha.x,
        halfway.y / alpha.y,
        halfway.z
    );
    float denominator = dot(ellipsoidNormal, ellipsoidNormal);
    return 1.0 / (
        PI * alpha.x * alpha.y * denominator * denominator
    );
}

float sampling_ggx_smith_g1(vec3 direction, vec2 alpha) {
    float normalComponent = abs(direction.z);
    if (normalComponent <= 1e-8) {
        return 0.0;
    }
    vec2 roughDirection = alpha * direction.xy;
    float tanThetaSquared = dot(roughDirection, roughDirection)
        / (normalComponent * normalComponent);
    return 2.0 / (1.0 + sqrt(1.0 + tanThetaSquared));
}

float sampling_schlick_fifth_power(float cosine) {
    float complement = clamp(1.0 - cosine, 0.0, 1.0);
    return pow(complement, 5.0);
}

float sampling_dielectric_fresnel(float incidentCosine, float etaIOverEtaT) {
    float cosineI = clamp(abs(incidentCosine), 0.0, 1.0);
    float sineTSquared = etaIOverEtaT * etaIOverEtaT
        * max(0.0, 1.0 - cosineI * cosineI);
    if (sineTSquared >= 1.0) {
        return 1.0;
    }

    float cosineT = sqrt(max(0.0, 1.0 - sineTSquared));
    float perpendicular = (cosineI - etaIOverEtaT * cosineT)
        / max(cosineI + etaIOverEtaT * cosineT, 1e-8);
    float parallel = (etaIOverEtaT * cosineI - cosineT)
        / max(etaIOverEtaT * cosineI + cosineT, 1e-8);
    return 0.5 * (
        perpendicular * perpendicular + parallel * parallel
    );
}

vec2 sampling_concentric_disk(vec2 samplePoint) {
    vec2 offset = 2.0 * samplePoint - vec2(1.0);
    if (offset.x == 0.0 && offset.y == 0.0) {
        return vec2(0.0);
    }

    float radius;
    float angle;
    if (abs(offset.x) > abs(offset.y)) {
        radius = offset.x;
        angle = 0.25 * PI * (offset.y / offset.x);
    }
    else {
        radius = offset.y;
        angle = 0.5 * PI - 0.25 * PI * (offset.x / offset.y);
    }
    return radius * vec2(cos(angle), sin(angle));
}

vec3 sampling_cosine_hemisphere(vec2 samplePoint) {
    vec2 diskPoint = sampling_concentric_disk(samplePoint);
    return vec3(
        diskPoint,
        sqrt(max(0.0, 1.0 - dot(diskPoint, diskPoint)))
    );
}

float sampling_power_heuristic(float firstPdf, float secondPdf) {
    float scale = max(firstPdf, secondPdf);
    if (scale <= 0.0) {
        return 0.0;
    }
    vec2 normalized = vec2(firstPdf, secondPdf) / scale;
    vec2 squared = normalized * normalized;
    return squared.x / (squared.x + squared.y);
}

void sampling_orthonormal_basis(in vec3 normal, out vec3 tangent, out vec3 bitangent) {
    float signZ = normal.z >= 0.0 ? 1.0 : -1.0;
    float factor = -1.0 / (signZ + normal.z);
    float xy = normal.x * normal.y * factor;
    tangent = vec3(
        1.0 + signZ * normal.x * normal.x * factor,
        signZ * xy,
        -signZ * normal.x
    );
    bitangent = vec3(
        xy,
        signZ + normal.y * normal.y * factor,
        -normal.y
    );
}

vec3 sampling_spectral_rgb_filter(vec3 rgb, int channel) {
    if (channel == 0) {
        return rgb;
    }
    vec3 channelMask = vec3(0.0);
    channelMask[channel - 1] = 1.0;
    return rgb * channelMask;
}

float sampling_cauchy_ior(
    float wavelength,
    float referenceIor,
    float dispersionScale,
    float abbeNumber
) {
    if (wavelength == 0.0 || dispersionScale <= 0.0) {
        return referenceIor;
    }

    const float FRAUNHOFER_C = 656.3;
    const float FRAUNHOFER_D = 587.6;
    const float FRAUNHOFER_F = 486.1;
    float inverseDifference = 1.0 / (
        1.0 / (FRAUNHOFER_F * FRAUNHOFER_F)
        - 1.0 / (FRAUNHOFER_C * FRAUNHOFER_C)
    );
    float effectiveAbbe = max(abbeNumber / dispersionScale, 1e-6);
    float cauchyB = (referenceIor - 1.0) * inverseDifference / effectiveAbbe;
    float cauchyA = referenceIor
        - cauchyB / (FRAUNHOFER_D * FRAUNHOFER_D);
    return cauchyA + cauchyB / (wavelength * wavelength);
}

vec3 sampling_henyey_greenstein(
    vec3 forwardDirection,
    float anisotropy,
    vec2 samplePoint
) {
    float cosine;
    if (abs(anisotropy) < 0.001) {
        cosine = 1.0 - 2.0 * samplePoint.y;
    }
    else {
        float ratio = (1.0 - anisotropy * anisotropy)
            / (1.0 + anisotropy - 2.0 * anisotropy * samplePoint.y);
        cosine = (
            ratio * ratio - 1.0 - anisotropy * anisotropy
        ) / (2.0 * anisotropy);
    }

    float sine = sqrt(max(0.0, 1.0 - cosine * cosine));
    float azimuth = TWOPI * samplePoint.x;
    vec3 tangent;
    vec3 bitangent;
    sampling_orthonormal_basis(forwardDirection, tangent, bitangent);
    return tangent * (sine * cos(azimuth))
        + bitangent * (sine * sin(azimuth))
        + forwardDirection * cosine;
}

float sampling_henyey_greenstein_phase(float cosine, float anisotropy) {
    float denominator = 1.0 + anisotropy * anisotropy
        + 2.0 * anisotropy * cosine;
    return INV4PI * (1.0 - anisotropy * anisotropy)
        / (denominator * sqrt(denominator));
}
`;
