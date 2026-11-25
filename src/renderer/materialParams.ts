import type MaterialState from '../scene/MaterialState.js';
import { resolveMaterialAlphaMode } from '../scene/MaterialState.js';
import { specularAnisotropyModelIndex, finiteAnisotropySource } from '../scene/anisotropyParameters.js';
import { finiteFilmThickness, thinFilmMapChannelIndex } from '../scene/thinFilmParameters.js';
import { mapAlphaUsageConstants, uvProjectionConstants, materialAlphaModeConstants } from './materialConstants.js';
import { ShadowCatcherMaterial, UnlitMaterial } from '../constants.js';
import { materialEmission } from './materialEmission.js';
import type { ColorRGB } from '../types.js';
import type { MaterialTextureIndex } from './materialTextureSlots.js';
import type { BufferData } from './materialBufferData.js';

// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

export function materialUsesMedium(material: MaterialState): boolean {
  return !material.thinWalled && (
    (material.transmissionWeight > 0 && material.transmissionDepth > 0) ||
    material.subsurfaceWeight > 0
  );
}


function clampChannel(channel: number, fallback: number) {
  const value = Number(channel);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}
function clampColor(color: ColorRGB, fallback = 0): ColorRGB {
  return [clampChannel(color[0], fallback), clampChannel(color[1], fallback), clampChannel(color[2], fallback)];
}
function colorValue(color: ColorRGB, index: number): number {
  if (index === 0) return color[0];
  if (index === 1) return color[1];
  return color[2];
}
function mapColor(color: ColorRGB, map: (value: number, index: number) => number): ColorRGB {
  return [map(color[0], 0), map(color[1], 1), map(color[2], 2)];
}
function colorChannels(map: (index: number) => number): ColorRGB {
  return [map(0), map(1), map(2)];
}

type OpenPbrMedium = {
  anisotropy: number;
  extinction: ColorRGB;
  scattering: ColorRGB;
};

function emptyOpenPbrMedium(): OpenPbrMedium {
  return {
    anisotropy: 0,
    extinction: [0, 0, 0],
    scattering: [0, 0, 0]
  };
}

function transmissionMedium(material: MaterialState) {
  const weight = Math.min(1, Math.max(0, material.transmissionWeight));
  const depth = Math.max(0, material.transmissionDepth);
  if (weight <= 0 || depth <= 0 || material.thinWalled) return undefined;

  const color = clampColor(material.transmissionColor, 1);
  const scatterColor = clampColor(material.transmissionScatter);
  const extinction = mapColor(color, (channel) =>
    Math.max(0, -Math.log(Math.max(channel, 1e-6)) / depth)
  ) as ColorRGB;
  const scattering = mapColor(scatterColor, (channel, index) =>
    colorValue(extinction, index) * channel
  ) as ColorRGB;
  return {
    anisotropy: Math.min(
      0.999,
      Math.max(-0.999, material.transmissionScatterAnisotropy)
    ),
    extinction,
    scattering
  } satisfies OpenPbrMedium;
}

function subsurfaceMedium(material: MaterialState) {
  const weight = Math.min(1, Math.max(0, material.subsurfaceWeight));
  if (weight <= 0 || material.thinWalled) return undefined;

  // OpenPBR's radius is the extinction mean free path. The van de Hulst
  // mapping converts the artist-facing multiple-scattering color to a
  // single-scattering albedo while compensating for phase anisotropy.
  const radius = Math.max(material.subsurfaceRadius, 1e-3);
  const radiusScale = clampColor(material.subsurfaceRadiusScale, 1);
  const color = clampColor(material.subsurfaceColor);
  const anisotropy = Math.min(
    0.999,
    Math.max(-0.999, material.subsurfaceAnisotropy)
  );
  const extinction = mapColor(radiusScale,
    (scale) => 1 / Math.max(radius * scale, 1e-3)
  ) as ColorRGB;
  const scattering = mapColor(color, (channel, index) => {
    const s = 4.09712 + 4.20863 * channel - Math.sqrt(
      9.59217 + 41.6808 * channel + 17.7126 * channel * channel
    );
    const sSquared = s * s;
    const albedo = Math.min(
      1,
      Math.max(0, (1 - sSquared) / (1 - anisotropy * sSquared))
    );
    return colorValue(extinction, index) * albedo;
  }) as ColorRGB;
  return { anisotropy, extinction, scattering } satisfies OpenPbrMedium;
}

