import { specularAnisotropyModelIndex } from '../scene/anisotropyParameters.js';
import { normalizeMaterialParams } from '../scene/openPbrSchema.js';
import { thinFilmMapChannelIndex } from '../scene/thinFilmParameters.js';
import { snapshotMaterialParameters, materialParametersEqual } from '../renderer/sceneChangeDetector.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import Sync from '../Sync.js';
import type Engine from '../Engine.js';
import { markDeformedGeometry } from '../scene/geometryChanges.js';
import type * as THREE from 'three';
import Mesh from '../scene/Mesh.js';
import OpenPBRMaterial, { getMaterialHashKey, materialKeys } from '../scene/OpenPBRMaterial.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import Texture from '../scene/Texture.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import AmbientLight from '../scene/AmbientLight.js';
import EnvironmentLight from '../scene/EnvironmentLight.js';
import RectLight from '../scene/RectLight.js';
import SphereLight from '../scene/SphereLight.js';
import SpotLight from '../scene/SpotLight.js';
import IESProfile from '../scene/IESProfile.js';
import Camera from '../scene/Camera.js';
import type { ColorRGB, ColorRGBA } from '../types.js';
import type { Scene, SceneLight } from '../scene/Scene.js';
import { mat4 } from '../math.js';
import { generateVertexNormals, updateBoundingBox, updateDynamicTangents } from './geometry.js';
import { THREEDeformation, isDeformingMesh } from './threeDeformation.js';
import { snapshotsEqual, snapshotFields } from '../renderer/sceneChangeDetector.js';

interface TextureRecord {
  texture: Texture;
  state: unknown[];
}
type TextureStore = WeakMap<THREE.Texture, TextureRecord>;

function convertTexture(
  threeTexture: THREE.Texture | null | undefined,
  textureStore: TextureStore
) {
  if (!threeTexture) return;
  const state = [threeTexture.version, threeTexture.image, threeTexture.flipY,
    threeTexture.repeat.x, threeTexture.repeat.y, threeTexture.offset.x,
    threeTexture.offset.y, threeTexture.channel, threeTexture.wrapS, threeTexture.wrapT, threeTexture.colorSpace];
  const cached = textureStore.get(threeTexture);
  if (cached && snapshotsEqual(cached.state, state)) return cached.texture;
  const image = convertTextureImage(threeTexture);
  const texture = cached?.texture ?? new Texture(image);
  texture.image = image;
  texture.source = threeTexture;
  texture.flipY = threeTexture.flipY;
  texture.uvScale = [threeTexture.repeat.x, threeTexture.repeat.y];
  texture.uvOffset = [threeTexture.offset.x, threeTexture.offset.y];
  texture.uvChannel = threeTexture.channel === 1 ? 1 : 0;
  const wrap = (value: number) => value === 1001 ? 'clamp-to-edge' as const
    : value === 1002 ? 'mirrored-repeat' as const : 'repeat' as const;
  texture.wrapS = wrap(threeTexture.wrapS); texture.wrapT = wrap(threeTexture.wrapT);
  // Three.js NoColorSpace also reads color channels without a transfer function.
  texture.colorSpace = threeTexture.colorSpace === 'srgb' ? 'srgb'
    : threeTexture.colorSpace === 'srgb-linear' || threeTexture.colorSpace === '' ? 'linear' : undefined;
  if (cached) texture.markUpdated();
  else texture.version = threeTexture.version;
  textureStore.set(threeTexture, { texture, state });
  return texture;
}

function halfFloatToFloat(value: number) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) {
    return sign * Math.pow(2, -14) * (fraction / 0x400);
  }
  if (exponent === 0x1f) {
    return fraction ? NaN : sign * Infinity;
  }
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 0x400);
}

/** Decode Three.js storage into the RGBA byte/float images used by MuTracer. */
function convertTextureImage(texture: THREE.Texture): Texture['image'] {
  const image = texture.image as THREE.DataTexture['image'];
  if (!image?.data) return image as Texture['image'];
  // Three.js enums are kept numeric to retain the optional, type-only peer import.
  const channels = texture.format === 1028 ? 1 : texture.format === 1030 ? 2
    : texture.format === 1022 ? 3 : texture.format === 1023 ? 4 : 0;
  if (!channels) throw new Error(`Unsupported Three.js data texture format: ${texture.format}`);
  const data = image.data as ArrayLike<number>;
  if (data.length !== image.width * image.height * channels) {
    throw new Error('Three.js data texture length does not match its format and dimensions.');
  }
  const half = texture.type === 1016;
  if (channels === 4 && !half && (data instanceof Float32Array || data instanceof Uint8Array ||
    data instanceof Uint8ClampedArray || data instanceof Int32Array)) return image as Texture['image'];
  const bytes = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  const result = bytes ? new Uint8Array(image.width * image.height * 4)
    : new Float32Array(image.width * image.height * 4);
  const read = (index: number) => {
    const value = data[index];
    if (half) return halfFloatToFloat(value);
    if (data instanceof Uint16Array) return value / 65535;
    if (data instanceof Uint32Array) return value / 4294967295;
    if (data instanceof Int8Array) return Math.max(-1, value / 127);
    if (data instanceof Int16Array) return Math.max(-1, value / 32767);
    return value;
  };
  for (let i = 0; i < image.width * image.height; i++) {
    result[i * 4] = read(i * channels);
    result[i * 4 + 1] = channels > 1 ? read(i * channels + 1) : 0;
    result[i * 4 + 2] = channels > 2 ? read(i * channels + 2) : 0;
    result[i * 4 + 3] = channels === 4 ? read(i * channels + 3) : bytes ? 255 : 1;
  }
  return { width: image.width, height: image.height, data: result };
}

function convertDataTexture(threeTexture: THREE.DataTexture | null | undefined, textureStore: TextureStore) {
  if (!threeTexture?.image?.data || !threeTexture.image.width || !threeTexture.image.height) return;
  const previous = textureStore.get(threeTexture);
  const texture = convertTexture(threeTexture, textureStore)!;
  if (previous?.state === textureStore.get(threeTexture)?.state) return texture;
  const data = (texture.image as import('../scene/Texture.js').TextureDataSource).data;
  const { width, height } = threeTexture.image;
  // Three.js equirect maps put the sky at v = 1, so with flipY = false the
  // first row is the nadir. MuTracer environments start at the zenith and
  // ignore flipY, so reorder the rows here instead.
  texture.image = { data: threeTexture.flipY ? data : flipRows(data, width, height), width, height };
  texture.flipY = false;
  return texture;
}

function flipRows<T extends Float32Array | Uint8Array | Uint8ClampedArray | Int32Array>(data: T, width: number, height: number): T {
  if (height <= 1) return data;
  const rowLength = data.length / height;
  const flipped = new (data.constructor as new (length: number) => T)(data.length);
  for (let y = 0; y < height; y++) {
    flipped.set(data.subarray((height - 1 - y) * rowLength, (height - y) * rowLength), y * rowLength);
  }
  return flipped;
}

