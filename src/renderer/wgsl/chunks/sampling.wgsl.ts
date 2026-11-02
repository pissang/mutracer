export default /*wgsl*/ `
// The GGX distribution and spherical-cap VNDF sampler are adapted from
// adobe/openpbr-bsdf, Copyright 2026 Adobe, Apache-2.0. Other routines are
// project implementations of their stated analytic distributions.

fn sampling_ggx_visible_normal(view: vec3f, alpha: vec2f, samplePoint: vec2f) -> vec3f {
    let stretch = vec3f(alpha, 1.0);
    let sphericalView = normalize(stretch * view);
    let viewZ = min(sphericalView.z, 1.0);
    let capSpan = 1.0 + viewZ;
    let normalZ = (1.0 - samplePoint.y) * capSpan;
    let oneMinusZ = samplePoint.y * capSpan;
    let onePlusZ = normalZ + (1.0 - viewZ);
    let radial = sqrt(max(0.0, onePlusZ * oneMinusZ));
    let azimuth = TWOPI * samplePoint.x;
    let sphericalNormal = vec3f(
        sphericalView.x + radial * cos(azimuth),
        sphericalView.y + radial * sin(azimuth),
        normalZ
    );
    return normalize(stretch * sphericalNormal);
}

fn sampling_ggx_ndf(halfway: vec3f, alpha: vec2f) -> f32 {
    let ellipsoidNormal = vec3f(
        halfway.x / alpha.x,
        halfway.y / alpha.y,
        halfway.z
    );
    let denominator = dot(ellipsoidNormal, ellipsoidNormal);
    return 1.0 / (
        PI * alpha.x * alpha.y * denominator * denominator
    );
}

fn sampling_ggx_smith_g1(direction: vec3f, alpha: vec2f) -> f32 {
    let normalComponent = abs(direction.z);
    if (normalComponent <= 1e-8) {
        return 0.0;
    }
    let roughDirection = alpha * direction.xy;
    let tanThetaSquared = dot(roughDirection, roughDirection)
        / (normalComponent * normalComponent);
    return 2.0 / (1.0 + sqrt(1.0 + tanThetaSquared));
}

fn sampling_schlick_fifth_power(cosine: f32) -> f32 {
    let complement = clamp(1.0 - cosine, 0.0, 1.0);
    return pow(complement, 5.0);
}

fn sampling_dielectric_fresnel(incidentCosine: f32, etaIOverEtaT: f32) -> f32 {
    let cosineI = clamp(abs(incidentCosine), 0.0, 1.0);
    let sineTSquared = etaIOverEtaT * etaIOverEtaT
        * max(0.0, 1.0 - cosineI * cosineI);
    if (sineTSquared >= 1.0) {
        return 1.0;
    }

    let cosineT = sqrt(max(0.0, 1.0 - sineTSquared));
    let perpendicular = (cosineI - etaIOverEtaT * cosineT)
        / max(cosineI + etaIOverEtaT * cosineT, 1e-8);
    let parallel = (etaIOverEtaT * cosineI - cosineT)
        / max(etaIOverEtaT * cosineI + cosineT, 1e-8);
    return 0.5 * (
        perpendicular * perpendicular + parallel * parallel
    );
}

fn sampling_concentric_disk(samplePoint: vec2f) -> vec2f {
    let offset = 2.0 * samplePoint - vec2f(1.0);
    if (offset.x == 0.0 && offset.y == 0.0) {
        return vec2f(0.0);
    }

    var radius: f32;
    var angle: f32;
    if (abs(offset.x) > abs(offset.y)) {
        radius = offset.x;
        angle = 0.25 * PI * (offset.y / offset.x);
    }
    else {
        radius = offset.y;
        angle = 0.5 * PI - 0.25 * PI * (offset.x / offset.y);
    }
    return radius * vec2f(cos(angle), sin(angle));
}

fn sampling_cosine_hemisphere(samplePoint: vec2f) -> vec3f {
    let diskPoint = sampling_concentric_disk(samplePoint);
    return vec3f(
        diskPoint,
        sqrt(max(0.0, 1.0 - dot(diskPoint, diskPoint)))
    );
}

fn sampling_power_heuristic(firstPdf: f32, secondPdf: f32) -> f32 {
    let scale = max(firstPdf, secondPdf);
    if (scale <= 0.0) {
        return 0.0;
    }
    let normalized = vec2f(firstPdf, secondPdf) / scale;
    let squared = normalized * normalized;
    return squared.x / (squared.x + squared.y);
}

fn sampling_orthonormal_basis(
    normal: vec3f,
    tangent: ptr<function, vec3f>,
    bitangent: ptr<function, vec3f>
) {
    let signZ = select(-1.0, 1.0, normal.z >= 0.0);
    let factor = -1.0 / (signZ + normal.z);
    let xy = normal.x * normal.y * factor;
    *tangent = vec3f(
        1.0 + signZ * normal.x * normal.x * factor,
        signZ * xy,
        -signZ * normal.x
    );
    *bitangent = vec3f(
        xy,
        signZ + normal.y * normal.y * factor,
        -normal.y
    );
}

fn sampling_spectral_rgb_filter(rgb: vec3f, channel: i32) -> vec3f {
    if (channel == 0) {
        return rgb;
    }
    var filtered = vec3f(0.0);
    filtered[channel - 1] = rgb[channel - 1];
    return filtered;
}

fn sampling_cauchy_ior(
    wavelength: f32,
    referenceIor: f32,
    dispersionScale: f32,
    abbeNumber: f32
) -> f32 {
    if (wavelength == 0.0 || dispersionScale <= 0.0) {
        return referenceIor;
    }

    let FRAUNHOFER_C = 656.3;
    let FRAUNHOFER_D = 587.6;
    let FRAUNHOFER_F = 486.1;
    let inverseDifference = 1.0 / (
        1.0 / (FRAUNHOFER_F * FRAUNHOFER_F)
        - 1.0 / (FRAUNHOFER_C * FRAUNHOFER_C)
    );
    let effectiveAbbe = max(abbeNumber / dispersionScale, 1e-6);
    let cauchyB = (referenceIor - 1.0) * inverseDifference / effectiveAbbe;
    let cauchyA = referenceIor
        - cauchyB / (FRAUNHOFER_D * FRAUNHOFER_D);
    return cauchyA + cauchyB / (wavelength * wavelength);
}

fn sampling_henyey_greenstein(
    forwardDirection: vec3f,
    anisotropy: f32,
    samplePoint: vec2f
) -> vec3f {
    var cosine: f32;
    if (abs(anisotropy) < 0.001) {
        cosine = 1.0 - 2.0 * samplePoint.y;
    }
    else {
        let ratio = (1.0 - anisotropy * anisotropy)
            / (1.0 + anisotropy - 2.0 * anisotropy * samplePoint.y);
        cosine = (
            ratio * ratio - 1.0 - anisotropy * anisotropy
        ) / (2.0 * anisotropy);
    }

    let sine = sqrt(max(0.0, 1.0 - cosine * cosine));
    let azimuth = TWOPI * samplePoint.x;
    var tangent: vec3f;
    var bitangent: vec3f;
    sampling_orthonormal_basis(forwardDirection, &tangent, &bitangent);
    return tangent * (sine * cos(azimuth))
        + bitangent * (sine * sin(azimuth))
        + forwardDirection * cosine;
}

fn sampling_henyey_greenstein_phase(cosine: f32, anisotropy: f32) -> f32 {
    let denominator = 1.0 + anisotropy * anisotropy
        + 2.0 * anisotropy * cosine;
    return INV4PI * (1.0 - anisotropy * anisotropy)
        / (denominator * sqrt(denominator));
}
`;