function combineOpenPbrMedia(
  material: MaterialState,
  transmission: OpenPbrMedium | undefined,
  subsurface: OpenPbrMedium | undefined
) {
  const transmissionFraction = transmission
    ? Math.min(1, Math.max(0, material.transmissionWeight))
    : 0;
  const subsurfaceFraction = subsurface
    ? (1 - transmissionFraction)
      * Math.min(1, Math.max(0, material.subsurfaceWeight))
    : 0;
  const total = transmissionFraction + subsurfaceFraction;
  if (total <= 0) return undefined;

  const transmissionWeight = transmissionFraction / total;
  const subsurfaceWeight = subsurfaceFraction / total;
  const extinction = colorChannels((channel) => {
    const transmissionAbsorption = transmission
      ? colorValue(transmission.extinction, channel) - colorValue(transmission.scattering, channel)
      : 0;
    const subsurfaceAbsorption = subsurface
      ? colorValue(subsurface.extinction, channel) - colorValue(subsurface.scattering, channel)
      : 0;
    const absorption = transmissionAbsorption * transmissionWeight
      + subsurfaceAbsorption * subsurfaceWeight;
    const scattering = ((transmission ? colorValue(transmission.scattering, channel) : 0) || 0)
        * transmissionWeight
      + ((subsurface ? colorValue(subsurface.scattering, channel) : 0) || 0) * subsurfaceWeight;
    return Math.max(0, absorption + scattering);
  }) as ColorRGB;
  const scattering = colorChannels((channel) =>
    ((transmission ? colorValue(transmission.scattering, channel) : 0) || 0) * transmissionWeight
      + ((subsurface ? colorValue(subsurface.scattering, channel) : 0) || 0) * subsurfaceWeight
  ) as ColorRGB;
  const anisotropy = (transmission?.anisotropy || 0) * transmissionWeight
    + (subsurface?.anisotropy || 0) * subsurfaceWeight;
  return { anisotropy, extinction, scattering } satisfies OpenPbrMedium;
}

function openPbrMedium(material: MaterialState) {
  const volume = combineOpenPbrMedia(
    material,
    transmissionMedium(material),
    subsurfaceMedium(material)
  );
  return volume ?? emptyOpenPbrMedium();
}


export type MaterialParameterData = Omit<BufferData, MaterialTextureIndex | 'mapInfo' | 'mapTransform' | 'mapWrap' | 'mapUvChannel' | 'mapColorLinear'>;

