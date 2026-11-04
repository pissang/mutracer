import {materialNeedsVertexTangents} from './tangentRequirements.js';
import type MaterialState from '../scene/MaterialState.js';
import { resolveMaterialAlphaMode } from '../scene/MaterialState.js';
import type Geometry from '../scene/Geometry.js';
import type MaterialData from './MaterialData.js';
import { materialUsesMedium } from './materialParams.js';
import { materialTextureFeatures } from './materialTextureSlots.js';
import {MATERIAL_SHADER_CAPABILITIES} from './shaderCapabilities.js';

// Same feature decisions for browser pipeline updates and native scene commits.
export function wgpuMaterialConstants(materials: MaterialState[], materialData: Pick<MaterialData, 'defines' | 'bufferData'>, mergedGeometry: Geometry,
  bevelSamples: number, previousNumMaps = 0): Record<string, boolean | number> {
  const HAS_BEVEL = materials.some((m) => m.bevelSize > 0);
  const SPECTRAL =
    materials.some((m) => m.transmissionDispersionScale > 0);
  const HAS_MEDIUM = materials.some(materialUsesMedium);
  // Retain the atlas uniform capacity when a stage/material is removed.
  // Shrinking the array would rebuild every pipeline again on the next edit.
  const NUM_MAPS = Math.max(
    Math.ceil(+materialData.defines.NUM_MAPS / 10) * 10,
    Number(previousNumMaps ?? 0),
    20
  );

  // Either layer's map requires independent normals, including a smooth
  // coat over a mapped base. Unmapped materials retain the shared path.
  const USE_COAT_NORMAL_FRAMES = materials.some(m => m.coatWeight > 0 && (!!m.normalMap || !!m.coatNormalMap));

  return {
    MATERIAL_CAPABILITIES:
      (materials.some(m => m.transmissionWeight !== 0 || !!m.map && m.mapAlphaUsage === 'transmission')
        ? MATERIAL_SHADER_CAPABILITIES.transmission : 0) |
      (materials.some(m => m.baseMetalness !== 0) ? MATERIAL_SHADER_CAPABILITIES.metal : 0),
    // Match the atlas UV selector. Keep the second set when any texture
    // needs it; material/texture edits already rebuild these constants.
    USE_UV1: materialData.bufferData.mapUvChannel.some(channel => channel > 0.5),
    // Isotropic OpenPBR constructs its own basis. Normal mapping uses
    // triangle UV differentials rather than this vertex tangent.
    USE_TANGENT: mergedGeometry.tangent != null &&
      materials.some(materialNeedsVertexTangents),

    USE_COAT_NORMAL_FRAMES,
    USE_ANISOTROPY_DIRECTIONS: USE_COAT_NORMAL_FRAMES || materials.some(m =>
      m.specularAnisotropy > 0 && (m.specularAnisotropyModel === 'gltf' || !!m.anisotropyMap || m.specularAnisotropyRotation !== 0) ||
      m.coatAnisotropy > 0 && m.coatAnisotropyRotation !== 0),
    HAS_MEDIUM,
    HAS_SHADOW_CATCHER: materials.some(m => m.shadowCatcher),
    HAS_THIN_FILM: materials.some((material) => material.thinFilmWeight > 0),
    HAS_COAT: materials.some((material) => material.coatWeight > 0),
    HAS_FUZZ: materials.some((material) => material.fuzzWeight > 0),
    HAS_SUBSURFACE: materials.some((material) => material.subsurfaceWeight > 0),
    HAS_BEVEL,
    HAS_ALPHA_MASK: materials.some(
      (m) => resolveMaterialAlphaMode(m) === 'mask'
    ),
    HAS_ALPHA_BLEND: materials.some(
      (m) => resolveMaterialAlphaMode(m) === 'blend'
    ),
    HAS_ALPHA: materials.some(
      (m) => resolveMaterialAlphaMode(m) !== 'opaque'
    ),

    SPECTRAL,
    BEVEL_SAMPLES: bevelSamples,

    USE_RR: true,
    // Upper threshold; each path selects it only after entering scattering media.
    RR_MAX: 12,

    NUM_UNIFORM_LIGHTS: 64,

    ...materialData.defines,

    NUM_MAPS,
    ...materialTextureFeatures(materialData.defines),
    USE_NORMAL_MAPS: +materialData.defines.NUM_NORMAL_MAPS > 0
  };

}
