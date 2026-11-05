import * as THREE from 'three';
// PBRT-v4@b0bdf461 src/pbrt/media.cpp, Apache-2.0 (see LICENSES).
import presets from './scattering-data.json';
import { first, scalar, type Entity, type Scene, type Shape } from './scene';
import { conductor, conductorFresnel, metalTint, glass, namedSpectrum, roughness } from './spectrum';
import { Textures } from './textures';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { packMaterialParams } from '../../src/renderer/materialParams';
export type Warn = (entity: Entity, handling: string, code?: string) => void;
/** Inverse of OpenPBR 1.1.1's RMS-preserving GGX parameterization. */
export function anisotropicRoughness(alphaU: number, alphaV: number) {
  const maximum = Math.max(alphaU, alphaV), minimum = Math.min(alphaU, alphaV);
  return {
    roughness: Math.pow((alphaU * alphaU + alphaV * alphaV) / 2, .25),
    anisotropy: maximum > 0 ? 1 - minimum / maximum : 0,
    rotation: alphaV > alphaU ? Math.PI / 2 : 0
  };
}
/** A material medium occupies the normal's negative half-space. */
export function interiorMedium(shape: Shape, scene: Scene, warn?: Warn): { name: string; flip: boolean } {
  for (const name of [shape.inside, shape.outside]) if (name && !scene.media[name]) throw new Error(`Undefined medium ${name}`);
  const inside = shape.inside !== scene.cameraMedium ? shape.inside : '';
  const outside = shape.outside !== scene.cameraMedium ? shape.outside : '';
  if (inside && outside) {
    warn?.(shape, 'Both sides have non-camera media; uses inside medium only', 'medium-interface');
    return { name: inside, flip: false };
  }
  return outside ? { name: outside, flip: true } : { name: inside, flip: false };
}
// Invert the existing OpenPBR artist-color -> single-scattering-albedo mapping
// through its own packer, rather than duplicating its fitted coefficients.
function subsurfaceColor(albedo: number[], anisotropy: number): number[] {
  const probe = new OpenPBRMaterial({ subsurfaceWeight: 1, subsurfaceRadius: 1, subsurfaceAnisotropy: anisotropy });
  return albedo.map(target => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2; probe.subsurfaceColor = [mid, mid, mid];
      if (packMaterialParams([probe]).mediumScattering[0][0] < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  });
}
export async function material(shape: Shape, scene: Scene, textures: Textures, warn: Warn, active = new Set<Entity>()): Promise<THREE.MeshPhysicalMaterial> {
  let entity = shape.material;
  if (active.has(entity)) throw new Error(`Cyclic mix material at ${entity.loc.file}:${entity.loc.line}`);
  if (entity.type === 'mix') {
    const weight = await textures.value(entity.params, 'amount', [.5, .5, .5], entity);
    const amount = textures.average(weight)[0], choices = entity.params.materials?.values ?? [];
    if (weight.map) warn(entity, 'Spatial mix amount averaged before selecting the dominant material', 'material');
    const selected = scene.materials[String(choices[amount >= .5 ? 1 : 0])];
    warn(entity, 'Mix uses the material with the larger weight', 'material');
    if (selected) {
      const result = await material({ ...shape, material: selected }, scene, textures, warn, new Set(active).add(entity));
      result.userData.pbrtComparable = false; return result;
    }
  }
  const type = entity.type, sourceParams = entity.params;
  const p = type === 'coatedconductor' ? { ...sourceParams } : sourceParams;
  if (type === 'coatedconductor') for (const key of ['eta', 'k', 'roughness', 'uroughness', 'vroughness']) {
    if (sourceParams[`conductor.${key}`]) p[key] = sourceParams[`conductor.${key}`];
  }
  // PBRT surface intersection does not cull back faces. Emission sidedness is
  // handled below; MuTracer currently couples it to primary-ray culling.
  const result = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .5, side: THREE.DoubleSide });
  result.name = `${type} · ${entity.loc.file.split('/').pop()}:${entity.loc.line}`;
  const open: Record<string, unknown> = { specularWeight: 0 };
  result.userData.mutracerOpenPBR = open;
  const comparable = ['diffuse', 'conductor', 'dielectric', 'thindielectric', 'interface', ''].includes(type);
  result.userData.pbrtComparable = comparable;
  if (!comparable) warn(entity, `${type} approximated with OpenPBR; excluded from strict HDR comparison`, 'material');
  const color = await textures.value(p, 'reflectance', type === 'conductor' ? [.9, .9, .9] : type === 'diffusetransmission' ? [.25,.25,.25] : [.5, .5, .5], entity);
  result.color.setRGB(...color.color as [number, number, number]); result.map = color.map ?? null;
  if (['dielectric', 'thindielectric', 'interface', ''].includes(type)) {
    result.color.setRGB(1, 1, 1); result.transmission = 1; result.ior = p.eta?.type === 'spectrum' ? 1.5 : scalar(p, 'eta', 1.5);
    open.transmissionWeight = 1; open.specularWeight = 1; open.baseColor = [1, 1, 1];
    if (type === 'thindielectric') open.thinWalled = true;
    if (type === 'interface' || type === '') { result.ior = 1; open.specularIor = 1; }
    if (p.eta?.type === 'spectrum') {
      const curve = await textures.spectrum(p.eta);
      if (curve) {
        const value = glass(curve); result.ior = value.ior;
        if (Number.isFinite(value.abbe)) { open.transmissionDispersionScale = 1; open.transmissionDispersionAbbeNumber = value.abbe; }
      } else warn(entity, 'Unknown dielectric IOR spectrum uses IOR 1.5', 'spectrum');
    }
  }
  if (type === 'conductor' || type === 'coatedconductor') {
    result.metalness = 1; open.specularWeight = 1;
    const curve = async (key: string, fallback: string) => {
      const parameter = p[key];
      if (!parameter) return namedSpectrum(fallback);
      if (parameter.type === 'spectrum') return textures.spectrum(parameter);
      const values = parameter.type === 'texture' ? textures.average(await textures.value(p,key,[1,1,1],entity)) : parameter.values.map(Number);
      if (parameter.type === 'texture') { warn(entity, 'Spatial optical constants use mean RGB wavelength interpolation', 'spectrum'); result.userData.pbrtComparable = false; }
      if (values.length === 1) return [360, values[0], 830, values[0]];
      return [360, values[2], 460, values[2], 550, values[1], 610, values[0], 830, values[0]];
    };
    const eta = await curve('eta', 'metal-Cu-eta'), k = await curve('k', 'metal-Cu-k');
    if (p.eta?.type === 'rgb' || p.k?.type === 'rgb') warn(entity, 'RGB optical constants use wavelength interpolation', 'spectrum');
    if (!p.reflectance && eta && k) {
      const colors = conductor(eta, k); result.color.setRGB(...colors.base as [number, number, number]); open.specularColor = metalTint(colors.base, colors.edge);
      if (colors.edge.some((v, i) => v > colors.base[i] + (1 - colors.base[i]) * Math.pow(6/7,5) + 1e-6)) warn(entity, 'Metal edge color limited to the OpenPBR tint range', 'spectrum');
    } else if (p.reflectance) {
      const base = textures.average(color).map(v => Math.min(.999999, Math.max(0, v)));
      const edge = base.map(v => conductorFresnel(1, 2 * Math.sqrt(v / Math.max(1e-9, 1 - v)), 1 / 7));
      open.specularColor = metalTint(base, edge);
      if (color.map) warn(entity, 'Textured conductor reflectance uses a constant mean edge tint', 'material');
    } else if (p.eta || p.k) warn(entity, 'Numeric eta/k approximated by RGB reflectance', 'spectrum');
  }
  const remap = first(p, 'remaproughness', true) !== false;
  const u = roughness(scalar(p, 'uroughness', scalar(p, 'roughness', 0)), remap), v = roughness(scalar(p, 'vroughness', scalar(p, 'roughness', 0)), remap);
  const specular = anisotropicRoughness(u * u, v * v);
  result.roughness = specular.roughness; open.specularRoughness = specular.roughness;
  open.specularAnisotropy = specular.anisotropy;
  open.specularAnisotropyRotation = specular.rotation;
  if (p.roughness?.type === 'texture' && !p.uroughness && !p.vroughness) {
    const value = await textures.value(p, 'roughness', [.5, .5, .5], entity);
    if (value.map) {
      const map = value.map.clone(), data = new Float32Array(value.map.image.data as Float32Array);
      for (let i = 0; i < data.length; i++) if (i % 4 < 3) data[i] = roughness(data[i], remap);
      map.source = new THREE.Source({ ...value.map.image, data }); map.needsUpdate = true; result.roughnessMap = map;
      result.roughness = roughness(value.color[0], remap); open.specularRoughness = result.roughness;
    } else { result.roughness = roughness(value.color[0], remap); open.specularRoughness = result.roughness; }
  } else if (p.uroughness?.type === 'texture' || p.vroughness?.type === 'texture') {
    result.roughness = .5; open.specularRoughness = .5;
    warn(entity, 'Anisotropic roughness textures replaced by 0.5', 'texture');
    result.userData.pbrtComparable = false;
  }
  if (type.startsWith('coated')) {
    const coat: typeof p = type === 'coatedconductor' ? Object.fromEntries(Object.entries(sourceParams).filter(([key])=>key.startsWith('interface.')).map(([key,value])=>[key.slice(10),value])) : p;
    const cu = await textures.value(coat, coat.uroughness ? 'uroughness' : 'roughness', [0,0,0], entity);
    const cv = await textures.value(coat, coat.vroughness ? 'vroughness' : 'roughness', [0,0,0], entity);
    if (cu.map || cv.map) warn(entity, 'Coat roughness maps approximated by their means', 'material');
    const u = roughness(textures.average(cu)[0], remap), v = roughness(textures.average(cv)[0], remap);
    result.clearcoat = 1; result.clearcoatRoughness = anisotropicRoughness(u*u,v*v).roughness; open.coatRoughness = result.clearcoatRoughness;
    open.coatWeight = 1; open.coatDarkening = 1; open.coatIor = scalar(coat, 'eta', 1.5);
    if (coat.eta?.type === 'spectrum') { const eta = await textures.spectrum(coat.eta); if (eta) open.coatIor = glass(eta).ior; warn(entity, 'Coat dispersion approximated by its d-line IOR', 'spectrum'); }
    const mapped = anisotropicRoughness(u*u,v*v);
    open.coatAnisotropy = mapped.anisotropy; open.coatAnisotropyRotation = mapped.rotation;
  }
  if (type === 'subsurface') {
    const preset = (presets as Record<string, { sigma_a: number[]; sigma_s: number[] }>)[String(first(p, 'name', ''))];
    const a = preset ? { color: preset.sigma_a } : await textures.value(p, 'sigma_a', [.0011, .0024, .014], entity), s = preset ? { color: preset.sigma_s } : await textures.value(p, 'sigma_s', [2.55, 3.21, 3.77], entity);
    result.ior = scalar(p, 'eta', 1.33);
    const anisotropy = preset ? 0 : scalar(p, 'g', 0), scale = scalar(p, 'scale', 1);
    open.specularWeight = 1; open.subsurfaceAnisotropy = anisotropy;
    open.subsurfaceWeight = 1; open.subsurfaceColor = subsurfaceColor(s.color.map((v, i) => v / Math.max(1e-9, v + a.color[i])), anisotropy);
    const radii = s.color.map((v, i) => 1 / Math.max(1e-9, (v + a.color[i]) * scale)), radius = Math.max(...radii);
    open.subsurfaceRadius = radius; open.subsurfaceRadiusScale = radii.map(v => v / radius);
    if (p.reflectance) {
      open.subsurfaceColor = textures.average(color);
      const mfp = await textures.value(p, 'mfp', [1, 1, 1], entity);
      const radii = textures.average(mfp).map(v => v / Math.max(1e-9, scalar(p, 'scale', 1)));
      const maximum = Math.max(...radii); open.subsurfaceRadius = maximum; open.subsurfaceRadiusScale = radii.map(v => maximum > 0 ? v / maximum : 0);
      if (color.map) warn(entity, 'Subsurface reflectance map approximated by its mean color', 'material');
      if (mfp.map) warn(entity, 'Subsurface mean free path map approximated by its mean RGB', 'material');
    }
    if ((open.subsurfaceRadius as number) * Math.min(...open.subsurfaceRadiusScale as number[]) < .001) warn(entity, 'Subsurface mean free paths below 0.001 scene units are limited by the existing OpenPBR medium', 'material');
    if (p.name && !preset) warn(entity, 'Unknown subsurface preset uses default coefficients', 'material');
  }
  if (type === 'diffusetransmission') {
    const transmittance = await textures.value(p, 'transmittance', [.25,.25,.25], entity);
    const color = textures.average(transmittance);
    open.thinWalled = true; result.transmission = Math.min(1, Math.max(...color) * scalar(p, 'scale', 1));
    open.transmissionColor = color.map(v => Math.max(...color) > 0 ? v / Math.max(...color) : 0);
    if (transmittance.map) warn(entity, 'Diffuse transmittance map approximated by its mean', 'material');
  }
  if (['hair', 'measured', 'mix'].includes(type)) result.color.setRGB(.5, .5, .5);
  if (p.normalmap) {
    const path = String(first(p, 'normalmap', ''));
    const image = await textures.image(path), map = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, image.data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType);
    map.flipY = true; map.needsUpdate = true; result.normalMap = map;
  }
  if (p.displacement) {
    if (result.normalMap) {
      warn(entity, 'Material bump ignored when normalmap is present; the pinned PBRT renderer gives normalmap precedence', 'bump');
      result.userData.pbrtComparable = false;
    } else {
      const value = await textures.value(p, 'displacement', [0, 0, 0], entity);
      result.normalMap = textures.bumpMap(value);
      if (result.normalMap) {
        warn(entity, 'Material bump baked in UV space with unit tangents; per-hit footprint and curved-surface derivatives approximated', 'bump');
        result.userData.pbrtComparable = false;
      }
    }
  }
  if (shape.params.displacement) {
    const value = await textures.value(shape.params, 'displacement', [0, 0, 0], shape);
    if (value.map) {
      result.displacementMap = textures.heightMap(value.map, shape); result.displacementScale = value.color[0];
      warn(shape, 'Shape displacement approximated by MuTracer height-field displacement', 'displacement');
      result.userData.pbrtComparable = false;
    }
  }
  const alpha = await textures.value(shape.params, 'alpha', [1, 1, 1], entity);
  result.opacity = alpha.color[0]; result.alphaMap = alpha.map ?? null; result.transparent = result.opacity < 1 || !!alpha.map;
  const interior = interiorMedium(shape, scene, warn);
  // PBRT DielectricBxDF exchanges eta on the back side of its final normal.
  // ReverseOrientation and transform handedness already affect both PBRT and
  // imported normals; only the extra medium-side reversal exchanges that ratio.
  // ThinDielectricBxDF uses AbsCosTheta, so its eta is orientation-independent.
  if (interior.flip && type === 'dielectric') {
    result.ior = 1 / result.ior;
    if (open.transmissionDispersionScale) {
      result.userData.pbrtComparable = false;
      warn(shape, 'Reversed dielectric uses reciprocal d-line IOR and retains Abbe number; reciprocal spectral dispersion is approximated by the existing Cauchy model', 'ior-dispersion');
    }
  }
  if (type.startsWith('coated') && (interior.flip || Number(open.coatIor) < 1)) {
    result.userData.pbrtComparable = false;
    warn(shape, 'Coat IOR orientation cannot be represented: MuTracer clamps coat IOR to at least 1 and applies the coat only on the exterior side; excluded from strict comparison', 'ior-orientation');
  }
  if (shape.inside && shape.outside && shape.inside !== scene.cameraMedium && shape.outside !== scene.cameraMedium) result.userData.pbrtComparable = false;
  if (interior.name) {
    const medium = scene.media[interior.name];
    if (type === 'interface' || type === '') {
      result.userData.pbrtComparable = false;
      warn(shape, 'Interface interior medium excluded from strict comparison: point and area direct lighting is blocked at the boundary by MuTracer shadow rays', 'medium-shadow');
    }
    if (open.thinWalled) {
      result.userData.pbrtComparable = false;
      warn(shape, 'Thin-walled materials cannot retain an interior medium; absorption and scattering are skipped', 'thin-medium');
    } else if (medium.type === 'homogeneous') {
      const a = await textures.value(medium.params, 'sigma_a', [1, 1, 1], medium), s = await textures.value(medium.params, 'sigma_s', [1, 1, 1], medium), scale = scalar(medium.params, 'scale', 1);
      const extinction = a.color.map((v, i) => (v + s.color[i]) * scale);
      // The existing packer takes extinction transmittance and scattering
      // albedo. Keep exponents near zero to avoid its log(1e-6) color floor.
      const depth = 1 / Math.max(1, ...extinction);
      result.attenuationColor.setRGB(...extinction.map(v => Math.exp(-v * depth)) as [number, number, number]);
      result.attenuationDistance = depth;
      open.transmissionScatter = s.color.map((v, i) => v / Math.max(1e-9, a.color[i] + v)); open.transmissionScatterAnisotropy = scalar(medium.params, 'g', 0);
    } else warn(medium, `${medium.type} medium skipped`, 'medium');
  }
  if (shape.areaLight) {
    const area = shape.areaLight;
    const emission = await textures.value(area.params, 'L', [1, 1, 1], area);
    result.emissive.setRGB(...emission.color as [number, number, number]); result.emissiveMap = emission.map ?? null;
    result.emissiveIntensity = scalar(area.params, 'scale', 1);
    result.side = first(area.params, 'twosided', false) ? THREE.DoubleSide : THREE.FrontSide;
    if (result.side === THREE.FrontSide) warn(area, 'One-sided emission also culls the surface from primary back-face rays in MuTracer', 'light');
    if (area.params.power && (area.params.filename || emission.map)) warn(area, 'Textured area-light power uses geometric area without texture-average normalization', 'light-units');
    if (area.params.filename) {
      const image = await textures.image(String(first(area.params, 'filename', '')));
      const map = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, image.data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType);
      map.flipY = true; map.needsUpdate = true; result.emissiveMap = map;
    }

  }
  return result;
}