export function packMaterialParams(materials: MaterialState[]) {
  const media = materials.map(openPbrMedium);
  return {
    color: materials.map((m) => [m.baseColor[0], m.baseColor[1], m.baseColor[2]] as ColorRGB),
    roughness: materials.map(m => m.specularAnisotropyModel === 'gltf' ? finiteAnisotropySource(m.specularRoughness, 0.3) : m.specularRoughness),
    emission: materials.map(materialEmission),
    metallic: materials.map((m) => m.baseMetalness),
    ior: materials.map((m) => m.specularIor),
    dispersion: materials.map((m) => m.transmissionDispersionScale),
    thin: materials.map((m) => Number(m.thinWalled)),
    bevelSize: materials.map((m) => m.bevelSize),
    transmission: materials.map((m) => m.transmissionWeight),
    anisotropy: materials.map(m => m.specularAnisotropyModel === 'gltf' ? finiteAnisotropySource(m.specularAnisotropy, 0) : m.specularAnisotropy),
    specularAnisotropyModel: materials.map(m => specularAnisotropyModelIndex(m.specularAnisotropyModel)),
    thinFilmThickness: materials.map((m) => finiteFilmThickness(m.thinFilmThickness, 0.5)),
    thinFilmThicknessMinimum: materials.map((m) => finiteFilmThickness(m.thinFilmThicknessMinimum, 0)),
    thinFilmMapChannel: materials.map((m) => thinFilmMapChannelIndex(m.thinFilmMapChannel)),
    thinFilmIor: materials.map((m) => m.thinFilmIor),
    normalScale: materials.map((m) => m.normalScale),
    mapAlphaUsage: materials.map((m) => mapAlphaUsageConstants[m.mapAlphaUsage]),
    type: materials.map((m) => {
      if (m.shadowCatcher) {
        return ShadowCatcherMaterial;
      }
      if (m.unlit) {
        return UnlitMaterial;
      }
      // Standard material
      return 0;
    }),
    // Retain mediumType until both legacy readers are migrated; the
    // direction and coat-normal inputs are reserved for later C1 steps.
    mediumType: materials.map((m) => Number(materialUsesMedium(m))),
    specularAnisotropyRotation: materials.map(m => Number.isFinite(m.specularAnisotropyRotation) ? m.specularAnisotropyRotation : 0),
    coatAnisotropyRotation: materials.map(m => Number.isFinite(m.coatAnisotropyRotation) ? m.coatAnisotropyRotation : 0),
    coatNormalScale: materials.map(m => m.coatNormalScale),
    uvProjection: materials.map(
      (m) => uvProjectionConstants[m.uvProjection] || 0
    ),
    uvScale: materials.map((m) => m.uvProjectionScale || [1, 1]),

    displacementUvProjection: materials.map(
      (m) => uvProjectionConstants[m.displacementUvProjection] || 0
    ),
    displacementUvProjectionScale: materials.map((m) => m.displacementUvProjectionScale || 1),
    displacementBias: materials.map(m => m.displacementBias),
    displacementStepSize: materials.map(
      (m) => Number.isFinite(m.displacementStepSize) && m.displacementStepSize > 0 ? m.displacementStepSize : 0
    ),

    // Alpha
    alpha: materials.map((m) => m.opacity),
    alphaMode: materials.map(
      (m) => materialAlphaModeConstants[resolveMaterialAlphaMode(m)]
    ),
    alphaCutoff: materials.map((m) => Math.max(0, m.alphaCutoff)),
    doubleSided: materials.map((m) => Number(m.doubleSided)),

    baseWeight: materials.map((m) => m.baseWeight),
    baseDiffuseRoughness: materials.map((m) => m.baseDiffuseRoughness),
    specularWeight: materials.map((m) => m.specularWeight),
    specularColor: materials.map((m) => clampColor(m.specularColor, 1)),
    transmissionColor: materials.map((m) => clampColor(m.transmissionColor, 1)),
    transmissionDepth: materials.map((m) => Math.max(0, m.transmissionDepth)),
    transmissionScatter: materials.map((m) => clampColor(m.transmissionScatter)),
    transmissionScatterAnisotropy: materials.map((m) => m.transmissionScatterAnisotropy),
    subsurfaceWeight: materials.map((m) => m.subsurfaceWeight),
    subsurfaceColor: materials.map((m) => clampColor(m.subsurfaceColor)),
    subsurfaceRadius: materials.map((m) => Math.max(0, m.subsurfaceRadius)),
    subsurfaceRadiusScale: materials.map((m) => clampColor(m.subsurfaceRadiusScale)),
    subsurfaceScatterAnisotropy: materials.map((m) => m.subsurfaceAnisotropy),
    fuzzWeight: materials.map((m) => m.fuzzWeight),
    fuzzColor: materials.map((m) => clampColor(m.fuzzColor, 1)),
    fuzzRoughness: materials.map((m) => m.fuzzRoughness),
    coatWeight: materials.map((m) => m.coatWeight),
    coatColor: materials.map((m) => clampColor(m.coatColor, 1)),
    coatRoughness: materials.map((m) => m.coatRoughness),
    coatAnisotropy: materials.map((m) => m.coatAnisotropy),
    coatIor: materials.map((m) => m.coatIor),
    coatDarkening: materials.map((m) => m.coatDarkening),
    thinFilmWeight: materials.map((m) => m.thinFilmWeight),
    dispersionAbbeNumber: materials.map((m) => m.transmissionDispersionAbbeNumber),
    mediumExtinction: media.map((medium) => medium.extinction),
    mediumScattering: media.map((medium) => medium.scattering),
    mediumAnisotropy: media.map((medium) => medium.anisotropy),

  } satisfies MaterialParameterData;
}

