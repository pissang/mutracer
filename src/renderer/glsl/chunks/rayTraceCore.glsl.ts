// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { createShaderMixin, glsl, Shader } from '../../shader.js';
import { ShadowCatcherMaterial, UnlitMaterial } from '../../../constants.js';
import { CONSTANT_SPOT_LIGHT } from '../../lightConstants.js';

export function createRayTraceCoreGlsl(fragments: Readonly<Record<string, string>> = {}) { return createShaderMixin({
  uniforms: {
    lightsTex: Shader.uniform('sampler2D'),
    iesProfileData: Shader.uniform('sampler2D'),
    iesProfileColumns: Shader.uniform('int', 1),
    pixelSize: Shader.uniform('vec2'),
    jitter: Shader.uniform('vec2'),
    sampleCount: Shader.uniform('int'),
    envLightSelectionPmf: Shader.uniform('float', 0)
  },
  defines: {
    STANDARD: 0,
    UNLIT: UnlitMaterial,
    SHADOW_CATCHER: ShadowCatcherMaterial,
    SPOT_LIGHT: CONSTANT_SPOT_LIGHT
  },
  main: glsl`
// https://www.w3.org/WAI/GL/wiki/Relative_luminance
const vec3 luminance = vec3(0.2126, 0.7152, 0.0722);
const int bounceSamples = 8;

#define RAY_MAX_DISTANCE 9999.0

#define NO_UNROLL(X) (X + min(0, sampleCount))
#define NO_UNROLLU(X) (X + uint(min(0, sampleCount)))

struct Ray {
  vec3 o;
  vec3 d;
  float tMax;
};

struct SurfaceInteraction {
  bool hit;
  vec3 position;
  vec3 normal; // material shading normal
#ifdef USE_COAT_NORMAL_FRAMES
  vec3 coatNormal;
#endif
  vec3 vertexNormal; // interpolated mesh normal before normal mapping
  vec3 shadowOffset; // smooth-surface offset used by direct-light shadow rays
  
  vec2 uv;
  vec2 uv1;
  vec3 vertexColor;

#ifdef USE_TANGENT
  vec3 tangent;
#endif
  vec3 directionTangent;
  vec3 directionBitangent;
  vec3 geometryTangent;
  vec3 geometryBitangent;
  vec3 faceNormal; // normal of the triangle

  bool isTransparency;
  // For perfect specular or transmission surface
  // We use the albedo and normal of first diffuse or glossy surface hit instead for denoising
  // See albedo section in https://www.openimagedenoise.org/documentation.html
  bool albedoSampled;

  int triangleIndex;
  int instanceIndex;
  int materialIndex;

  int mediumType;
  vec3 mediumExtinction;
  vec3 mediumScattering;
  float mediumAnisotropy;
};

// Texture-resolved OpenPBR inputs used by the surface integrator. The storage
// buffer keeps its compact legacy layout; getMaterial() is the compatibility
// boundary that maps it to these canonical names.
struct OpenPbrResolvedMaterial {
  int materialType;

  float specularRoughness;${fragments['core0'] ?? ''}
  float baseMetalness;
  vec3 baseColor;
  float specularIor;
  vec3 emission;
  float transmissionWeight;
  bool thinWalled;
  float specularAnisotropy;
  float alpha;

  float transmissionDispersionScale;
  float dispersionAbbeNumber;
  float thinFilmThickness;
  float thinFilmIor;
  float thinFilmWeight;

  // Medium
  int mediumType;
  vec3 mediumExtinction;
  vec3 mediumScattering;
  float mediumAnisotropy;

  float baseWeight;
  float diffuseRoughness;
  float specularWeight;
  vec3 specularColor;
  float subsurfaceWeight;
  vec3 subsurfaceColor;
  vec3 transmissionColor;
  float fuzzWeight;
  vec3 fuzzColor;
  float fuzzRoughness;
  float coatWeight;
  vec3 coatColor;
  float coatRoughness;
  float coatAnisotropy;
  vec2 anisotropyDirection;
  bool anisotropyDirectionEnabled;
  float coatAnisotropyRotation;
  vec3 directionTangent;
  vec3 directionBitangent;
  vec3 geometryTangent;
  vec3 geometryBitangent;
#ifdef USE_COAT_NORMAL_FRAMES
  vec3 coatNormal;
  bool coatNormalEnabled;
  vec3 geometricNormal;
#endif
  float coatIor;
  float coatDarkening;

  float bevel;

  // Calculated
  float relativeIor;
  bool inside;
  float alphaX;
  float alphaY;
};


struct Light {
  vec3 position;
  vec3 emission;
  vec3 u;
  vec3 v;
  float radius;
  float area;
  float type;
  int textureIndex;
  float spread;
  float selectionPmf;
  float selectionCdf;
  vec3 iesReference;
};

void initRay(inout Ray ray, vec3 origin, vec3 direction) {
  ray.o = origin;
  ray.d = direction;
  ray.tMax = RAY_MAX_DISTANCE;
}

// given the index from a 1D array, retrieve corresponding position from packed 2D texture
ivec2 unpackTexel(int i, int columnsLog2) {
  ivec2 u;
  u.y = i >> columnsLog2; // equivalent to (i / 2^columnsLog2)
  u.x = i - (u.y << columnsLog2); // equivalent to (i % 2^columnsLog2)
  return u;
}

vec4 fetchData(sampler2D s, int i, int columnsLog2) {
  return texelFetch(s, unpackTexel(i, columnsLog2), 0);
}

ivec4 fetchData(highp isampler2D s, int i, int columnsLog2) {
  return texelFetch(s, unpackTexel(i, columnsLog2), 0);
}

struct Path {
  Ray ray;
  vec3 li;
  float alpha;
  vec3 beta;
  bool fromEye;
  bool abort;
  float scatteringPdf;
  bool scatteringIsDelta;
  bool isNextRefraction;${fragments['core1'] ?? ''}
};

struct LightSampleRec {
  vec3 normal;
  vec3 emission;
  vec3 direction;
  float dist;
  float pdf;
  bool isDelta;
  int sourceType;
  int sourceIndex;
};


Light fetchLight(int i) {
  int firstTexel = i * 6;
  vec4 positionAndPmf = texelFetch(
    lightsTex,
    ivec2(firstTexel, 0),
    0
  );
  vec4 emissionAndCdf = texelFetch(
    lightsTex,
    ivec2(firstTexel + 1, 0),
    0
  );
  vec4 tangentAndSpread = texelFetch(
    lightsTex,
    ivec2(firstTexel + 2, 0),
    0
  );
  vec4 bitangentAndTexture = texelFetch(
    lightsTex,
    ivec2(firstTexel + 3, 0),
    0
  );
  vec4 shape = texelFetch(
    lightsTex,
    ivec2(firstTexel + 4, 0),
    0
  );
  return Light(
    positionAndPmf.xyz,
    emissionAndCdf.xyz,
    tangentAndSpread.xyz,
    bitangentAndTexture.xyz,
    shape.x,
    shape.y,
    shape.z,
    int(bitangentAndTexture.w),
    tangentAndSpread.w,
    positionAndPmf.w,
    emissionAndCdf.w,
    texelFetch(lightsTex, ivec2(firstTexel + 5, 0), 0).xyz
  );
}

float iesProfileScalar(int baseTexel, int scalarIndex) {
  int texelIndex = baseTexel + scalarIndex / 4;
  vec4 packed = texelFetch(
    iesProfileData,
    ivec2(texelIndex % iesProfileColumns, texelIndex / iesProfileColumns),
    0
  );
  return packed[scalarIndex % 4];
}

float sampleIESProfile(int baseTexel, vec2 uv) {
  if (baseTexel < 0) return 1.0;
  vec2 pixel = fract(uv) * 128.0 - 0.5;
  ivec2 p0 = ivec2(floor(pixel));
  vec2 f = fract(pixel);
  int xa = p0.x < 0 ? 127 : p0.x;
  int xb = p0.x >= 127 ? 0 : p0.x + 1;
  int ya = p0.y < 0 ? 127 : p0.y;
  int yb = p0.y >= 127 ? 0 : p0.y + 1;
  float a = iesProfileScalar(baseTexel, ya * 128 + xa);
  float b = iesProfileScalar(baseTexel, ya * 128 + xb);
  float c = iesProfileScalar(baseTexel, yb * 128 + xa);
  float d = iesProfileScalar(baseTexel, yb * 128 + xb);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float evaluateSpotEmissionMultiplier(Light light, vec3 lightToSurface) {
  vec3 axis = normalize(light.u);
  float cosTheta = dot(axis, lightToSurface);
  float cone = light.v.y > light.v.x + 1e-6
    ? smoothstep(light.v.x, light.v.y, cosTheta)
    : step(light.v.x, cosTheta);
  if (cone <= 0.0 || light.textureIndex < 0) return cone;
  vec3 xAxis = light.iesReference;
  vec3 yAxis = cross(axis, xAxis);
  float vertical = acos(clamp(cosTheta, -1.0, 1.0));
  float horizontal = atan(dot(lightToSurface, yAxis), dot(lightToSurface, xAxis));
  return cone * sampleIESProfile(light.textureIndex, vec2(vertical / PI, horizontal / TWOPI + 0.5));
}
`
});
}
export default createRayTraceCoreGlsl();
