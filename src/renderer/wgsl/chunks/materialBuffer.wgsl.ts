import { simpleTextureSample, thinFilmTextureSample } from '../../materialTextureSlots.js';
import { INSTANCE_VEC4_STRIDE } from '../../bvhAccel.js';
import { mapAlphaUsageConstants } from '../../materialConstants.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import {
  materialAlphaModeConstants
} from '../../materialConstants.js';

export function createMaterialBufferWgsl({
  hasAnisotropyDirections = true,
  hasCoatNormals = false,
  hasSceneAlpha = true,
  hasTransmission = true, caustics = false,
  hasMetalness = true
}: {
  hasSceneAlpha?: boolean;
  hasAnisotropyDirections?: boolean;
  hasCoatNormals?: boolean;
  hasTransmission?: boolean; caustics?: boolean;
  hasMetalness?: boolean;
} = {}) {
  const alphaModeAssignment = hasSceneAlpha
    ? '(*ma).alphaMode = i32(matData.alphaMode);'
    : '';
  const alphaModeResolution = hasSceneAlpha
    ? /* wgsl */ `
  if ((*ma).alphaMode == ${materialAlphaModeConstants.opaque}) {
    (*ma).alpha = 1.0;
  }
  else if ((*ma).alphaMode == ${materialAlphaModeConstants.mask}) {
    (*ma).alpha = select(0.0, 1.0, (*ma).alpha >= matData.alphaCutoff);
  }`
    : '(*ma).alpha = 1.0;';

  return /* wgsl */ `

${hasAnisotropyDirections ? /* wgsl */ `fn gltf_anisotropy_to_openpbr(roughness: f32, strength: f32) -> vec2f {
  if (strength == 0.0) { return vec2f(roughness, 0.0); }
  let u = roughness * roughness;
  let a = u + (1.0 - u) * strength * strength;
  if (a == 0.0) { return vec2f(0.0); }
  return vec2f(pow((a*a + u*u) * 0.5, 0.25), clamp(1.0 - u/a, 0.0, 1.0));
}
` : /* wgsl */ ``}

fn sRGBToLinear(c: vec3f) -> vec3f {
  return mix(pow(c * 0.9478672986 + 0.0521327014, vec3f(2.4)), c * 0.0773993808, vec3f(c < vec3f(0.04045)));
}

fn decodeMapColor(idx: i32, c: vec3f) -> vec3f {
  if (mapInfo[idx + NUM_MAPS * 2].y > 0.5) { return c; }
  return sRGBToLinear(c);
}

fn unpackMaterialIndex(val: i32) -> vec2f {
  return vec2f(f32(val >> 8), f32(val & 0xff) / 255.0);
}

fn getMapSize(idx: i32) -> vec2f {
  return mapInfo[idx].xy;
}

fn getMapLayer(idx: i32) -> i32 {
  return i32(floor(mapInfo[idx].z));
}

fn getMapOffset(idx: i32) -> vec2f {
  return vec2f(fract(mapInfo[idx].z), mapInfo[idx].w);
}

fn wrapMapCoordinate(value: f32, mode: f32) -> f32 {
  if (mode < 0.5) { return fract(value); }
  if (mode < 1.5) { return clamp(value, 0.0, 1.0); }
  return 1.0 - abs(1.0 - (value - 2.0 * floor(value * 0.5)));
}

fn wrappedMapUv(idx: i32, uv: vec2f) -> vec2f {
  let transform = mapInfo[idx + NUM_MAPS];
  let modes = mapInfo[idx + NUM_MAPS * 2].zw;
  let value = uv * transform.xy + transform.zw;
  return vec2f(wrapMapCoordinate(value.x, modes.x), wrapMapCoordinate(value.y, modes.y));
}

fn getMapUV(idx: i32, uv: vec2f) -> vec2f {
  let repeatedUv = wrappedMapUv(idx, uv);
  let atlasTexel = 1.0 / vec2f(textureDimensions(map).xy);
  let firstTexelCenter = getMapOffset(idx);
  let sourceExtent = getMapSize(idx) + atlasTexel;
  let sourceOrigin = firstTexelCenter - 0.5 * atlasTexel;
  let lastTexelCenter = firstTexelCenter + sourceExtent - atlasTexel;
  return clamp(
    sourceOrigin + repeatedUv * sourceExtent,
    firstTexelCenter,
    lastTexelCenter
  );
}

fn getMapUvSet(idx: i32, uv: vec2f, uv1: vec2f) -> vec2f {
  return select(uv, uv1, mapInfo[idx + NUM_MAPS * 2].x > 0.5);
}

fn sampleMap(idx: i32, uv: vec2f) -> vec4f {
  let size = vec2i(round(getMapSize(idx) * vec2f(textureDimensions(map).xy) + vec2f(1.0)));
  let texel = wrappedMapUv(idx, uv) * vec2f(size) - vec2f(0.5);
  let modes = mapInfo[idx + NUM_MAPS * 2].zw;
  // Repeat filtering must cross the logical image boundary, never another
  // atlas placement. Interior/clamped/mirrored footprints use hardware filtering.
  if ((size.x > 1 && modes.x < 0.5 && (texel.x < 0.0 || texel.x > f32(size.x - 1))) ||
      (size.y > 1 && modes.y < 0.5 && (texel.y < 0.0 || texel.y > f32(size.y - 1)))) {
    let base = vec2i(floor(texel));
    let weight = fract(texel);
    let origin = vec2i(round(getMapOffset(idx) * vec2f(textureDimensions(map).xy) - vec2f(0.5)));
    return mix(
      mix(loadMapTexel(idx, base, size, origin, modes), loadMapTexel(idx, base + vec2i(1, 0), size, origin, modes), weight.x),
      mix(loadMapTexel(idx, base + vec2i(0, 1), size, origin, modes), loadMapTexel(idx, base + vec2i(1, 1), size, origin, modes), weight.x), weight.y);
  }
  return textureSampleLevel(map, mapSampler, getMapUV(idx, uv), getMapLayer(idx), 0.0);
}

fn loadMapTexel(idx: i32, coordinate: vec2i, size: vec2i, origin: vec2i, modes: vec2f) -> vec4f {
  var p = clamp(coordinate, vec2i(0), size - vec2i(1));
  if (modes.x < 0.5) { p.x = ((coordinate.x % size.x) + size.x) % size.x; }
  if (modes.y < 0.5) { p.y = ((coordinate.y % size.y) + size.y) % size.y; }
  return textureLoad(map, origin + p, getMapLayer(idx), 0);
}


fn getMaterialEmission(materialIndex: i32, uv: vec2f, uv1: vec2f) -> vec3f {
  let matData = materialsBuffer[materialIndex];
  var emission = matData.emission;
  if (USE_EMISSIVE_MAPS) {
    let emissiveMapIndex = i32(matData.emissiveMapIndex);
    if (emissiveMapIndex >= 0) {
      emission *= decodeMapColor(emissiveMapIndex, sampleMap(
        emissiveMapIndex, getMapUvSet(emissiveMapIndex, uv, uv1)
      ).rgb);
    }
  }
  if (USE_COAT_WEIGHT_MAPS && matData.matType == 0.0) {
    let coatWeightMapIndex = i32(matData.coatWeightMapIndex);
    if (coatWeightMapIndex >= 0) {
      let coatWeight = clamp(matData.coatWeight, 0.0, 1.0) * sampleMap(
        coatWeightMapIndex, getMapUvSet(coatWeightMapIndex, uv, uv1)
      ).r;
      emission *= mix(vec3f(1.0), sqrt(max(matData.coatColor, vec3f(0.0))), coatWeight);
    }
  }
  return emission;
}

// OpenPBR 1.1.1: RMS-preserving GGX anisotropy, shared by base and coat.
fn openpbr_roughness_to_alpha(roughness: f32, anisotropy: f32) -> vec2f {
  let alpha = roughness * roughness;
  let alphaMin = ROUGHNESS_MIN * ROUGHNESS_MIN;
  if (anisotropy == 0.0) { return vec2f(max(alphaMin, alpha)); }
  let complement = 1.0 - anisotropy;
  let alphaT = alpha * sqrt(2.0 / (1.0 + complement * complement));
  return max(vec2f(alphaMin), vec2f(alphaT, complement * alphaT));
}

fn getInstanceColor(instanceIndex: i32) -> vec3f {
  if (instanceIndex < 0) { return vec3f(1.0); }
  return instancesBuffer[instanceIndex * ${INSTANCE_VEC4_STRIDE} + 9].xyz;
}

fn getMaterial(
  ma: ptr<function, OpenPbrResolvedMaterial>,
  materialIndex: i32,
  uv: vec2f,
  uv1: vec2f,
  instanceIndex: i32,
  vertexColor: vec3f
) {
  let matData = materialsBuffer[materialIndex];

  (*ma).baseColor = matData.color;
  (*ma).materialType = i32(matData.matType);
  (*ma).specularRoughness = matData.roughness;
  (*ma).baseMetalness = matData.metallic;
  (*ma).specularAnisotropy = clamp(matData.anisotropy, 0.0, 1.0);
  (*ma).emission = getMaterialEmission(materialIndex, uv, uv1);
  (*ma).inside = false;
  (*ma).specularIor = matData.ior;
  (*ma).transmissionWeight = matData.transmission;
  (*ma).thinWalled = matData.thin > 0.5;
  (*ma).bevel = matData.bevel;
  (*ma).transmissionDispersionScale = matData.dispersion;
  (*ma).dispersionAbbeNumber = max(matData.dispersionAbbeNumber, 1e-6);
  (*ma).mediumExtinction = max(matData.mediumExtinction, vec3f(0.0));
  (*ma).mediumScattering = max(matData.mediumScattering, vec3f(0.0));
  (*ma).mediumAnisotropy = clamp(matData.mediumAnisotropy, -1.0, 1.0);
  (*ma).mediumType = select(0, 1, max(max((*ma).mediumExtinction.x, (*ma).mediumExtinction.y), (*ma).mediumExtinction.z) > 0.0);
  (*ma).alpha = matData.alpha;
  ${alphaModeAssignment}

  (*ma).thinFilmThickness = matData.thinFilmThickness * 1000.0;
  (*ma).thinFilmIor = matData.thinFilmIor;
  (*ma).thinFilmWeight = select(0.0, clamp(matData.thinFilmWeight, 0.0, 1.0), HAS_THIN_FILM);
  (*ma).baseWeight = clamp(matData.baseWeight, 0.0, 1.0);
  (*ma).diffuseRoughness = clamp(matData.baseDiffuseRoughness, 0.0, 1.0);
  (*ma).specularWeight = max(matData.specularWeight, 0.0);
  (*ma).specularColor = max(matData.specularColor, vec3f(0.0));
  (*ma).subsurfaceWeight = select(0.0, clamp(matData.subsurfaceWeight, 0.0, 1.0), HAS_SUBSURFACE);
  (*ma).subsurfaceColor = max(matData.subsurfaceColor, vec3f(0.0));
  (*ma).transmissionColor = max(matData.transmissionColor, vec3f(0.0));
  (*ma).fuzzWeight = select(0.0, clamp(matData.fuzzWeight, 0.0, 1.0), HAS_FUZZ);
  (*ma).fuzzColor = max(matData.fuzzColor, vec3f(0.0));
  (*ma).fuzzRoughness = clamp(matData.fuzzRoughness, 0.0, 1.0);
  (*ma).coatWeight = select(0.0, clamp(matData.coatWeight, 0.0, 1.0), HAS_COAT);
  (*ma).coatColor = max(matData.coatColor, vec3f(0.0));
  (*ma).coatRoughness = clamp(matData.coatRoughness, ROUGHNESS_MIN, 1.0);
  (*ma).coatAnisotropy = clamp(matData.coatAnisotropy, 0.0, 1.0);
  (*ma).coatIor = max(matData.coatIor, 1.0);
  (*ma).coatDarkening = clamp(matData.coatDarkening, 0.0, 1.0);

  if (USE_DIFFUSE_MAPS) {
    let diffuseMapIndex = i32(matData.diffuseMapIndex);
    if (diffuseMapIndex >= 0) {
      // TODO textureSample is not supported in compute shader.
      let diffuse = sampleMap(
        diffuseMapIndex, getMapUvSet(diffuseMapIndex, uv, uv1)
      );
      // Material factors from THREE / glTF are already linear. Only color
      // textures need decoding from their stored sRGB values.
      (*ma).baseColor *= decodeMapColor(diffuseMapIndex, diffuse.rgb);

      // Map alpha to transmission
      if (matData.mapAlphaUsage == ${mapAlphaUsageConstants.transmission}) {
        (*ma).transmissionWeight = 1.0 - diffuse.a;
      }
      else if (matData.mapAlphaUsage == ${mapAlphaUsageConstants.alpha}) {
        (*ma).alpha *= diffuse.a;
      }
    }
  }

  ${simpleTextureSample('alphaMap', 'wgsl')}

  ${alphaModeResolution}

  ${simpleTextureSample('transmissionMap', 'wgsl')}

  if (USE_METALLIC_ROUGHNESS_MAPS) {
    // Metallic roughness transmission map index
    let mrtMapIndex = i32(matData.mrtMapIndex);
    if (mrtMapIndex >= 0) {
      let metallicRoughness = sampleMap(
        mrtMapIndex, getMapUvSet(mrtMapIndex, uv, uv1)
      );
      (*ma).baseMetalness *= metallicRoughness.b;
      (*ma).specularRoughness *= metallicRoughness.g;
    }
  }

  ${simpleTextureSample('roughnessMap', 'wgsl')}

  ${simpleTextureSample('metalnessMap', 'wgsl')}

  ${thinFilmTextureSample('wgsl')}

  ${simpleTextureSample('coatWeightMap', 'wgsl')}

${hasCoatNormals ? /* wgsl */ `
  // Independent coat shading also applies when the coat has no normal map.
  (*ma).coatNormalEnabled = (*ma).coatWeight > 0.0 && (matData.normalMapIndex >= 0.0 || matData.coatNormalMapIndex >= 0.0);
` : ''}

  ${simpleTextureSample('coatRoughnessMap', 'wgsl')}

  ${simpleTextureSample('fuzzColorMap', 'wgsl')}

  ${simpleTextureSample('fuzzRoughnessMap', 'wgsl')}

  ${simpleTextureSample('specularWeightMap', 'wgsl')}

  ${simpleTextureSample('specularColorMap', 'wgsl')}

${hasAnisotropyDirections ? /* wgsl */ `
  (*ma).anisotropyDirection = vec2f(1.0, 0.0);
  (*ma).anisotropyDirectionEnabled = matData.specularAnisotropyRotation != 0.0;
  (*ma).coatAnisotropyRotation = matData.coatAnisotropyRotation;
  if (USE_ANISOTROPY_MAPS && matData.anisotropyMapIndex >= 0.0) {
    let index = i32(matData.anisotropyMapIndex);
    let texel = sampleMap(index, getMapUvSet(index, uv, uv1));
    (*ma).specularAnisotropy *= texel.b;
    let direction = texel.rg * 2.0 - 1.0;
    if (dot(direction, direction) > 1e-4) { (*ma).anisotropyDirection = normalize(direction); }
    (*ma).anisotropyDirectionEnabled = true;
  }
  if (matData.specularAnisotropyModel > 0.5 && (*ma).specularAnisotropy > 0.0) {
    let native = gltf_anisotropy_to_openpbr(clamp((*ma).specularRoughness, 0.0, 1.0), (*ma).specularAnisotropy);
    (*ma).specularRoughness = native.x;
    (*ma).specularAnisotropy = native.y;
  }
  if ((*ma).anisotropyDirectionEnabled) {
    let theta = matData.specularAnisotropyRotation;
    let d = (*ma).anisotropyDirection;
    (*ma).anisotropyDirection = vec2f(cos(theta)*d.x - sin(theta)*d.y, sin(theta)*d.x + cos(theta)*d.y);
  }

` : /* wgsl */ ``}
  // OpenPBR 1.1.1: coat refraction broadens all base microfacet lobes.
  // Keep the zero-coat / smooth-coat paths byte-identical.
  if ((*ma).coatWeight > 0.0 && (*ma).coatRoughness > 0.0) {
    let baseRoughness2 = (*ma).specularRoughness * (*ma).specularRoughness;
    let coatRoughness2 = (*ma).coatRoughness * (*ma).coatRoughness;
    (*ma).specularRoughness = mix((*ma).specularRoughness,
      pow(min(1.0, baseRoughness2 * baseRoughness2 + 2.0 * coatRoughness2 * coatRoughness2), 0.25), (*ma).coatWeight);
  }
  ${hasTransmission ? '' : /* wgsl */ `(*ma).transmissionWeight = 0.0;`}
  ${hasMetalness ? '' : /* wgsl */ `(*ma).baseMetalness = 0.0;`}
  let color = getInstanceColor(instanceIndex) * vertexColor;
  (*ma).baseColor *= color;
  if ((*ma).materialType == UNLIT) { (*ma).emission *= color; }

${caustics ? /* wgsl */ `  (*ma).causticRoughness = (*ma).specularRoughness;
  (*ma).causticNormalMapped = matData.normalMapIndex >= 0.0;
` : ''}  (*ma).specularRoughness = clamp((*ma).specularRoughness, ROUGHNESS_MIN, 1.0);
  (*ma).baseMetalness = clamp((*ma).baseMetalness, 0.0, 1.0);
  let specularAlpha = openpbr_roughness_to_alpha((*ma).specularRoughness, (*ma).specularAnisotropy);
  (*ma).alphaX = specularAlpha.x;
  (*ma).alphaY = specularAlpha.y;
}

fn getMatNormal(materialIndex: i32, uv: vec2f, normal: vec3f, dp1: vec3f, dp2: vec3f, duv1: vec2f, duv2: vec2f) -> vec3f {
  let matData = materialsBuffer[materialIndex];
  let normalMapIndex = i32(matData.normalMapIndex);
  if (normalMapIndex >= 0) {
    // http://www.thetenthplanet.de/archives/1180
    // TODO use tangent attribute
    // Compute co-tangent and co-bitangent vectors
    let dp2perp = cross(dp2, normal);
    let dp1perp = cross(normal, dp1);
    var dpdu = dp2perp * duv1.x + dp1perp * duv2.x;
    var dpdv = dp2perp * duv1.y + dp1perp * duv2.y;
    let gradientLengthSquared = max(dot(dpdu, dpdu), dot(dpdv, dpdv));
    if (gradientLengthSquared > 1e-12) {
      let invmax = inverseSqrt(gradientLengthSquared);
      dpdu *= invmax;
      dpdv *= invmax;
    }
    else {
      // Generated/triplanar UVs have no per-vertex UV derivatives. Build a
      // stable fallback basis instead of normalizing two zero vectors.
      let referenceAxis = select(
        vec3f(0.0, 1.0, 0.0),
        vec3f(0.0, 0.0, 1.0),
        abs(normal.z) < 0.999
      );
      dpdu = normalize(cross(referenceAxis, normal));
      dpdv = cross(normal, dpdu);
    }

    var n = 2.0 * sampleMap(normalMapIndex, uv).rgb - 1.0;
    n = normalize(vec3(n.xy * matData.normalMapScale, n.z));

    let tbn = mat3x3(dpdu, dpdv, normal);

    return normalize(tbn * n);
  } else {
    return normal;
  }
}
`;
}

const materialBufferWgsl = createMaterialBufferWgsl();

export default materialBufferWgsl;
