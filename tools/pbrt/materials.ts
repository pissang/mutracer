import * as THREE from 'three';
// PBRT-v4@b0bdf461 src/pbrt/media.cpp, Apache-2.0 (see LICENSES).
import presets from './scattering-data.json';
import { first, scalar, type Entity, type Scene, type Shape } from './scene';
import { conductor, conductorFresnel, metalTint, glass, namedSpectrum, roughness } from './spectrum';
import { Textures } from './textures';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { packMaterialParams } from '../../src/renderer/materialParams';
export type Warn = (entity: Entity, handling: string, code?: string) => void;
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
  const p = entity.params, type = entity.type;
  // PBRT surface intersection does not cull back faces. Emission sidedness is
  // handled below; MuTracer currently couples it to primary-ray culling.
  const result = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .5, side: THREE.DoubleSide });
  result.name = `${type} · ${entity.loc.file.split('/').pop()}:${entity.loc.line}`;
  const open: Record<string, unknown> = { specularWeight: 0 };
  result.userData.mutracerOpenPBR = open;
  const comparable = ['diffuse', 'conductor', 'dielectric', 'thindielectric', 'interface', ''].includes(type);
  result.userData.pbrtComparable = comparable;
  if (!comparable) warn(entity, `${type} approximated with OpenPBR; excluded from strict HDR comparison`, 'material');
  const color = await textures.value(p, 'reflectance', type === 'conductor' ? [.9, .9, .9] : [.5, .5, .5], entity);
  result.color.setRGB(...color.color as [number, number, number]); result.map = color.map ?? null;
  if (['dielectric', 'thindielectric', 'interface', ''].includes(type)) {
    result.color.setRGB(1, 1, 1); result.transmission = 1; result.ior = p.eta?.type === 'spectrum' ? 1.5 : scalar(p, 'eta', 1.5);
    open.transmissionWeight = 1; open.specularWeight = 1; open.baseColor = [1, 1, 1];
    if (type === 'thindielectric') open.thinWalled = true;
    if (type === 'interface' || type === '') { result.ior = 1; open.specularIor = 1; }
    if (p.eta?.type === 'spectrum') {
      const values = p.eta.values;
      const curve = typeof values[0] === 'string' ? namedSpectrum(String(values[0])) : values.map(Number);
      if (curve) {
        const value = glass(curve); result.ior = value.ior;
        if (Number.isFinite(value.abbe)) { open.transmissionDispersionScale = 1; open.transmissionDispersionAbbeNumber = value.abbe; }
      } else warn(entity, 'Unknown dielectric IOR spectrum uses IOR 1.5', 'spectrum');
    }
  }
  if (type === 'conductor' || type === 'coatedconductor') {
    result.metalness = 1; open.specularWeight = 1;
    const curve = (key: string, fallback: string) => {
      const parameter = p[key];
      if (!parameter) return namedSpectrum(fallback);
      if (typeof parameter.values[0] === 'string') return namedSpectrum(String(parameter.values[0]));
      const values = parameter.values.map(Number);
      if (parameter.type === 'spectrum') return values;
      if (values.length === 1) return [360, values[0], 830, values[0]];
      return [360, values[2], 460, values[2], 550, values[1], 610, values[0], 830, values[0]];
    };
    const eta = curve('eta', 'metal-Cu-eta'), k = curve('k', 'metal-Cu-k');
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
  result.roughness = Math.sqrt(u * v); open.specularRoughness = result.roughness;
  if (u !== v) {
    const max = Math.max(u * u, v * v), min = Math.min(u * u, v * v);
    open.specularAnisotropy = Math.min(1, (1 - min / max) / .9);
    if (min / max < .1) warn(entity, 'Extreme microfacet anisotropy limited by the OpenPBR aspect model', 'material');
    open.specularAnisotropyRotation = v > u ? Math.PI / 2 : 0;
  }
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
  if (type.startsWith('coated')) { result.clearcoat = 1; result.clearcoatRoughness = result.roughness; open.coatWeight = 1; open.coatDarkening = 1; open.coatIor = 1.5; }
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
  if (type === 'diffusetransmission') { open.thinWalled = true; result.transmission = .5; }
  if (['hair', 'measured', 'mix'].includes(type)) result.color.setRGB(.5, .5, .5);
  if (p.normalmap) {
    const path = String(first(p, 'normalmap', ''));
    const image = await textures.image(path), map = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, image.data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType);
    map.flipY = true; map.needsUpdate = true; result.normalMap = map;
  }
  if (p.displacement || shape.params.displacement) {
    const parameters = shape.params.displacement ? shape.params : p;
    const value = await textures.value(parameters, 'displacement', [0, 0, 0], entity);
    if (value.map) {
      result.displacementMap = textures.heightMap(value.map, entity); result.displacementScale = value.color[0];
      warn(entity, 'PBRT bump/displacement approximated by MuTracer height-field displacement', 'displacement');
      result.userData.pbrtComparable = false;
    }
  }
  const alpha = await textures.value(shape.params, 'alpha', [1, 1, 1], entity);
  result.opacity = alpha.color[0]; result.alphaMap = alpha.map ?? null; result.transparent = result.opacity < 1 || !!alpha.map;
  if (shape.inside) {
    const medium = scene.media[shape.inside];
    if (!medium) throw new Error(`Undefined medium ${shape.inside}`);
    if (medium.type === 'homogeneous') {
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