function convertMaterial(
  threeMaterial: THREE.Material,
  textureCache: TextureStore
) {
  const material = new OpenPBRMaterial();
  if (threeMaterial.userData.mutracerShadowCatcher === true) {
    material.shadowCatcher = true;
    return material;
  }
  if ((threeMaterial as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const basic = threeMaterial as THREE.MeshBasicMaterial;
    // GLTFLoader represents KHR_materials_unlit as MeshBasicMaterial. Keep its
    // base-color texture's alpha while displaying RGB without scene lighting.
    material.unlit = true;
    material.baseWeight = 0;
    material.specularWeight = 0;
    material.baseColor = basic.color.toArray() as ColorRGB;
    material.emissionColor = material.baseColor;
    material.emissionLuminance = 1;
    material.map = convertTexture(basic.map, textureCache);
    material.emissiveMap = material.map;
    material.alphaMap = convertTexture(basic.alphaMap, textureCache);
    material.geometryOpacity = basic.opacity;
    material.alphaCutoff = Math.max(0, basic.alphaTest);
    material.alphaMode = basic.alphaTest > 0
      ? 'mask'
      : basic.transparent || basic.opacity < 1 || !!basic.alphaMap
        ? 'blend'
        : 'opaque';
    material.mapAlphaUsage = material.alphaMode === 'opaque'
      ? "opaque"
      : "alpha";
    material.doubleSided = basic.side === 2;
    return material;
  }
  const standardMaterial = threeMaterial as THREE.MeshStandardMaterial;
  material.baseColor = standardMaterial.color.toArray() as ColorRGB;
  material.emissionColor =
    standardMaterial.emissive &&
    (standardMaterial.emissive.toArray() as ColorRGB);
  material.specularRoughness = standardMaterial.roughness;
  material.baseMetalness = standardMaterial.metalness;
  material.emissionLuminance = standardMaterial.emissiveIntensity;

  material.normalScale =
    standardMaterial.normalScale && standardMaterial.normalScale.toArray();

  const materialUvProjection = standardMaterial.userData
    .mutracerUvProjection;
  if (
    materialUvProjection === 'triplanar' ||
    materialUvProjection === 'spherical' ||
    materialUvProjection === 'cylindrical' ||
    materialUvProjection === 'none'
  ) {
    material.uvProjection = materialUvProjection;
  }
  const materialUvScale = standardMaterial.userData.mutracerUvProjectionScale;
  if (Array.isArray(materialUvScale) && materialUvScale.length >= 2) {
    const referenceLength = Math.max(
      Number(standardMaterial.userData.mutracerUvReferenceLength) || 1,
      0.000001
    );
    const scaleX = Math.max(
      Number(materialUvScale[0]) || 0.000001,
      0.000001
    );
    const scaleY = Math.max(
      Number(materialUvScale[1]) || 0.000001,
      0.000001
    );
    material.uvProjectionScale = material.uvProjection === 'triplanar'
      ? [scaleX / referenceLength, scaleY / referenceLength]
      : material.uvProjection === 'cylindrical'
        ? [scaleX, scaleY / referenceLength]
        : [scaleX, scaleY];
  }

  material.map = convertTexture(standardMaterial.map, textureCache);
  material.alphaMap = convertTexture(standardMaterial.alphaMap, textureCache);
  material.alphaCutoff = Math.max(
    0,
    Number.isFinite(standardMaterial.alphaTest) ? standardMaterial.alphaTest : 0
  );
  material.emissiveMap = convertTexture(
    standardMaterial.emissiveMap,
    textureCache
  );
  material.normalMap = convertTexture(standardMaterial.normalMap, textureCache);
  material.displacementMap = convertTexture(
    standardMaterial.displacementMap,
    textureCache
  );
  const displacementBias = Number(standardMaterial.displacementBias);
  if (Number.isFinite(displacementBias)) material.displacementBias = displacementBias;
  const displacementScale = Number(standardMaterial.displacementScale);
  // Three.js stores 1 even without a height map. Do not turn that inactive
  // default into MuTracer's height when a texture is added after conversion.
  material.displacementScale = Number.isFinite(displacementScale) &&
    (standardMaterial.displacementMap != null || displacementScale !== 1)
    ? displacementScale
    : material.displacementScale;
  const displacementStepSize = Number(
    standardMaterial.userData.mutracerDisplacementStepSize
  );
  if (Number.isFinite(displacementStepSize)) {
    material.displacementStepSize = Math.max(0, displacementStepSize);
  }
  const uvProjection = standardMaterial.userData
    .mutracerDisplacementUvProjection;
  if (
    uvProjection === 'triplanar' ||
    uvProjection === 'spherical' ||
    uvProjection === 'cylindrical' ||
    uvProjection === 'none'
  ) {
    material.displacementUvProjection = uvProjection;
  }
  const displacementUvProjectionScale = Number(
    standardMaterial.userData.mutracerDisplacementUvProjectionScale
  );
  if (Number.isFinite(displacementUvProjectionScale)) {
    material.displacementUvProjectionScale = Math.max(displacementUvProjectionScale, 0.000001);
  }
  if (
    standardMaterial.roughnessMap &&
    standardMaterial.roughnessMap === standardMaterial.metalnessMap
  ) {
    material.metallicRoughnessMap = convertTexture(
      standardMaterial.roughnessMap,
      textureCache
    );
  } else {
    material.roughnessMap = convertTexture(
      standardMaterial.roughnessMap,
      textureCache
    );
    material.metalnessMap = convertTexture(
      standardMaterial.metalnessMap,
      textureCache
    );
  }
  const physicalMaterial = standardMaterial as THREE.MeshPhysicalMaterial;
  if (physicalMaterial.type === 'MeshPhysicalMaterial') {
    material.transmissionWeight = physicalMaterial.transmission;
    material.transmissionMap = convertTexture(
      physicalMaterial.transmissionMap,
      textureCache
    );
    material.specularIor = physicalMaterial.ior;
    // glTF specular (KHR_materials_specular) only scales the dielectric
    // lobe, while OpenPBR applies it to metals too. A fully metallic
    // surface has no dielectric part, so keep the OpenPBR defaults there.
    const fullyMetallic = physicalMaterial.metalness === 1 && !physicalMaterial.metalnessMap;
    material.specularWeight = fullyMetallic ? 1 : physicalMaterial.specularIntensity;
    if (physicalMaterial.specularColor && !fullyMetallic) {
      material.specularColor =
        physicalMaterial.specularColor.toArray() as ColorRGB;
    }
    material.coatWeightMap = convertTexture(physicalMaterial.clearcoatMap, textureCache);
    material.coatRoughnessMap = convertTexture(physicalMaterial.clearcoatRoughnessMap, textureCache);
    material.coatNormalMap = convertTexture(physicalMaterial.clearcoatNormalMap, textureCache);
    material.coatNormalScale = physicalMaterial.clearcoatNormalScale.toArray();
    material.fuzzColorMap = convertTexture(physicalMaterial.sheenColorMap, textureCache);
    material.fuzzRoughnessMap = convertTexture(physicalMaterial.sheenRoughnessMap, textureCache);
    if (!fullyMetallic) {
      material.specularWeightMap = convertTexture(physicalMaterial.specularIntensityMap, textureCache);
      material.specularColorMap = convertTexture(physicalMaterial.specularColorMap, textureCache);
    }
    material.coatWeight = physicalMaterial.clearcoat;
    material.coatRoughness = physicalMaterial.clearcoatRoughness;
    // MeshPhysicalMaterial's clearcoat BRDF uses the fixed dielectric F0
    // for IOR 1.5. Match that in the OpenPBR path representation; explicit
    // mutracerOpenPBR metadata below may provide a different coat IOR.
    material.coatIor = 1.5;
    // Three.js/glTF clearcoat does not model internal-reflection darkening.
    material.coatDarkening = 0;
    material.fuzzWeight = physicalMaterial.sheen;
    material.fuzzRoughness = physicalMaterial.sheenRoughness;
    if (physicalMaterial.sheenColor) {
      material.fuzzColor = physicalMaterial.sheenColor.toArray() as ColorRGB;
    }
    if (physicalMaterial.attenuationColor) {
      material.transmissionColor =
        physicalMaterial.attenuationColor.toArray() as ColorRGB;
    }
    if (Number.isFinite(physicalMaterial.attenuationDistance)) {
      material.transmissionDepth = Math.max(
        0,
        physicalMaterial.attenuationDistance
      );
    }
  }
  const dispersion = Number(physicalMaterial.dispersion);
  material.transmissionDispersionScale = Number.isFinite(dispersion)
    ? Math.max(0, dispersion)
    : 0;
  const realtimeIridescence = physicalMaterial as THREE.MeshPhysicalMaterial & {
    iridescence?: number;
    iridescenceIOR?: number;
    iridescenceThicknessRange?: number[];
    iridescenceThicknessMap?: THREE.Texture | null;
  };
  material.thinFilmThickness = Math.min(
    20,
    Math.max(
      0,
      (realtimeIridescence.iridescenceThicknessRange?.[1] ?? 500) / 1000
    )
  );
  material.thinFilmWeight = Math.min(
    1, Math.max(0, realtimeIridescence.iridescence ?? 0)
  );
  material.thinFilmIor = Math.min(
    2.5, Math.max(1, realtimeIridescence.iridescenceIOR ?? 1.4)
  );
  const nativeThinFilmMap = standardMaterial.userData.mutracerThinFilmMap as THREE.Texture | undefined;
  const thinFilmMap =
    (standardMaterial.userData
      .mutracerThinFilmMap as THREE.Texture | undefined) ??
    realtimeIridescence.iridescenceThicknessMap ??
    undefined;
  if (thinFilmMap) {
    material.thinFilmMap = convertTexture(thinFilmMap, textureCache);
    if (!nativeThinFilmMap) {
      material.thinFilmThicknessMinimum = Math.min(20, Math.max(0,
        (realtimeIridescence.iridescenceThicknessRange?.[0] ?? 0) / 1000));
      material.thinFilmMapChannel = 'g';
    }
  }
  const anisotropy = Number(physicalMaterial.anisotropy);
  material.specularRoughnessAnisotropy = Number.isFinite(anisotropy)
    ? Math.min(1, Math.max(0, anisotropy))
    : 0;
  if (physicalMaterial.isMeshPhysicalMaterial) {
    material.specularAnisotropyModel = 'gltf';
    material.anisotropyMap = convertTexture(physicalMaterial.anisotropyMap, textureCache);
    const rotation = Number(physicalMaterial.anisotropyRotation);
    material.specularAnisotropyRotation = Number.isFinite(rotation) ? rotation : 0;
  }
  const sourceOpenPbr = standardMaterial.userData.mutracerOpenPBR as Record<string, unknown> | undefined;
  const openPbr = sourceOpenPbr ? normalizeMaterialParams(sourceOpenPbr) : undefined;
  const finite = (
    value: unknown,
    fallback: number,
    minimum = 0,
    maximum = 1
  ) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, number))
      : fallback;
  };
  const color = (value: unknown, fallback: ColorRGB) => {
    const components = value as ArrayLike<number> | undefined;
    return components && components.length >= 3
      ? ([
          finite(components[0], fallback[0]),
          finite(components[1], fallback[1]),
          finite(components[2], fallback[2])
        ] as ColorRGB)
      : fallback;
  };
  if (openPbr) {
    for (const key of ['displacementScale', 'displacementBias', 'displacementStepSize'] as const) {
      const value = openPbr[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        material[key] = key === 'displacementStepSize' ? Math.max(0, value) : value;
      }
    }
    if (openPbr.specularAnisotropyModel !== undefined) {
      specularAnisotropyModelIndex(openPbr.specularAnisotropyModel);
      material.specularAnisotropyModel = openPbr.specularAnisotropyModel as 'openpbr' | 'gltf';
    }
    if (openPbr.specularAnisotropy !== undefined && openPbr.specularAnisotropyModel !== 'gltf') {
      material.specularAnisotropyModel = 'openpbr';
      material.anisotropyMap = undefined;
      material.specularAnisotropyRotation = 0;
    }
    // Only supported Texture inputs are accepted; arbitrary metadata objects
    // must never enter the atlas as textures. Explicit null clears an import.
    for (const name of ['coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap',
      'fuzzRoughnessMap', 'specularWeightMap', 'specularColorMap', 'anisotropyMap', 'coatNormalMap'] as const) {
      const texture = openPbr[name];
      if (texture === null) material[name] = undefined;
      else if (texture instanceof Texture) material[name] = texture;
      else if (texture && (texture as THREE.Texture).isTexture &&
        typeof (texture as THREE.Texture).clone === 'function') {
        material[name] = convertTexture(texture as THREE.Texture, textureCache);
      }
    }
    material.specularAnisotropyRotation = finite(openPbr.specularAnisotropyRotation, material.specularAnisotropyRotation, -Infinity, Infinity);
    material.coatAnisotropyRotation = finite(openPbr.coatAnisotropyRotation, material.coatAnisotropyRotation, -Infinity, Infinity);
    const coatScale = openPbr.coatNormalScale as ArrayLike<number> | undefined;
    if (coatScale && coatScale.length >= 2) {
      material.coatNormalScale = [
        finite(coatScale[0], material.coatNormalScale[0], -Infinity, Infinity),
        finite(coatScale[1], material.coatNormalScale[1], -Infinity, Infinity)
      ];
    }
    material.baseWeight = finite(openPbr.baseWeight, material.baseWeight);
    material.baseDiffuseRoughness = finite(
      openPbr.baseDiffuseRoughness,
      material.baseDiffuseRoughness
    );
    material.specularWeight = finite(
      openPbr.specularWeight,
      material.specularWeight
    );
    material.specularColor = color(
      openPbr.specularColor,
      material.specularColor
    );
    material.transmissionScatter = color(
      openPbr.transmissionScatter,
      material.transmissionScatter
    );
    material.transmissionScatterAnisotropy = finite(
      openPbr.transmissionScatterAnisotropy,
      material.transmissionScatterAnisotropy,
      -0.95,
      0.95
    );
    material.transmissionDispersionScale = finite(
      openPbr.transmissionDispersionScale,
      material.transmissionDispersionScale,
      0,
      Infinity
    );
    material.transmissionDispersionAbbeNumber = finite(
      openPbr.transmissionDispersionAbbeNumber,
      material.transmissionDispersionAbbeNumber,
      1,
      100
    );
    material.subsurfaceWeight = finite(
      openPbr.subsurfaceWeight,
      material.subsurfaceWeight
    );
    material.subsurfaceColor = color(
      openPbr.subsurfaceColor,
      material.subsurfaceColor
    );
    material.subsurfaceRadius = finite(
      openPbr.subsurfaceRadius,
      material.subsurfaceRadius,
      0,
      Infinity
    );
    material.subsurfaceRadiusScale = color(
      openPbr.subsurfaceRadiusScale,
      material.subsurfaceRadiusScale
    );
    material.subsurfaceScatterAnisotropy = finite(
      openPbr.subsurfaceAnisotropy,
      material.subsurfaceAnisotropy,
      -0.95,
      0.95
    );
    material.coatWeight = finite(openPbr.coatWeight, material.coatWeight);
    material.coatColor = color(openPbr.coatColor, material.coatColor);
    material.coatRoughness = finite(
      openPbr.coatRoughness,
      material.coatRoughness
    );
    material.coatRoughnessAnisotropy = finite(
      openPbr.coatAnisotropy,
      material.coatAnisotropy
    );
    material.coatIor = finite(openPbr.coatIor, material.coatIor, 1, 2.5);
    material.coatDarkening = finite(
      openPbr.coatDarkening,
      material.coatDarkening
    );
    material.fuzzWeight = finite(openPbr.fuzzWeight, material.fuzzWeight);
    material.fuzzColor = color(openPbr.fuzzColor, material.fuzzColor);
    material.fuzzRoughness = finite(
      openPbr.fuzzRoughness,
      material.fuzzRoughness
    );
    if ('thinWalled' in openPbr) {
      material.geometryThinWalled = openPbr.thinWalled === true;
    }
    material.thinFilmWeight = finite(
      openPbr.thinFilmWeight,
      material.thinFilmWeight
    );
    material.thinFilmThickness = finite(
      openPbr.thinFilmThickness,
      material.thinFilmThickness,
      0,
      20
    );
    material.thinFilmThicknessMinimum = finite(
      openPbr.thinFilmThicknessMinimum, material.thinFilmThicknessMinimum, 0, 20
    );
    if (openPbr.thinFilmMapChannel !== undefined) {
      material.thinFilmMapChannel = ['r', 'g', 'b', 'a'][thinFilmMapChannelIndex(openPbr.thinFilmMapChannel)] as OpenPBRMaterial['thinFilmMapChannel'];
    }
    if (openPbr.thinFilmMap instanceof Texture) material.thinFilmMap = openPbr.thinFilmMap;
    else if (openPbr.thinFilmMap && (openPbr.thinFilmMap as THREE.Texture).isTexture) {
      material.thinFilmMap = convertTexture(openPbr.thinFilmMap as THREE.Texture, textureCache);
    }
    material.thinFilmIor = finite(
      openPbr.thinFilmIor,
      material.thinFilmIor,
      1,
      2.5
    );
  }
  material.geometryOpacity = standardMaterial.opacity;
  // THREE.DoubleSide is the numeric enum value 2. Keep this module's Three.js
  // import type-only while preserving the source material's culling semantics.
  material.doubleSided = standardMaterial.side === 2;
  if (openPbr) {
    material.specularRoughnessAnisotropy = finite(openPbr.specularAnisotropy, material.specularRoughnessAnisotropy);
    material.geometryOpacity = finite(openPbr.opacity, material.geometryOpacity);
  }
  const bevelSize = Number(standardMaterial.userData.mutracerBevelSize);
  material.bevelSize = Number.isFinite(bevelSize) ? Math.max(0, bevelSize) : 0;
  material.mapAlphaUsage =
    standardMaterial.transparent ||
    !!standardMaterial.alphaMap ||
    standardMaterial.alphaTest > 0
    ? "alpha"
    : "opaque";
  material.alphaMode = standardMaterial.alphaTest > 0
    ? 'mask'
    : standardMaterial.transparent ||
        material.geometryOpacity < 1 ||
        !!standardMaterial.alphaMap
      ? 'blend'
      : 'opaque';

  if (standardMaterial.side === 1) {
    // BackSide normals are reversed in converted geometry. Keep the source
    // displacement direction and biased base surface unchanged.
    material.displacementScale = -material.displacementScale;
    material.displacementBias = -material.displacementBias;
  }
  return material;
}

function copyFloatAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  itemSize = attribute.itemSize,
  share = false
) {
  if (share && attribute.array instanceof Float32Array && !attribute.normalized &&
    !(attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute &&
    attribute.itemSize === itemSize && attribute.array.length === attribute.count * itemSize) return attribute.array;
  const result = new Float32Array(attribute.count * itemSize);
  if (attribute.array instanceof Float32Array && !attribute.normalized) {
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    if (!interleaved.isInterleavedBufferAttribute && itemSize === attribute.itemSize) {
      result.set(attribute.array.subarray(0, result.length));
    } else {
      const stride = interleaved.isInterleavedBufferAttribute
        ? interleaved.data.stride : attribute.itemSize;
      const offset = interleaved.isInterleavedBufferAttribute ? interleaved.offset : 0;
      for (let index = 0; index < attribute.count; index++) {
        const sourceOffset = index * stride + offset;
        const targetOffset = index * itemSize;
        for (let component = 0; component < itemSize; component++) {
          result[targetOffset + component] = attribute.array[sourceOffset + component];
        }
      }
    }
    return result;
  }
  // Getters preserve normalized integer and Float16BufferAttribute decoding.
  const getters = [
    attribute.getX,
    attribute.getY,
    attribute.getZ,
    attribute.getW
  ];
  for (let index = 0; index < attribute.count; index++) {
    for (let component = 0; component < itemSize; component++) {
      result[index * itemSize + component] = getters[component].call(
        attribute,
        index
      );
    }
  }
  return result;
}

function convertGeometry(
  threeGeometry: THREE.BufferGeometry,
  drawRange: { start: number; count: number },
  vertexColors: boolean,
  backSide: boolean,
  share = false
): Geometry | null {
  const positionAttrb = threeGeometry.getAttribute('position');
  const normalAttrb = threeGeometry.getAttribute('normal');
  const tangentAttrb = threeGeometry.getAttribute('tangent');
  const uvAttrb = threeGeometry.getAttribute('uv');
  const uv1Attrb = threeGeometry.getAttribute('uv1');
  const colorAttrb = vertexColors && threeGeometry.getAttribute('color');
  const indexAttrb = threeGeometry.getIndex();
  const sourceCount = indexAttrb ? indexAttrb.array.length : positionAttrb.count;
  // Match Array.slice range handling without expanding the complete index stream.
  const clampOffset = (offset: number) => {
    const integer = Math.trunc(offset) || 0;
    return integer < 0 ? Math.max(sourceCount + integer, 0) : Math.min(integer, sourceCount);
  };
  const start = drawRange ? clampOffset(drawRange.start) : 0;
  const end = drawRange ? clampOffset(drawRange.start + drawRange.count) : sourceCount;
  let indexCount = Math.max(end - start, 0);
  // WebGL's TRIANGLES draw mode ignores an incomplete final primitive. Keep
  // path tracing on the same index stream so valid BufferGeometry with a
  // dangling one or two elements cannot produce invalid BLAS input.
  indexCount -= indexCount % 3;
  if (indexCount === 0) return null;
  const sharedIndex = share && !backSide && start === 0 && indexCount === indexAttrb?.array.length && indexAttrb.array instanceof Uint32Array;
  const indices = sharedIndex ? indexAttrb!.array as Uint32Array : new Uint32Array(indexCount);
  if (indexAttrb && !sharedIndex) {
    indices.set(indexAttrb.array.subarray(start, start + indexCount));
  } else if (!indexAttrb) {
    for (let index = 0; index < indexCount; index++) indices[index] = start + index;
  }
  if (backSide) {
    for (let i = 0; i < indices.length; i += 3) {
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
    }
  }
  const geometry = new Geometry({
    position: new Attribute(
      copyFloatAttribute(positionAttrb, positionAttrb.itemSize, share),
      positionAttrb.itemSize
    ),
    normal:
      normalAttrb &&
      new Attribute(copyFloatAttribute(normalAttrb, normalAttrb.itemSize, share && !backSide), normalAttrb.itemSize),
    tangent: tangentAttrb && new Attribute(
      copyFloatAttribute(tangentAttrb, Math.min(4, tangentAttrb.itemSize), share && !backSide),
      Math.min(4, tangentAttrb.itemSize)
    ),
    uv: uvAttrb && new Attribute(copyFloatAttribute(uvAttrb, uvAttrb.itemSize, share), uvAttrb.itemSize),
    uv1:
      uv1Attrb &&
      new Attribute(copyFloatAttribute(uv1Attrb, uv1Attrb.itemSize, share), uv1Attrb.itemSize),
    // MuTracer stores linear RGB only; omit Three.js's optional vertex alpha.
    color: colorAttrb ? new Attribute(copyFloatAttribute(colorAttrb, 3, share), 3) : undefined,
    indices: new Attribute(indices, 1)
  });
  // Generated normals already follow the reversed indices; authored normals do not.
  if (backSide) {
    if (normalAttrb) negateNormals(geometry);
    reverseTangentHandedness(geometry);
  }
  updateBoundingBox(geometry);
  return geometry;
}

function negateNormals(geometry: Geometry) {
  const normals = geometry.normal.array;
  for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
}

function reverseTangentHandedness(geometry: Geometry) {
  // Three.js FLIP_SIDED reverses N but preserves T and B. Reversing W
  // preserves that bitangent when the renderer reconstructs cross(N,T)*W.
  const tangent = geometry.tangent;
  if (tangent?.itemSize === 4) for (let i = 3; i < tangent.array.length; i += 4) tangent.array[i] *= -1;
}

/** Options for one-shot conversion and persistent Three.js synchronization. */
export interface FromTHREESceneOptions {
  /** Override scene.environment with a MuTracer equirectangular texture or ProceduralSky. Default undefined uses the Three.js environment. Intensity and rotation still use the Three.js scene values. */
  environment?: Texture;
  /** Custom material conversion. Default undefined uses built-in conversion; returning null skips every mesh using this material. THREESync invokes once per source material identity/version, so the result cannot depend on a particular mesh. Returned materials are caller-owned; engine.update detects parameter edits. */
  convertMaterial?(material: THREE.Material): OpenPBRMaterial | null | undefined;
  /** Custom light conversion. Default undefined uses built-in conversion; returning null skips this light. THREESync invokes once per source light identity and numeric userData.mutracerVersion (default undefined, never rerun). Returned lights are retained by identity and remain caller-owned. */
  convertLight?(light: THREE.Light): SceneLight | null | undefined;
  /** Receives each converted visible mesh/group on every update. Default: no callback. */
  onMeshConverted?(
    mesh: Mesh | InstancedMesh,
    source: THREE.Mesh,
    group: { start: number; count: number; materialIndex?: number },
    groupIndex: number
  ): void;
}

interface MaterialVariant {
  material: OpenPBRMaterial;
  parameters: unknown[];
  hash?: string;
  base?: OpenPBRMaterial;
  autoUvProjection: boolean;
  autoDisplacementUvProjection: boolean;
}
interface GeometryEntry { state: unknown[]; groups: Map<string, Geometry>; checkedAt: number }
interface ConversionStore {
  updateId: number;
  textures: TextureStore;
  // Equirectangular conversion normalizes rows; material textures retain source pixels and flipY.
  equirectTextures: TextureStore;
  materials: WeakMap<THREE.Material, { material: OpenPBRMaterial; hash: string }>;
  materialHooks: WeakMap<THREE.Material, {version: number; value: OpenPBRMaterial | null | undefined}>;
  lightHooks: WeakMap<THREE.Light, {version: number | undefined; value: SceneLight | null | undefined}>;
  geometries: WeakMap<THREE.BufferGeometry, GeometryEntry>;
  deformedGeometries: WeakMap<THREE.Mesh, GeometryEntry>;
  deformations: WeakMap<THREE.Mesh, THREEDeformation>;
  poseChanged: boolean;
  meshes: WeakMap<THREE.Mesh, Map<number, Mesh>>;
  lights: WeakMap<THREE.Object3D | THREE.Texture | Texture, SceneLight>;
  instanceMeshes: WeakMap<THREE.Mesh, Map<number, InstancedMesh>>;
  // Automatic-projection variants, pruned each update.
  projectionVariants: Map<THREE.Material, Map<string, MaterialVariant>>;
  warned: WeakSet<THREE.Object3D>;
  background?: Scene['background'];
}
function createConversionStore(): ConversionStore {
  return { updateId: 0, textures: new WeakMap(), equirectTextures: new WeakMap(),
    materials: new WeakMap(), geometries: new WeakMap(),
    materialHooks: new WeakMap(), lightHooks: new WeakMap(),
    poseChanged: false, meshes: new WeakMap(), lights: new WeakMap(), deformedGeometries: new WeakMap(), deformations: new WeakMap(),
    instanceMeshes: new WeakMap(), projectionVariants: new Map(), warned: new WeakSet() };
}
const geometryAttributeNames = ['position', 'normal', 'tangent', 'uv', 'uv1', 'color', 'index'] as const;
function geometryState(geometry: THREE.BufferGeometry, deformation: boolean) {
  const state: unknown[] = [];
  for (let i = 0; i < geometryAttributeNames.length; i++) {
    const name = geometryAttributeNames[i];
    const attribute = name === 'index' ? geometry.index : geometry.getAttribute(name);
    if (!attribute) { state.push(undefined); continue; }
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    const buffer = interleaved.isInterleavedBufferAttribute ? interleaved.data : attribute as THREE.BufferAttribute;
    state.push(attribute, buffer, deformation && i < 3 ? undefined : buffer.version, buffer.array, attribute.count, attribute.itemSize,
      attribute.normalized, interleaved.offset, interleaved.data?.stride);
  }
  return state;
}
/** Compare cached fields directly; unchanged geometry creates no snapshot arrays. */
function geometryStateMatches(geometry: THREE.BufferGeometry, state: readonly unknown[], deformation: boolean) {
  let field = 0;
  for (let i = 0; i < geometryAttributeNames.length; i++) {
    const name = geometryAttributeNames[i];
    const attribute = name === 'index' ? geometry.index : geometry.getAttribute(name);
    if (!attribute) {
      if (state[field++] !== undefined) return false;
      continue;
    }
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    const buffer = interleaved.isInterleavedBufferAttribute ? interleaved.data : attribute as THREE.BufferAttribute;
    if (state[field++] !== attribute || state[field++] !== buffer ||
      !Object.is(state[field++], deformation && i < 3 ? undefined : buffer.version) ||
      state[field++] !== buffer.array || !Object.is(state[field++], attribute.count) ||
      !Object.is(state[field++], attribute.itemSize) || !Object.is(state[field++], attribute.normalized) ||
      !Object.is(state[field++], interleaved.offset) || !Object.is(state[field++], interleaved.data?.stride)) return false;
  }
  return field === state.length;
}
function retainLight(store: ConversionStore, source: THREE.Object3D | THREE.Texture | Texture, value: SceneLight) {
  const cached = store.lights.get(source);
  if (!cached || cached.type !== value.type) {
    store.lights.set(source, value);
    return value;
  }
  // Matrix and color arrays are retained when unchanged; light identity always is.
  for (const key of Object.keys(value)) {
    const previous = (cached as unknown as Record<string, unknown>)[key];
    const next = (value as unknown as Record<string, unknown>)[key];
    if (Array.isArray(previous) && Array.isArray(next) && snapshotsEqual(previous, next)) continue;
    (cached as unknown as Record<string, unknown>)[key] = next;
  }
  return cached;
}

/**
 * Converts a Three.js scene into a MuTracer {@link Scene}: meshes with
 * `MeshStandardMaterial` / `MeshPhysicalMaterial` (mapped to OpenPBR),
 * directional, ambient, rect-area, point and spot lights, and the scene
 * background / environment. Calls `scene.updateMatrixWorld()` and creates fresh objects on every call.
 * CPU-evaluates skinning/morph targets and batches InstancedMesh instances
 * with shared geometry, native colors and cached projection material variants. Unsupported batched
 * or instanced deformation falls back to an ordinary mesh with a warning.
 * For animation and editing, use {@link THREESync}.
 *
 * Renderer-specific material settings can be supplied through
 * `material.userData`, e.g. `userData.mutracerShadowCatcher = true` or
 * `userData.mutracerOpenPBR = { ... }` for OpenPBR inputs without a Three.js
 * equivalent.
 */
export function fromTHREEScene(
  scene: THREE.Scene,
  options: FromTHREESceneOptions = {}
) : Scene {
  return convertScene(scene, options, createConversionStore());
}

function convertScene(scene: THREE.Scene, options: FromTHREESceneOptions, store: ConversionStore, shareStaticGeometry = false): Scene {
  const updateId = ++store.updateId;
  const meshes: Mesh[] = [];
  const lights: SceneLight[] = [];
  const textureCache = store.textures;
  const convertedMaterials = new Set<THREE.Material>();
  const baseHashes = new Map<OpenPBRMaterial, string>();
  function refreshVariant(entry: MaterialVariant, base: OpenPBRMaterial) {
    let hash = baseHashes.get(base);
    if (hash === undefined) { hash = getMaterialHashKey(base); baseHashes.set(base, hash); }
    if (entry.base === base && entry.hash === hash && materialParametersEqual(base, entry.parameters)) return;
    for (const field of materialKeys) (entry.material as unknown as Record<string, unknown>)[field] = base[field];
    if (entry.autoUvProjection) entry.material.uvProjection = 'triplanar';
    if (entry.autoDisplacementUvProjection) entry.material.displacementUvProjection = 'triplanar';
    entry.parameters = snapshotMaterialParameters(base); entry.hash = hash; entry.base = base;
  }
  function materialVariant(source: THREE.Material, base: OpenPBRMaterial,
    autoUvProjection: boolean, autoDisplacementUvProjection: boolean) {
    if (!autoUvProjection && !autoDisplacementUvProjection) return base;
    let variants = store.projectionVariants.get(source);
    if (!variants) { variants = new Map(); store.projectionVariants.set(source, variants); }
    const key = `${+autoUvProjection}:${+autoDisplacementUvProjection}`;
    let variant = variants.get(key);
    if (!variant) {
      variant = { material: new OpenPBRMaterial(), parameters: [],
        autoUvProjection, autoDisplacementUvProjection };
      variants.set(key, variant);
    }
    refreshVariant(variant, base);
    return variant.material;
  }

  function materialHook(source: THREE.Material) {
    if (!options.convertMaterial) return undefined;
    let entry = store.materialHooks.get(source);
    if (!entry || entry.version !== source.version) {
      entry = {version: source.version, value: options.convertMaterial(source)};
      store.materialHooks.set(source, entry);
    }
    return entry.value;
  }
  function lightHook(source: THREE.Light) {
    if (!options.convertLight) return undefined;
    // Three.js Light has no built-in version; applications revise it through userData.
    const revision = source.userData.mutracerVersion;
    const version = typeof revision === 'number' ? revision : undefined;
    let entry = store.lightHooks.get(source);
    if (!entry || entry.version !== version) {
      entry = {version, value: options.convertLight(source)};
      store.lightHooks.set(source, entry);
    }
    return entry.value;
  }
  function resolveMaterial(source: THREE.Material) {
    const custom = materialHook(source);
    if (custom !== undefined) return custom;
    const cached = store.materials.get(source);
    if (convertedMaterials.has(source)) return cached!.material;
    const converted = convertMaterial(source, textureCache);
    const hash = getMaterialHashKey(converted);
    let material = converted;
    if (cached) {
      if (cached.hash !== hash) {
        for (const key of materialKeys) (cached.material as unknown as Record<string, unknown>)[key] = converted[key];
        cached.hash = hash;
      }
      material = cached.material;
    } else store.materials.set(source, {material, hash});
    convertedMaterials.add(source);
    return material;
  }

  function isMesh(node: THREE.Object3D): node is THREE.Mesh {
    return (node as THREE.Mesh).isMesh;
  }
  function isDirectionalLight(
    node: THREE.Object3D
  ): node is THREE.DirectionalLight {
    return (node as THREE.DirectionalLight).isDirectionalLight;
  }
  function isAmbientLight(node: THREE.Object3D): node is THREE.AmbientLight {
    return (node as THREE.AmbientLight).isAmbientLight;
  }
  function isRectAreaLight(node: THREE.Object3D): node is THREE.RectAreaLight {
    return (node as THREE.RectAreaLight).isRectAreaLight;
  }
  function isPointLight(node: THREE.Object3D): node is THREE.PointLight {
    return node.type === 'PointLight';
  }
  function isSpotLight(node: THREE.Object3D): node is THREE.SpotLight {
    return node.type === 'SpotLight';
  }
  scene.updateMatrixWorld(true);
  scene.traverseVisible((child) => {
    if ((child as THREE.Light).isLight) {
      const custom = lightHook(child as THREE.Light);
      if (custom !== undefined) {
        if (custom !== null) lights.push(custom);
        return;
      }
    }
    if (isMesh(child)) {
      if (child.userData.viewerEnvironment) return;
      // Viewer-only proxy geometry is already represented by its source mesh.
      if (child.userData.viewerRealtimeDisplacement) return;
      const childMaterials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      // A null result rejects the source mesh, including all of its groups/instances.
      if (childMaterials.some(material => materialHook(material) === null)) return;
      if (!child.geometry) {
        console.warn(child, 'must have a geometry property');
      } else if (
        childMaterials.some(
          (material) =>
            materialHook(material) === undefined &&
            !(material as THREE.MeshStandardMaterial).isMeshStandardMaterial &&
            !(material as THREE.MeshBasicMaterial).isMeshBasicMaterial &&
            material.userData.mutracerShadowCatcher !== true
        )
      ) {
        console.warn(
          child,
          'must use MeshStandardMaterial or MeshBasicMaterial in order to be rendered.'
        );
      } else {
        const instanced = child as THREE.InstancedMesh;
        const unsupported = (child as THREE.Mesh & { isBatchedMesh?: boolean }).isBatchedMesh ||
          instanced.isInstancedMesh && (!!instanced.morphTexture || (child as THREE.SkinnedMesh).isSkinnedMesh);
        if (unsupported && !store.warned.has(child)) {
          console.warn('MuTracer: BatchedMesh, instanced morph targets and skinned instancing are not supported; converting as an ordinary mesh.', child);
          store.warned.add(child);
        }
        const expand = instanced.isInstancedMesh && !unsupported;
        let deformation: THREEDeformation | undefined;
        let deformed = false;
        if (!unsupported && isDeformingMesh(child)) {
          deformation = store.deformations.get(child);
          if (!deformation?.matches(child.geometry)) {
            deformation = new THREEDeformation(child.geometry); store.deformations.set(child, deformation);
            store.deformedGeometries.delete(child);
          }
          deformed = deformation.update(child);
          store.poseChanged ||= deformed;
        }
        const threeMaterials = childMaterials;
        const groups =
          threeMaterials.length > 1 && child.geometry.groups.length
            ? child.geometry.groups
            : [{ start: 0, count: Infinity, materialIndex: 0 }];
        // Shared static geometry is checked once per update, before its groups.
        // Deforming meshes keep independent entries for their evaluated geometry.
        let entry = deformation ? store.deformedGeometries.get(child) : store.geometries.get(child.geometry);
        if (!entry || entry.checkedAt !== updateId) {
          if (!entry || !geometryStateMatches(child.geometry, entry.state, !!deformation)) {
            entry = { state: geometryState(child.geometry, !!deformation), groups: new Map(), checkedAt: updateId };
            if (deformation) store.deformedGeometries.set(child, entry);
            else store.geometries.set(child.geometry, entry);
          }
          entry.checkedAt = updateId;
        }
        const geometryEntry = entry;
        groups.forEach((group, groupIndex) => {
          const count = Number.isFinite(group.count)
            ? group.count
            : (child.geometry.getIndex()?.count ??
              child.geometry.getAttribute('position').count);
          const sourceMaterial = threeMaterials[group.materialIndex ?? 0];
          // Vertex colors and BackSide orientation are baked into geometry, so
          // groups with different switches cannot share the same cached variant.
          const vertexColors = sourceMaterial.vertexColors === true;
          const backSide = sourceMaterial.side === 1;
          const geometryKey = `${group.start}:${count}:${vertexColors}:${backSide}`;
          let geometry = geometryEntry.groups.get(geometryKey);
          const newGeometry = !geometry;
          if (!geometry) {
            const converted = convertGeometry(child.geometry, { start: group.start, count }, vertexColors, backSide, shareStaticGeometry && !deformation);
            if (!converted) return;
            geometry = converted;
            geometryEntry.groups.set(geometryKey, geometry);
          }
          // A retained color/side variant may predate the current pose.
          if (deformation && (deformed || newGeometry || store.meshes.get(child)?.get(groupIndex)?.geometry !== geometry)) {
            geometry.dynamic = true;
            geometry.position.array.set(deformation.position);
            if (deformation.normal) {
              geometry.normal.array.set(deformation.normal);
              if (backSide) negateNormals(geometry);
            } else {
              // Retain resident attribute storage so a pose change can refit its BVH.
              const normal = geometry.normal;
              generateVertexNormals(geometry);
              normal.array.set(geometry.normal.array);
              geometry.normal = normal;
            }
            if (deformation.tangent && geometry.tangent) {
              geometry.tangent.array.set(deformation.tangent);
              if (backSide) reverseTangentHandedness(geometry);
            }
            if (!child.geometry.getAttribute('tangent')) updateDynamicTangents(geometry);
            updateBoundingBox(geometry);
            if (!newGeometry) markDeformedGeometry(geometry);
          }
          let material = resolveMaterial(sourceMaterial)!;
          const baseMaterial = material;
          const autoUvProjection = !geometry.uv && baseMaterial.uvProjection === 'none' &&
            !!(baseMaterial.map || baseMaterial.normalMap || baseMaterial.emissiveMap || baseMaterial.metallicRoughnessMap ||
              baseMaterial.roughnessMap || baseMaterial.metalnessMap || baseMaterial.thinFilmMap ||
              baseMaterial.coatWeightMap || baseMaterial.coatRoughnessMap || baseMaterial.fuzzColorMap ||
              baseMaterial.fuzzRoughnessMap || baseMaterial.specularWeightMap || baseMaterial.specularColorMap || baseMaterial.anisotropyMap || baseMaterial.coatNormalMap);
          const autoDisplacementUvProjection = !geometry.uv && !!baseMaterial.displacementMap &&
            baseMaterial.displacementUvProjection === 'none';
          const instanceCount = expand ? instanced.count : 1;
          if (expand) {
            let batchesByGroup = store.instanceMeshes.get(child);
            if (!batchesByGroup) { batchesByGroup = new Map(); store.instanceMeshes.set(child, batchesByGroup); }
            const variant = materialVariant(sourceMaterial, baseMaterial, autoUvProjection, autoDisplacementUvProjection);
            let batch = batchesByGroup.get(groupIndex);
            if (!batch) {
              batch = new InstancedMesh(geometry, variant, {count: instanceCount});
              batch.transform = child.matrixWorld.elements.slice() as number[];
              batchesByGroup.set(groupIndex, batch);
            }
            batch.geometry = geometry;
            if (batch.materials[0] !== variant) batch.materials = [variant];
            let changed = batch.count !== instanceCount;
            if (batch.transforms.length < instanceCount * 16) {
              batch.transforms = new Float32Array(instanceCount * 16); changed = true;
            }
            // Grow colors before count validation in either notification method.
            const sourceColors = instanced.instanceColor;
            let colorsChanged = false;
            if (sourceColors) {
              if (!batch.colors || batch.colors.length < instanceCount * 3) batch.colors = new Float32Array(instanceCount * 3);
              for (let i = 0; i < instanceCount; i++) {
                for (let k = 0; k < 3; k++) {
                  const value = Math.fround(k === 0 ? sourceColors.getX(i) : k === 1 ? sourceColors.getY(i) : sourceColors.getZ(i));
                  if (!Object.is(batch.colors[i * 3 + k], value)) { batch.colors[i * 3 + k] = value; colorsChanged = true; }
                }
              }
            } else batch.colors = undefined;
            batch.count = instanceCount;
            const matrices = instanced.instanceMatrix;
            for (let i = 0; i < instanceCount; i++) for (let k = 0; k < 16; k++) {
              const value = Math.fround(matrices.array[i * matrices.itemSize + k]);
              if (!Object.is(batch.transforms[i * 16 + k], value)) { batch.transforms[i * 16 + k] = value; changed = true; }
            }
            for (let i = 0; i < 16; i++) batch.transform[i] = child.matrixWorld.elements[i];
            if (changed) batch.markTransformsUpdated();
            if (colorsChanged) batch.markColorsUpdated();
            batch.name = child.name || `Mesh ${meshes.length + 1}${groups.length > 1 ? `.${groupIndex + 1}` : ''}`;
            if (instanceCount > 0) { meshes.push(batch); options.onMeshConverted?.(batch, child, group, groupIndex); }
          } else {
            material = materialVariant(sourceMaterial, baseMaterial, autoUvProjection, autoDisplacementUvProjection);
            let meshGroups = store.meshes.get(child);
            if (!meshGroups) { meshGroups = new Map(); store.meshes.set(child, meshGroups); }
            let mesh = meshGroups.get(groupIndex);
            if (!mesh) {
              mesh = new Mesh(geometry, material);
              mesh.transform = child.matrixWorld.elements.slice() as number[];
              meshGroups.set(groupIndex, mesh);
            }
            mesh.geometry = geometry;
            if (mesh.materials[0] !== material) mesh.materials = [material];
            mesh.name = child.name || `Mesh ${meshes.length + 1}${groups.length > 1 ? `.${groupIndex + 1}` : ''}`;
            for (let i = 0; i < 16; i++) mesh.transform[i] = child.matrixWorld.elements[i];
            meshes.push(mesh); options.onMeshConverted?.(mesh, child, group, groupIndex);
          }
        });
      }
    } else if (isDirectionalLight(child)) {
      const light = new DirectionalLight({color: child.color.toArray() as ColorRGB, intensity: child.intensity});
      light.transform = Array.from(light.transform);
      light.position = child.getWorldPosition(child.position.clone()).toArray();
      light.lookAt(child.target.getWorldPosition(child.target.position.clone()).toArray());
      lights.push(retainLight(store, child, light));
    } else if (isRectAreaLight(child)) {
      const worldMatrix = child.matrixWorld.clone();
      // Shear decomposition can return a non-unit quaternion. The size below
      // carries scale; this approximated rectangle's sampling frame is rigid.
      const worldRotation = child.getWorldQuaternion(child.quaternion.clone()).normalize();
      const worldPosition = child.getWorldPosition(child.position.clone());
      const elements = worldMatrix.elements;
      const widthScale = Math.hypot(elements[0], elements[1], elements[2]);
      const heightScale = Math.hypot(elements[4], elements[5], elements[6]);
      const light = new RectLight({
        size: [child.width * widthScale, child.height * heightScale],
        color: child.color.toArray() as ColorRGB,
        intensity: child.intensity
      });
      worldMatrix.compose(worldPosition, worldRotation, child.scale.clone().set(1, 1, 1));
      light.transform = worldMatrix.elements.slice() as number[];
      lights.push(retainLight(store, child, light));
    } else if (isSpotLight(child)) {
      const worldPosition = child.getWorldPosition(child.position.clone());
      const worldTarget = child.target.getWorldPosition(
        child.target.position.clone()
      );
      const outerAngle = (child.angle * 180) / Math.PI;
      const profile = child.userData.mutracerIesProfile;
      if (profile != null && !(profile instanceof IESProfile)) {
        throw new Error(
          `THREE.SpotLight "${child.name || '<unnamed>'}" has an invalid mutracerIesProfile`
        );
      }
      const light = new SpotLight({
        color: child.color.toArray() as ColorRGB,
        intensity: child.intensity,
        radius: child.userData.mutracerRadius ?? 0.01,
        innerAngle: outerAngle * (1 - child.penumbra),
        outerAngle,
        iesProfile: profile
      });
      light.transform = Array.from(light.transform);
      light.position = worldPosition.toArray();
      light.lookAt(worldTarget.toArray());
      const rotation = -(child.userData.mutracerIesRotation ?? 0) * Math.PI / 180;
      if (rotation) mat4.rotateZ(light.transform, light.transform, rotation);
      lights.push(retainLight(store, child, light));
    } else if (isPointLight(child)) {
      const world = child.matrixWorld.elements;
      const position: [number, number, number] = [
        world[12],
        world[13],
        world[14]
      ];
      lights.push(retainLight(store, child,
        Object.assign(new SphereLight({
          color: child.color.toArray() as ColorRGB,
          intensity: child.intensity,
          radius: child.userData.mutracerRadius ?? 0.25
        }), { transform: [1,0,0,0, 0,1,0,0, 0,0,1,0, ...position,1] })
      ));
    } else if (isAmbientLight(child)) {
      lights.push(retainLight(store, child,
        new AmbientLight({color: child.color.toArray() as ColorRGB, intensity: child.intensity})
      ));
    }
  });

  const threeEnvironment = scene.environment as THREE.DataTexture | null;
  const environmentMap = options.environment ?? convertDataTexture(threeEnvironment, store.equirectTextures);
  const environmentSource = options.environment ?? threeEnvironment;
  const environmentLight = environmentSource && environmentMap
    ? retainLight(store, environmentSource, new EnvironmentLight({map: environmentMap, intensity: scene.environmentIntensity})) as EnvironmentLight
    : undefined;
  if (environmentLight) {
    environmentLight.transform = scene.matrix.clone().makeRotationFromEuler(scene.environmentRotation).elements.slice();
    lights.push(environmentLight);
  }

  const grounded = scene.userData.mutracerGroundedSkybox as
    | {
        texture: THREE.DataTexture | Texture;
        height: number;
        radius: number;
        groundHeight?: number;
        center?: [number, number];
        rotation?: number;
        intensity?: number;
      }
    | undefined;
  const groundedTexture = grounded && (grounded.texture instanceof Texture ? grounded.texture : convertDataTexture(grounded.texture, store.equirectTextures));
  const hideEnvironmentBackground =
    scene.userData.mutracerHiddenBackground === true;
  let background: Scene['background'] =
    hideEnvironmentBackground
      ? [0, 0, 0, 0]
      : grounded && groundedTexture
        ? {
            type: 'GroundedSkybox',
            map: groundedTexture,
            height: grounded.height,
            radius: grounded.radius,
            groundHeight: grounded.groundHeight,
            center: grounded.center,
            rotation: grounded.rotation,
            intensity: grounded.intensity
          }
        : scene.background
          ? (scene.background as THREE.Color).isColor
            ? ([...(scene.background as THREE.Color).toArray(), 1] as ColorRGBA)
            : scene.background === scene.environment && environmentLight
              ? environmentLight.map
              : convertDataTexture(scene.background as THREE.DataTexture, store.equirectTextures)
          : undefined;

  // Grounded skyboxes own their level-ground yaw and intensity; Three.js
  // backgroundRotation and backgroundIntensity apply only to the explicit
  // equirectangular background.
  const rotation = scene.backgroundRotation;
  const rotated = !!rotation && (rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0);
  const intensity = scene.backgroundIntensity ?? 1;
  if (background instanceof Texture && (rotated || intensity !== 1)) {
    background = {type: 'Equirect', map: background,
      transform: rotated ? scene.matrix.clone().makeRotationFromEuler(rotation).elements.slice() : undefined,
      intensity: intensity !== 1 ? intensity : undefined};
  }

  const oldBackground = store.background;
  if (Array.isArray(background) && Array.isArray(oldBackground) && snapshotsEqual(background, oldBackground)) {
    background = oldBackground;
  } else if (background && oldBackground && !Array.isArray(background) && !Array.isArray(oldBackground)
    && !(background instanceof Texture) && !(oldBackground instanceof Texture)
    && background.type === oldBackground.type) {
    // Compare by values, ignoring the newly constructed wrapper's identity.
    if (snapshotsEqual(snapshotFields(background).slice(1), snapshotFields(oldBackground).slice(1))) background = oldBackground;
    else { Object.assign(oldBackground, background); background = oldBackground; }
  }
  store.background = background;
  // Inspect the final converted meshes, including onMeshConverted overrides.
  // Iterate across source materials so removed/hidden objects are pruned too.
  const usedMaterials = new Set(meshes.flatMap(mesh => mesh.materials));
  for (const [source, variants] of store.projectionVariants) {
    for (const [key, variant] of variants) if (!usedMaterials.has(variant.material)) variants.delete(key);
    if (!variants.size) store.projectionVariants.delete(source);
  }
  return {
    background,
    meshes,
    lights
  };
}

/** Structural control interface; no Three.js imports are needed in core APIs. */
export interface THREEControls {
  update(deltaTime?: number): boolean | void;
  addEventListener(type: 'start' | 'end', listener: () => void): void;
  removeEventListener(type: 'start' | 'end', listener: () => void): void;
  target?: THREE.Vector3;
  enableDamping?: boolean;
  /** Damping per 60 Hz frame; synchronization adjusts it for elapsed time. Default undefined uses the control's own timing. */
  dampingFactor?: number;
  autoRotate?: boolean;
  enabled?: boolean;
  /** Optional OrbitControls polar-angle accessor. Default undefined. */ getPolarAngle?(): number;
  /** Optional OrbitControls azimuthal-angle accessor. Default undefined. */ getAzimuthalAngle?(): number;
}
/** Three.js sources synchronized on each tick. */
export interface THREESyncOptions extends FromTHREESceneOptions {
  /** Scene source. Default undefined (engine.scene is untouched). */ scene?: THREE.Scene;
  /** Camera source. Default undefined (engine.camera is untouched). */ camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** Camera controls. Default undefined. */ controls?: THREEControls;
  /** Call controls.update during synchronization. Default true. */ updateControls?: boolean;
}

/** Inputs that can wake an idle OrbitControls instance, without inspecting its private inertia. */
function orbitControlsState(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined, controls: THREEControls): unknown[] | undefined {
  if (!camera || !controls.getPolarAngle || !controls.getAzimuthalAngle) return;
  camera.parent?.updateWorldMatrix(true, false);
  const state: unknown[] = [camera, controls.update, camera.parent, ...camera.position.toArray(), ...camera.quaternion.toArray(),
    ...camera.scale.toArray(), ...camera.up.toArray(), camera.zoom, ...(camera.parent?.matrixWorld.elements ?? [])];
  for (const [key, value] of Object.entries(controls)) {
    // Pointer-down changes the gesture state without changing the view.
    if (key.startsWith('_') || key === 'state') continue;
    const vector = value as THREE.Vector3 | undefined;
    if (vector?.isVector3) state.push(key, ...vector.toArray());
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') state.push(key, value);
  }
  return state;
}
/**
 * Keeps one MuTracer scene in sync with a Three.js scene, reusing unchanged objects.
 * Skinning/morph targets run on the CPU with per-source-mesh dynamic geometry.
 * InstancedMesh retains its prefix on count changes and shares geometry/BLAS;
 * Instance colors use native batch storage; automatic UV-less projections
 * share cached material variants per source material. Source edits refresh variants; unused variants
 * are removed after each update.
 */
export class THREESync extends Sync {
  /** @internal Viewer-owned static source storage; default library conversions remain independent. */
  _shareStaticGeometry = false;
  /** Retained converted scene; absent when no scene source was supplied. */
  readonly scene: Scene | undefined;
  /** Retained converted camera; absent until the first camera update. */
  private _camera?: Camera;
  private _store = createConversionStore();
  private _disposed = false;
  private _started = false;
  private _gestureChanged = false;
  private _cameraState: unknown[] = [];
  private _lastUpdate?: number;
  private _idleControlsState?: unknown[];
  private _start = () => {this._started = true; this._gestureChanged = false;};
  private _end = () => {this._started = false;};
  /** Subscribes to controls without converting sources or modifying the engine. */
  constructor(engine: Engine, private _options: THREESyncOptions = {}) {
    super(engine);
    if (_options.scene) this.scene = {meshes: [], lights: []};
    _options.controls?.addEventListener('start', this._start);
    _options.controls?.addEventListener('end', this._end);
  }
  /** Updates controls, world matrices, retained instances and camera before engine.update. */
  update(): void {
    if (this._disposed) throw new Error('THREESync has been disposed');
    const now = performance.now(), controls = this._options.controls, sourceCamera = this._options.camera;
    const elapsed = this._lastUpdate === undefined ? 0 : Math.max(0, (now - this._lastUpdate) / 1000);
    const dt = Math.min(.1, elapsed);
    this._lastUpdate = now;
    let moving = false, settled = false;
    if (controls && this._options.updateControls !== false) {
      const orbitInputs = orbitControlsState(sourceCamera, controls);
      // OrbitControls applies pointer movement before synchronization. Keep a
      // settled camera untouched on pointer-down until its inputs actually change.
      const idle = (!this._started || !this._gestureChanged) && !controls.autoRotate && orbitInputs && this._idleControlsState && snapshotsEqual(orbitInputs, this._idleControlsState);
      if (!idle) {
        this._idleControlsState = undefined;
        const position = sourceCamera?.position.clone(), rotation = sourceCamera?.quaternion.clone(), zoom = sourceCamera?.zoom;
        const target = controls.target?.clone(), damping = controls.dampingFactor;
        const frameDamping = controls.enableDamping && damping !== undefined && damping >= 0 && damping <= 1
          ? 1 - Math.pow(1 - damping, elapsed * 60) : undefined;
        if (frameDamping !== undefined) controls.dampingFactor = frameDamping;
        try {moving = !!controls.update(dt);}
        finally {if (frameDamping !== undefined) controls.dampingFactor = damping;}
        if (!this._started && !controls.autoRotate && controls.enableDamping && position && sourceCamera && controls.target) {
          const referenceScale = frameDamping ? damping! / frameDamping : 1;
          const step = position.distanceTo(sourceCamera.position) * referenceScale;
          const zoomStep = Math.abs(Math.log(sourceCamera.zoom / zoom!)) * referenceScale;
          const poseChanged = step > 0 || sourceCamera.zoom !== zoom || !!(orbitInputs && (!rotation!.equals(sourceCamera.quaternion) || !target!.equals(controls.target)));
          // End the remaining inertia once its 60 Hz movement is imperceptible.
          // update() can return false before that tail has actually stopped.
          if ((moving || poseChanged) && step < 5e-4 * sourceCamera.position.distanceTo(controls.target) && zoomStep < 5e-4) {
            controls.enableDamping = false;
            try {controls.update(0);} finally {controls.enableDamping = true;}
            moving = false; settled = true;
          }
          // Once stopped, no more spherical/cartesian round trips occur until
          // a gesture, source pose, parent transform or public control option changes.
          if (orbitInputs && (settled || (!moving && !poseChanged))) this._idleControlsState = orbitControlsState(sourceCamera, controls);
        } else if (orbitInputs && !this._started && !controls.autoRotate && !moving) {
          this._idleControlsState = orbitControlsState(sourceCamera, controls);
        }
      }
    }
    this._store.poseChanged = false;
    if (this._options.scene && this.scene) {
      const next = convertScene(this._options.scene, this._options, this._store, this._shareStaticGeometry);
      if (!snapshotsEqual(this.scene.meshes, next.meshes)) this.scene.meshes = next.meshes;
      if (!snapshotsEqual(this.scene.lights, next.lights)) this.scene.lights = next.lights;
      this.scene.background = next.background;
      this.engine.scene = this.scene;
    }
    let cameraChanged = false;
    if (sourceCamera) {
      sourceCamera.updateWorldMatrix(true, false);
      const next = fromTHREECamera(sourceCamera);
      const state = snapshotFields(next).slice(1);
      cameraChanged = this._cameraState.length > 0 && !snapshotsEqual(state, this._cameraState);
      this._cameraState = state;
      if (!this._camera) this._camera = next; else this._camera.copy(next);
      this.engine.camera = this._camera;
    }
    if (this._started && (moving || cameraChanged)) this._gestureChanged = true;
    this.setActive((this._started && this._gestureChanged) || moving || this._store.poseChanged || (cameraChanged && !settled));
  }
  /** Removes control subscriptions and caches. The last converted objects remain usable. */
  dispose(): void {
    if (this._disposed) return;
    this._options.controls?.removeEventListener('start', this._start);
    this._options.controls?.removeEventListener('end', this._end);
    this._store = createConversionStore(); this._idleControlsState = undefined; this._disposed = true; super.dispose();
  }
}

/** Lens settings for {@link fromTHREECamera}. */
export interface FromTHREECameraOptions {
  /** Lens f-number; `0` disables depth of field. Default `0`. */
  fStop?: number;
  /**
   * Distance to the plane in focus in scene units. Default: the perspective
   * camera's `focus` (Three.js default `10`), otherwise `10`.
   */
  focusDistance?: number;
  /** Length of one scene unit in metres. Default `1`. */
  metersPerUnit?: number;
}

/**
 * Converts a Three.js perspective or orthographic camera. A perspective
 * camera's `focus` and film height (`filmGauge` and `aspect`) become
 * `focusDistance` and `sensorHeight`.
 */
export function fromTHREECamera(
  threeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  options: FromTHREECameraOptions = {}
) {
  const camera = (threeCamera as THREE.PerspectiveCamera).fov
    ? new Camera({projection: 'perspective', fov: (threeCamera as THREE.PerspectiveCamera).fov, aspect: (threeCamera as THREE.PerspectiveCamera).aspect, near: (threeCamera as THREE.PerspectiveCamera).near, far: (threeCamera as THREE.PerspectiveCamera).far})
    : new Camera({projection: 'orthographic', left: (threeCamera as THREE.OrthographicCamera).left, right: (threeCamera as THREE.OrthographicCamera).right, bottom: (threeCamera as THREE.OrthographicCamera).bottom, top: (threeCamera as THREE.OrthographicCamera).top, near: (threeCamera as THREE.OrthographicCamera).near, far: (threeCamera as THREE.OrthographicCamera).far});
  threeCamera.updateWorldMatrix(true, false);
  camera.zoom = threeCamera.zoom;
  camera.transform =
    threeCamera.matrixWorld.elements.slice() as number[];
  const perspective = threeCamera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    if (perspective.focus > 0) camera.focusDistance = perspective.focus;
    const filmHeight = perspective.getFilmHeight();
    if (filmHeight > 0) camera.sensorHeight = filmHeight;
  }
  if (options.fStop !== undefined) camera.fStop = options.fStop;
  if (options.focusDistance !== undefined) {
    camera.focusDistance = options.focusDistance;
  }
  if (options.metersPerUnit !== undefined) {
    camera.metersPerUnit = options.metersPerUnit;
  }
  return camera;
}
