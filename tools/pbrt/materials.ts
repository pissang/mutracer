import * as THREE from 'three';
import { first, scalar, type Entity, type Scene, type Shape } from './scene';
import { conductor, glass, namedSpectrum, roughness } from './spectrum';
import { Textures } from './textures';
export type Warn = (entity: Entity, handling: string, code?: string) => void;
export async function material(shape: Shape, scene: Scene, textures: Textures, warn: Warn, active = new Set<Entity>()): Promise<THREE.MeshPhysicalMaterial> {
  let entity = shape.material;
  if (active.has(entity)) throw new Error(`Cyclic mix material at ${entity.loc.file}:${entity.loc.line}`);
  if (entity.type === 'mix') {
    const amount = scalar(entity.params, 'amount', .5), choices = entity.params.materials?.values ?? [];
    const selected = scene.materials[String(choices[amount >= .5 ? 1 : 0])];
    warn(entity, 'Mix uses the material with the larger weight', 'material');
    if (selected) return material({ ...shape, material: selected }, scene, textures, warn, new Set(active).add(entity));
  }
  const p = entity.params, type = entity.type;
  const result = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .5, side: THREE.FrontSide });
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
    if (!p.reflectance && eta && k) {
      const colors = conductor(eta, k); result.color.setRGB(...colors.base as [number, number, number]); open.specularColor = colors.edge;
    } else if (p.eta || p.k) warn(entity, 'Numeric eta/k approximated by RGB reflectance', 'spectrum');
  }
  const remap = first(p, 'remaproughness', true) !== false;
  const u = roughness(scalar(p, 'uroughness', scalar(p, 'roughness', 0)), remap), v = roughness(scalar(p, 'vroughness', scalar(p, 'roughness', 0)), remap);
  result.roughness = Math.sqrt(u * v); open.specularRoughness = result.roughness;
  if (u !== v) {
    const max = Math.max(u * u, v * v), min = Math.min(u * u, v * v);
    open.specularAnisotropy = Math.min(1, (1 - min / max) / .9);
    open.specularAnisotropyRotation = v > u ? Math.PI / 2 : 0;
  }
  if (p.roughness?.type === 'texture' && !p.uroughness && !p.vroughness) {
    const value = await textures.value(p, 'roughness', [.5, .5, .5], entity);
    if (value.map) {
      const map = value.map.clone(), data = new Float32Array(value.map.image.data as Float32Array);
      for (let i = 0; i < data.length; i++) if (i % 4 < 3) data[i] = roughness(data[i], remap);
      map.image = { ...value.map.image, data }; map.needsUpdate = true; result.roughnessMap = map;
      result.roughness = 1; open.specularRoughness = 1;
    } else { result.roughness = roughness(value.color[0], remap); open.specularRoughness = result.roughness; }
  } else if (p.uroughness?.type === 'texture' || p.vroughness?.type === 'texture') {
    result.roughness = .5; open.specularRoughness = .5;
    warn(entity, 'Anisotropic roughness textures replaced by 0.5', 'texture');
    result.userData.pbrtComparable = false;
  }
  if (type.startsWith('coated')) { result.clearcoat = 1; result.clearcoatRoughness = result.roughness; open.coatWeight = 1; }
  if (type === 'subsurface') {
    const a = await textures.value(p, 'sigma_a', [.01, .01, .01], entity), s = await textures.value(p, 'sigma_s', [1, 1, 1], entity);
    open.subsurfaceWeight = 1; open.subsurfaceColor = s.color.map((v, i) => v / Math.max(1e-6, v + a.color[i]));
    open.subsurfaceRadius = 1 / Math.max(1e-6, (a.color.reduce((x, y) => x + y) + s.color.reduce((x, y) => x + y)) / 3 * scalar(p, 'scale', 1));
    if (p.name) warn(entity, 'Named subsurface coefficients use default sigma_a/sigma_s', 'material');
  }
  if (type === 'diffusetransmission') { open.thinWalled = true; open.transmissionWeight = .5; }
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
      result.displacementMap = value.map; result.displacementScale = 1;
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
      open.transmissionColor = a.color.map(v => Math.exp(-v * scale)); open.transmissionDepth = 1;
      open.transmissionScatter = s.color.map(v => v * scale); open.transmissionScatterAnisotropy = scalar(medium.params, 'g', 0);
    } else warn(medium, `${medium.type} medium skipped`, 'medium');
  }
  if (shape.areaLight) {
    const area = shape.areaLight;
    const emission = await textures.value(area.params, 'L', [1, 1, 1], area);
    result.emissive.setRGB(...emission.color as [number, number, number]); result.emissiveMap = emission.map ?? null;
    result.emissiveIntensity = scalar(area.params, 'scale', 1);
    if (first(area.params, 'twosided', false)) result.side = THREE.DoubleSide;
    if (area.params.power && (area.params.filename || emission.map)) warn(area, 'Textured area-light power uses geometric area without texture-average normalization', 'light-units');
    if (area.params.filename) {
      const image = await textures.image(String(first(area.params, 'filename', '')));
      const map = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, image.data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType);
      map.flipY = true; map.needsUpdate = true; result.emissiveMap = map;
    }

  }
  return result;
}
