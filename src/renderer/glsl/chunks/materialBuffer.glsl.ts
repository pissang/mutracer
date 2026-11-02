import { simpleTextureSample, thinFilmTextureSample } from '../../materialTextureSlots.js';
import { materialRowsGlsl } from '../../materialLayoutSchema.js';
import { materialAlphaModeConstants } from '../../materialConstants.js';
import { INSTANCE_VEC4_STRIDE } from '../../bvhAccel.js';
import { mapAlphaUsageConstants } from '../../materialConstants.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { createShaderMixin, glsl, Shader } from '../../shader.js';

export function createMaterialBufferGlsl(fragments: Readonly<Record<string, string>> = {}) { return createShaderMixin({
  uniforms: {
    materialBuffer: Shader.uniform('sampler2D'),
    materialBufferColumns: Shader.uniform('int', 1),
    mapInfo: Shader.arrayUniform('vec4', 'NUM_MAPS'),
    mapTransform: Shader.arrayUniform('vec4', 'NUM_MAPS'),
    mapUvChannel: Shader.arrayUniform('float', 'NUM_MAPS'),
    mapColorLinear: Shader.arrayUniform('float', 'NUM_MAPS'),
    mapWrap: Shader.arrayUniform('vec2', 'NUM_MAPS'),
    map: Shader.uniform('sampler2DArray')
  },
  defines: {
    NUM_MATERIALS: 1
  },
  main: glsl`
${materialRowsGlsl()}
#ifdef HAS_GLTF_ANISOTROPY
vec2 gltf_anisotropy_to_openpbr(float roughness, float strength) {
  if (strength == 0.0) { return vec2(roughness, 0.0); }
  float u = roughness * roughness;
  float a = u + (1.0 - u) * strength * strength;
  if (a == 0.0) { return vec2(0.0); }
  return vec2(pow((a*a + u*u) * 0.5, 0.25), clamp(1.0 - u/a, 0.0, 1.0));
}

#endif

vec3 sRGBToLinear(vec3 c) {
  return mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThan(c, vec3(0.04045))));
}
vec4 fetchMatData(int i) {
  return fetchData(materialBuffer, i, materialBufferColumns);
}

// Shared by surface evaluation and shadow occlusion, after texture factors.
float resolveMaterialAlpha(float alpha, int alphaMode, float alphaCutoff) {
  if (alphaMode == ${materialAlphaModeConstants.opaque}) {
    return 1.0;
  }
  if (alphaMode == ${materialAlphaModeConstants.mask}) {
    return alpha >= alphaCutoff ? 1.0 : 0.0;
  }
  return alpha;
}

float getMatType(int idx) {
  return fetchMatData(idx * MAT_DATA_SIZE + MAT_ROW_COLOR).w;
}

vec2 unpackMaterialIndex(int val) {
  return vec2(float(val >> 8), float(val & 0xff) / 255.0);
}

#ifdef NUM_MAPS
vec3 decodeMapColor(int index, vec3 c) {
  if (mapColorLinear[index] > 0.5) { return c; }
  return sRGBToLinear(c);
}

vec2 getMapSize(int index) {
  return mapInfo[index].xy;
}

float getMapLayer(int index) {
  return floor(mapInfo[index].z);
}

vec2 getMapOffset(int index) {
  return vec2(fract(mapInfo[index].z), mapInfo[index].w);
}

float wrapMapCoordinate(float value, float mode) {
  if (mode < 0.5) return fract(value);
  if (mode < 1.5) return clamp(value, 0.0, 1.0);
  return 1.0 - abs(1.0 - (value - 2.0 * floor(value * 0.5)));
}

vec2 wrappedMapUv(int index, vec2 uv) {
  vec4 transform = mapTransform[index];
  vec2 value = uv * transform.xy + transform.zw;
  return vec2(wrapMapCoordinate(value.x, mapWrap[index].x), wrapMapCoordinate(value.y, mapWrap[index].y));
}

vec2 getMapUV(int index, vec2 uv) {
  vec2 repeatedUv = wrappedMapUv(index, uv);
  vec2 atlasTexel = 1.0 / vec2(textureSize(map, 0).xy);
  vec2 firstTexelCenter = getMapOffset(index);
  vec2 sourceExtent = getMapSize(index) + atlasTexel;
  vec2 sourceOrigin = firstTexelCenter - 0.5 * atlasTexel;
  vec2 lastTexelCenter = firstTexelCenter + sourceExtent - atlasTexel;
  return clamp(
    sourceOrigin + repeatedUv * sourceExtent,
    firstTexelCenter,
    lastTexelCenter
  );
}

vec2 getMapUvSet(int index, vec2 uv, vec2 uv1) {
  return mapUvChannel[index] > 0.5 ? uv1 : uv;
}

vec4 loadMapTexel(int index, ivec2 coordinate, ivec2 size, ivec2 origin, vec2 modes) {
  ivec2 p = clamp(coordinate, ivec2(0), size - 1);
  if (modes.x < 0.5) p.x = ((coordinate.x % size.x) + size.x) % size.x;
  if (modes.y < 0.5) p.y = ((coordinate.y % size.y) + size.y) % size.y;
  return texelFetch(map, ivec3(origin + p, int(getMapLayer(index))), 0);
}

vec4 sampleMap(int index, vec2 uv) {
  ivec2 size = ivec2(round(getMapSize(index) * vec2(textureSize(map, 0).xy) + 1.0));
  vec2 texel = wrappedMapUv(index, uv) * vec2(size) - 0.5;
  vec2 modes = mapWrap[index];
  if ((size.x > 1 && modes.x < 0.5 && (texel.x < 0.0 || texel.x > float(size.x - 1))) ||
      (size.y > 1 && modes.y < 0.5 && (texel.y < 0.0 || texel.y > float(size.y - 1)))) {
    ivec2 base = ivec2(floor(texel));
    vec2 weight = fract(texel);
    ivec2 origin = ivec2(round(getMapOffset(index) * vec2(textureSize(map, 0).xy) - 0.5));
    return mix(
      mix(loadMapTexel(index, base, size, origin, modes), loadMapTexel(index, base + ivec2(1, 0), size, origin, modes), weight.x),
      mix(loadMapTexel(index, base + ivec2(0, 1), size, origin, modes), loadMapTexel(index, base + ivec2(1, 1), size, origin, modes), weight.x), weight.y);
  }
  return texture(map, vec3(getMapUV(index, uv), getMapLayer(index)));
}
#endif

// OpenPBR 1.1.1: RMS-preserving GGX anisotropy, shared by base and coat.
vec2 openpbr_roughness_to_alpha(float roughness, float anisotropy) {
  float alpha = roughness * roughness;
  float alphaMin = ROUGHNESS_MIN * ROUGHNESS_MIN;
  if (anisotropy == 0.0) { return vec2(max(alphaMin, alpha)); }
  float complement = 1.0 - anisotropy;
  float alphaT = alpha * sqrt(2.0 / (1.0 + complement * complement));
  return max(vec2(alphaMin), vec2(alphaT, complement * alphaT));
}

vec4 fetchIns(int i);
vec3 getInstanceColor(int instanceIndex) {
  if (instanceIndex < 0) return vec3(1.0);
  return fetchIns(instanceIndex * ${INSTANCE_VEC4_STRIDE + ''} + 9).rgb;
}

void getMaterial(
  inout OpenPbrResolvedMaterial mat,
  int materialIndex,
  vec2 uv,
  vec2 uv1,
  int instanceIndex,
  vec3 vertexColor
) {
  int i = materialIndex * MAT_DATA_SIZE;
  vec4 colorAndMatType = fetchMatData(i + MAT_ROW_COLOR);
  vec4 roughnessAndNormal = fetchMatData(i + MAT_ROW_ROUGHNESS_NORMAL);
  vec4 metallicAndMapIndex = fetchMatData(i + MAT_ROW_METALLIC_MAPS);
  vec4 emissionAndEmissiveMapIndex = fetchMatData(i + MAT_ROW_EMISSION);
  vec4 iorAndTransmission = fetchMatData(i + MAT_ROW_IOR_TRANSMISSION);
  vec4 misc = fetchMatData(i + MAT_ROW_MISC);
  vec4 alphaAndThinFilm = fetchMatData(i + MAT_ROW_ALPHA_FILM);
  vec4 baseControls = fetchMatData(i + MAT_ROW_BASE_CONTROLS);
  vec4 specularAndFuzz = fetchMatData(i + MAT_ROW_SPECULAR_FUZZ);
  vec4 subsurface = fetchMatData(i + MAT_ROW_SUBSURFACE);
  vec4 fuzz = fetchMatData(i + MAT_ROW_FUZZ);
  vec4 coat = fetchMatData(i + MAT_ROW_COAT);
  vec4 coatControls = fetchMatData(i + MAT_ROW_COAT_CONTROLS);
  vec4 filmAndDispersion = fetchMatData(i + MAT_ROW_FILM_DISPERSION);
  vec4 standaloneMetalRoughMaps = fetchMatData(i + MAT_ROW_STANDALONE_MAPS);
  int mapAlphaUsage = int(misc.a);

  mat.baseColor = colorAndMatType.rgb;
  mat.materialType = int(colorAndMatType.w);
  mat.specularRoughness = roughnessAndNormal.x;
  mat.baseMetalness = metallicAndMapIndex.x;
  mat.specularAnisotropy = clamp(metallicAndMapIndex.y, 0.0, 1.0);
  mat.emission = emissionAndEmissiveMapIndex.rgb;
  mat.inside = false;
  mat.specularIor = iorAndTransmission.x;
  mat.transmissionWeight = iorAndTransmission.y;
#ifdef HAS_MEDIUM
  mat.mediumType = int(iorAndTransmission.z);
#else
  mat.mediumType = 0;
#endif
  mat.thinWalled = iorAndTransmission.w > 0.5;
  mat.bevel = misc.r;
  mat.transmissionDispersionScale = misc.g;
  mat.dispersionAbbeNumber = max(filmAndDispersion.y, 1e-6);
  mat.thinFilmThickness = misc.b;
  mat.thinFilmIor = alphaAndThinFilm.b;
  mat.thinFilmWeight = clamp(filmAndDispersion.x, 0.0, 1.0);
  // OpenPBR specifies micrometres; the interference routine uses nanometres.
  mat.thinFilmThickness *= 1000.0;
  mat.baseWeight = clamp(baseControls.x, 0.0, 1.0);
  mat.diffuseRoughness = clamp(baseControls.y, 0.0, 1.0);
  mat.specularWeight = max(0.0, baseControls.z);
  mat.subsurfaceWeight = clamp(baseControls.w, 0.0, 1.0);
  mat.specularColor = max(specularAndFuzz.rgb, vec3(0.0));
  mat.fuzzWeight = clamp(specularAndFuzz.w, 0.0, 1.0);
  mat.subsurfaceColor = max(subsurface.rgb, vec3(0.0));
  mat.transmissionColor = max(fetchMatData(i + MAT_ROW_TRANSMISSION_COLOR).rgb, vec3(0.0));
  mat.fuzzColor = max(fuzz.rgb, vec3(0.0));
  mat.fuzzRoughness = clamp(fuzz.w, 0.0, 1.0);
  mat.coatColor = max(coat.rgb, vec3(0.0));
  mat.coatWeight = clamp(coat.w, 0.0, 1.0);
  mat.coatRoughness = clamp(coatControls.x, ROUGHNESS_MIN, 1.0);
  mat.coatAnisotropy = clamp(coatControls.y, 0.0, 1.0);
  mat.coatIor = max(coatControls.z, 1.0);
  mat.coatDarkening = clamp(coatControls.w, 0.0, 1.0);

#ifdef HAS_MEDIUM
  mat.mediumExtinction = max(fetchMatData(i + MAT_ROW_MEDIUM_EXTINCTION).rgb, vec3(0.0));
  mat.mediumAnisotropy = clamp(fetchMatData(i + MAT_ROW_MEDIUM_EXTINCTION).a, -1.0, 1.0);
  mat.mediumScattering = max(fetchMatData(i + MAT_ROW_MEDIUM_SCATTERING).rgb, vec3(0.0));
  mat.mediumType = max(max(mat.mediumExtinction.x, mat.mediumExtinction.y), mat.mediumExtinction.z) > 0.0 ? 1 : 0;
#endif


#ifdef HAS_ALPHA
  mat.alpha = alphaAndThinFilm.r;
#else
  mat.alpha = 1.0;
#endif

  #ifdef NUM_DIFFUSE_MAPS
    int diffuseMapIndex = int(metallicAndMapIndex.z);
    if (diffuseMapIndex >= 0) {
      vec4 diffuse = sampleMap(
        diffuseMapIndex, getMapUvSet(diffuseMapIndex, uv, uv1)
      );
      // Material factors from THREE / glTF are already linear. Only color
      // textures need decoding from their stored sRGB values.
      mat.baseColor *= decodeMapColor(diffuseMapIndex, diffuse.rgb);

      // Map alpha to transmission
      if (mapAlphaUsage == ${mapAlphaUsageConstants.transmission + ''}) {
        mat.transmissionWeight = 1.0 - diffuse.a;
      }
      else if (mapAlphaUsage == ${mapAlphaUsageConstants.alpha + ''}) {
        mat.alpha *= diffuse.a;
      }
    }
  #endif

  ${simpleTextureSample('alphaMap', 'glsl')}

  mat.alpha = resolveMaterialAlpha(
    mat.alpha, int(fetchMatData(i + MAT_ROW_ALPHA).w), standaloneMetalRoughMaps.w
  );

  ${simpleTextureSample('transmissionMap', 'glsl')}

  #ifdef NUM_METALLIC_ROUGHNESS_MAPS
    int metallicRoughnessMapIndex = int(metallicAndMapIndex.w);
    if (metallicRoughnessMapIndex >= 0) {
      vec4 metallicRoughness = sampleMap(
        metallicRoughnessMapIndex,
        getMapUvSet(metallicRoughnessMapIndex, uv, uv1)
      );
      mat.baseMetalness *= metallicRoughness.b;
      mat.specularRoughness *= metallicRoughness.g;
    }
  #endif

  ${simpleTextureSample('roughnessMap', 'glsl')}

  ${simpleTextureSample('metalnessMap', 'glsl')}

  #ifdef NUM_EMISSIVE_MAPS
    int emissiveMapIndex = int(emissionAndEmissiveMapIndex.w);
    if (emissiveMapIndex >= 0) {
      vec3 emissive = sampleMap(
        emissiveMapIndex, getMapUvSet(emissiveMapIndex, uv, uv1)
      ).rgb;
      mat.emission *= decodeMapColor(emissiveMapIndex, emissive);
    }
  #endif

  #ifdef NUM_COAT_WEIGHT_MAPS
    int emissionCoatMapIndex = int(fetchMatData(i + MAT_ROW_LAYER_MAPS).x);
    if (emissionCoatMapIndex >= 0 && mat.materialType == 0) {
      float emissionCoatWeight = clamp(coat.w, 0.0, 1.0) * sampleMap(
        emissionCoatMapIndex, getMapUvSet(emissionCoatMapIndex, uv, uv1)
      ).r;
      mat.emission *= mix(vec3(1.0), sqrt(max(coat.rgb, vec3(0.0))), emissionCoatWeight);
    }
  #endif

  ${thinFilmTextureSample('glsl')}

  ${simpleTextureSample('coatWeightMap', 'glsl')}
#ifdef USE_COAT_NORMAL_FRAMES
  // Independent coat shading also applies when the coat has no normal map.
  mat.coatNormalEnabled = mat.coatWeight > 0.0 && (roughnessAndNormal.y >= 0.0 || fetchMatData(i + MAT_ROW_LAYER_MAPS).z >= 0.0);
#endif

  ${simpleTextureSample('coatRoughnessMap', 'glsl')}

  ${simpleTextureSample('fuzzColorMap', 'glsl')}

  ${simpleTextureSample('fuzzRoughnessMap', 'glsl')}

  ${simpleTextureSample('specularWeightMap', 'glsl')}

  ${simpleTextureSample('specularColorMap', 'glsl')}

  vec4 directionInfo = fetchMatData(i + MAT_ROW_DIRECTION_NORMAL);
  mat.anisotropyDirection = vec2(1.0, 0.0);
  mat.anisotropyDirectionEnabled = directionInfo.y != 0.0;
  mat.coatAnisotropyRotation = fetchMatData(i + MAT_ROW_FILM_TEXTURE).x;
#ifdef NUM_ANISOTROPY_MAPS
  if (directionInfo.x >= 0.0) {
    int index = int(directionInfo.x);
    vec4 texel = sampleMap(index, getMapUvSet(index, uv, uv1));
    mat.specularAnisotropy *= texel.b;
    vec2 direction = texel.rg * 2.0 - 1.0;
    if (dot(direction, direction) > 1e-4) mat.anisotropyDirection = normalize(direction);
    mat.anisotropyDirectionEnabled = true;
  }
#endif
#ifdef HAS_GLTF_ANISOTROPY
  if (fetchMatData(i + MAT_ROW_FILM_TEXTURE).y > 0.5 && mat.specularAnisotropy > 0.0) {
    vec2 native = gltf_anisotropy_to_openpbr(clamp(mat.specularRoughness, 0.0, 1.0), mat.specularAnisotropy);
    mat.specularRoughness = native.x;
    mat.specularAnisotropy = native.y;
  }
#endif
  if (mat.anisotropyDirectionEnabled) {
    float theta = directionInfo.y;
    vec2 d = mat.anisotropyDirection;
    mat.anisotropyDirection = vec2(cos(theta)*d.x - sin(theta)*d.y, sin(theta)*d.x + cos(theta)*d.y);
  }

  // OpenPBR 1.1.1: coat refraction broadens all base microfacet lobes.
  // Keep the zero-coat / smooth-coat paths byte-identical.
  if (mat.coatWeight > 0.0 && mat.coatRoughness > 0.0) {
    float baseRoughness2 = mat.specularRoughness * mat.specularRoughness;
    float coatRoughness2 = mat.coatRoughness * mat.coatRoughness;
    mat.specularRoughness = mix(mat.specularRoughness,
      pow(min(1.0, baseRoughness2 * baseRoughness2 + 2.0 * coatRoughness2 * coatRoughness2), 0.25), mat.coatWeight);
  }
  vec3 color = getInstanceColor(instanceIndex) * vertexColor;
  mat.baseColor *= color;
  if (mat.materialType == UNLIT) mat.emission *= color;

${fragments['material0'] ?? ''}  mat.specularRoughness = clamp(mat.specularRoughness, ROUGHNESS_MIN, 1.0);
  mat.baseMetalness = clamp(mat.baseMetalness, 0.0, 1.0);
  vec2 specularAlpha = openpbr_roughness_to_alpha(mat.specularRoughness, mat.specularAnisotropy);
  mat.alphaX = specularAlpha.x;
  mat.alphaY = specularAlpha.y;
}

#if defined(NUM_NORMAL_MAPS)
vec3 getMatNormal(int materialIndex, vec2 uv, vec3 normal, vec3 dp1, vec3 dp2, vec2 duv1, vec2 duv2) {
  int i = materialIndex * MAT_DATA_SIZE;
  vec4 roughnessAndNormal = fetchMatData(i + MAT_ROW_ROUGHNESS_NORMAL);
  int normalMapIndex = int(roughnessAndNormal.y);
  if (normalMapIndex >= 0) {
    // http://www.thetenthplanet.de/archives/1180
    // TODO use tangent attribute
    // Compute co-tangent and co-bitangent vectors
    vec3 dp2perp = cross(dp2, normal);
    vec3 dp1perp = cross(normal, dp1);
    vec3 dpdu = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 dpdv = dp2perp * duv1.y + dp1perp * duv2.y;
    float gradientLengthSquared = max(dot(dpdu, dpdu), dot(dpdv, dpdv));
    if (gradientLengthSquared > 1e-12) {
      float invmax = inversesqrt(gradientLengthSquared);
      dpdu *= invmax;
      dpdv *= invmax;
    }
    else {
      // Imported meshes can legitimately omit UVs and use generated or
      // triplanar projection. Their zero UV derivatives must not turn the TBN
      // basis (and then every lighting result) into NaN.
      vec3 referenceAxis = abs(normal.z) < 0.999
        ? vec3(0.0, 0.0, 1.0)
        : vec3(0.0, 1.0, 0.0);
      dpdu = normalize(cross(referenceAxis, normal));
      dpdv = cross(normal, dpdu);
    }

    vec3 n = 2.0 * sampleMap(normalMapIndex, uv).rgb - 1.0;
    n.xy *= roughnessAndNormal.zw;
    n = normalize(n);

    mat3 tbn = mat3(dpdu, dpdv, normal);

    return normalize(tbn * n);
  } else {
    return normal;
  }
}
#endif

`
});
}
export default createMaterialBufferGlsl();
