import {MATERIAL_TEXTURE_SLOTS} from '../../materialTextureSlots.js';
import {mapAlphaUsageConstants} from '../../materialConstants.js';

// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

/** One sampleMap site for the D3D12 universal surface. Keep each slot's factors,
 * channels and color decoding in their original order; normal/displacement
 * queries keep their separate sampling sites. */
export function materialSurfaceTextures(hasCoatNormals: boolean, directionFlags: boolean, materialXNormals: boolean) {
  const slots = MATERIAL_TEXTURE_SLOTS.filter(slot => !['normalMap', 'coatNormalMap', 'displacementMap'].includes(slot.property));
  const manual: Record<string, string> = {
    map: `(*ma).baseColor *= decodeMapColor(index, texel.rgb);
      if(matData.mapAlphaUsage == ${mapAlphaUsageConstants.transmission}) { (*ma).transmissionWeight = 1.0 - texel.a; }
      else if(matData.mapAlphaUsage == ${mapAlphaUsageConstants.alpha}) { (*ma).alpha *= texel.a; }`,
    emissiveMap: '(*ma).emission *= decodeMapColor(index, texel.rgb);',
    metallicRoughnessMap: '(*ma).baseMetalness *= texel.b; (*ma).specularRoughness *= texel.g;',
    thinFilmMap: `if(matData.thinFilmThicknessMinimum == 0.0 && matData.thinFilmMapChannel == 0.0) { (*ma).thinFilmThickness *= texel.r; }
      else { (*ma).thinFilmThickness = mix(matData.thinFilmThicknessMinimum, matData.thinFilmThickness, texel[i32(matData.thinFilmMapChannel)]) * 1000.0; }`,
    anisotropyMap: `(*ma).specularAnisotropy *= texel.b;
      let direction = texel.rg * 2.0 - 1.0;
      if(dot(direction,direction) > 1e-4) { (*ma).anisotropyDirection = normalize(direction); }
      ${directionFlags ? '(*ma).anisotropyDirectionEnabled |= 1u;' : '(*ma).anisotropyDirectionEnabled = true;'}`
  };
  const cases = slots.map((slot, i) => {
    let code = manual[slot.property];
    if (slot.sampling === 'multiply') {
      const value = slot.colorSpace === 'srgb' ? `decodeMapColor(index, texel.${slot.channel})` : `texel.${slot.channel}`;
      code = `(*ma).${slot.target} *= ${value};`;
    }
    if (slot.property === 'coatWeightMap') code += `
      if(matData.matType == 0.0) {
        let weight = clamp(matData.coatWeight, 0.0, 1.0) * texel.r;
        (*ma).emission *= mix(vec3f(1.0), sqrt(max(matData.coatColor,vec3f(0.0))), weight);
      }`;
    if (!code) throw new Error(`Missing universal surface texture: ${slot.property}`);
    return `      case ${i}u: { ${code} }`;
  });
  return /* wgsl */ `
  (*ma).anisotropyDirection = vec2f(1.0, 0.0);
  (*ma).anisotropyDirectionEnabled = ${directionFlags ? `select(0u, 1u, matData.specularAnisotropyRotation != 0.0)${materialXNormals ? ' | select(0u, 2u, fract(matData.normalMapIndex) > 0.25)' : ''}` : 'matData.specularAnisotropyRotation != 0.0'};
  (*ma).coatAnisotropyRotation = matData.coatAnisotropyRotation;
  let mx_indices = array<i32,${slots.length}>(${slots.map(slot => `i32(matData.${slot.packed.wgslField})`).join(',')});
  let mx_enabled = array<bool,${slots.length}>(${slots.map(slot => slot.feature).join(',')});
  for(var slot = 0u; slot < ${slots.length}u + rtUniform.loopUnrollGuard - 4u; slot++) {
    let index = mx_indices[slot];
    if(index < 0 || !mx_enabled[slot]) { continue; }
    let texel = sampleMap(index, getMapUvSet(index, uv, uv1));
    switch slot {
${cases.join('\n')}
      default: {}
    }
  }
${hasCoatNormals ? `  (*ma).coatNormalEnabled = (*ma).coatWeight > 0.0 && (matData.normalMapIndex >= 0.0 || matData.coatNormalMapIndex >= 0.0);` : ''}
  if(matData.specularAnisotropyModel > 0.5 && (*ma).specularAnisotropy > 0.0) {
    let native = gltf_anisotropy_to_openpbr(clamp((*ma).specularRoughness,0.0,1.0), (*ma).specularAnisotropy);
    (*ma).specularRoughness = native.x; (*ma).specularAnisotropy = native.y;
  }
  if(${directionFlags ? '((*ma).anisotropyDirectionEnabled & 1u) != 0u' : '(*ma).anisotropyDirectionEnabled'}) {
    let theta = matData.specularAnisotropyRotation; let d = (*ma).anisotropyDirection;
    (*ma).anisotropyDirection = vec2f(cos(theta)*d.x - sin(theta)*d.y, sin(theta)*d.x + cos(theta)*d.y);
  }
`;
}