export function createMaterialBufferData(materials: MaterialState[]): BufferData {
  return { ...packMaterialParams(materials),
    diffuseMapIndex: [],
    alphaMapIndex: [],
    normalMapIndex: [],
    emissiveMapIndex: [],
    metallicRoughnessMapIndex: [],
    roughnessMapIndex: [],
    metalnessMapIndex: [],
    transmissionMapIndex: [],
    thinFilmMapIndex: [],
    displacementMapIndex: [],
    coatWeightMapIndex: [],
    coatRoughnessMapIndex: [],
    fuzzColorMapIndex: [],
    fuzzRoughnessMapIndex: [],
    specularWeightMapIndex: [],
    specularColorMapIndex: [],
    anisotropyMapIndex: [],
    coatNormalMapIndex: [],
    mapInfo: [], mapTransform: [], mapWrap: [], mapUvChannel: [], mapColorLinear: [] };
}

export function repackMaterialParams(data: BufferData, materials: MaterialState[]) {
  const params = packMaterialParams(materials);
  data.color = params.color;
  data.roughness = params.roughness;
  data.emission = params.emission;
  data.metallic = params.metallic;
  data.ior = params.ior;
  data.dispersion = params.dispersion;
  data.thin = params.thin;
  data.bevelSize = params.bevelSize;
  data.transmission = params.transmission;
  data.anisotropy = params.anisotropy;
  data.specularAnisotropyModel = params.specularAnisotropyModel;
  data.thinFilmThickness = params.thinFilmThickness;
  data.thinFilmThicknessMinimum = params.thinFilmThicknessMinimum;
  data.thinFilmMapChannel = params.thinFilmMapChannel;
  data.thinFilmIor = params.thinFilmIor;
  data.normalScale = params.normalScale;
  data.mapAlphaUsage = params.mapAlphaUsage;
  data.type = params.type;
  data.mediumType = params.mediumType;
  data.specularAnisotropyRotation = params.specularAnisotropyRotation;
  data.coatAnisotropyRotation = params.coatAnisotropyRotation;
  data.coatNormalScale = params.coatNormalScale;
  data.uvProjection = params.uvProjection;
  data.uvScale = params.uvScale;
  data.displacementUvProjection = params.displacementUvProjection;
  data.displacementUvProjectionScale = params.displacementUvProjectionScale;
  data.displacementStepSize = params.displacementStepSize;
  data.alpha = params.alpha;
  data.alphaMode = params.alphaMode;
  data.alphaCutoff = params.alphaCutoff;
  data.doubleSided = params.doubleSided;
  data.baseWeight = params.baseWeight;
  data.baseDiffuseRoughness = params.baseDiffuseRoughness;
  data.specularWeight = params.specularWeight;
  data.specularColor = params.specularColor;
  data.transmissionColor = params.transmissionColor;
  data.transmissionDepth = params.transmissionDepth;
  data.transmissionScatter = params.transmissionScatter;
  data.transmissionScatterAnisotropy = params.transmissionScatterAnisotropy;
  data.subsurfaceWeight = params.subsurfaceWeight;
  data.subsurfaceColor = params.subsurfaceColor;
  data.subsurfaceRadius = params.subsurfaceRadius;
  data.subsurfaceRadiusScale = params.subsurfaceRadiusScale;
  data.subsurfaceScatterAnisotropy = params.subsurfaceScatterAnisotropy;
  data.fuzzWeight = params.fuzzWeight;
  data.fuzzColor = params.fuzzColor;
  data.fuzzRoughness = params.fuzzRoughness;
  data.coatWeight = params.coatWeight;
  data.coatColor = params.coatColor;
  data.coatRoughness = params.coatRoughness;
  data.coatAnisotropy = params.coatAnisotropy;
  data.coatIor = params.coatIor;
  data.coatDarkening = params.coatDarkening;
  data.thinFilmWeight = params.thinFilmWeight;
  data.dispersionAbbeNumber = params.dispersionAbbeNumber;
  data.mediumExtinction = params.mediumExtinction;
  data.mediumScattering = params.mediumScattering;
  data.mediumAnisotropy = params.mediumAnisotropy;
}
