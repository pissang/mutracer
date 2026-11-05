import * as THREE from 'three';
import {MAX_PATH_EVENTS_WGPU, MAX_PATH_EVENTS_WEBGL, normalizeBounces} from '../../src/renderer/pathLimits';
import { geometry, type PLYDecoder } from './geometry';
import { material, interiorMedium, type Warn } from './materials';
import { first, scalar, vector, type Entity, type Scene, type Shape } from './scene';
import { Textures, type DecodeImage, type Image } from './textures';
import { verticalFov } from './spectrum';
import type { Resolver } from './source';
import { reprojectEnvironment } from './environment';
import { mediumBoundary } from './mediumBoundary';
export interface Converted {
  root: THREE.Group; environment: Image | null;
  settings: { width: number; height: number; bounces: number; samples: number; exposure: number; fStop: number; focusDistance: number };
}
const mirror = new THREE.Matrix4().makeScale(1, 1, -1);

/** Both geometry and camera receive the same world reflection. The camera's
 * local reflection changes PBRT's +Z viewing direction to Three's -Z. */
export async function convert(scene: Scene, resolver: Resolver, decode?: DecodeImage, onProgress?: (loaded: number, total: number) => void, decodePLY?: PLYDecoder, backend: 'webgpu' | 'webgl' = 'webgpu'): Promise<Converted> {
  if (scene.cameraMedium) throw new Error('PBRT camera media are not supported in this release.');
  const root = new THREE.Group(); root.name = scene.entry.split('/').pop() ?? 'PBRT';
  const warningKeys = new Set<string>();
  const warn: Warn = (entity, handling, code = 'approximation') => {
    const key = `${entity.loc.file}:${entity.loc.line}:${handling}`;
    if (!warningKeys.has(key)) { warningKeys.add(key); scene.warnings.push({ statement: entity.loc.kind, file: entity.loc.file, line: entity.loc.line, code, handling }); }
  };
  const requestedDepth = scalar(scene.integrator?.params ?? {}, 'maxdepth', 5);
  const limit = backend === 'webgpu' ? MAX_PATH_EVENTS_WGPU : MAX_PATH_EVENTS_WEBGL;
  const bounces = normalizeBounces(requestedDepth, limit);
  if (requestedDepth > limit && scene.integrator) {
    warn(scene.integrator, `Requested maxdepth ${requestedDepth}; ${backend === 'webgpu' ? 'WebGPU' : 'WebGL'} uses depth ${bounces} with at most ${limit} path events; the scene is excluded from strict comparison`, 'path-depth');
  }
  const allowed: Record<string, string[]> = {
    Shape: ['P', 'N', 'uv', 'st', 'indices', 'filename', 'alpha', 'displacement', 'radius', 'zmin', 'zmax', 'phimax', 'height', 'innerradius', 'levels', 'nlevels'],
    Camera: ['fov', 'screenwindow', 'lensradius', 'focaldistance', 'shutteropen', 'shutterclose'],
    Film: ['xresolution', 'yresolution', 'filename', 'iso', 'whitebalance', 'sensor', 'savefp16'],
    Sampler: ['pixelsamples'], Integrator: ['maxdepth'],
    LightSource: ['L', 'I', 'scale', 'power', 'illuminance', 'from', 'to', 'coneangle', 'conedeltaangle', 'filename', 'portal'],
    AreaLightSource: ['L', 'scale', 'power', 'twosided', 'filename'],
    Material: ['type', 'reflectance', 'transmittance', 'eta', 'k', 'roughness', 'uroughness', 'vroughness', 'remaproughness', 'normalmap', 'displacement', 'sigma_a', 'sigma_s', 'mfp', 'g', 'scale', 'name', 'amount', 'materials'],
    MakeNamedMedium: ['type', 'sigma_a', 'sigma_s', 'scale', 'g', 'Le']
  };
  const entities: Entity[] = [...scene.shapes, ...Object.values(scene.objects).flat(), ...Object.values(scene.materials), ...scene.lights, ...Object.values(scene.media), ...[scene.camera, scene.film, scene.sampler, scene.integrator].filter((e): e is Entity => !!e)];
  for (const shape of [...scene.shapes, ...Object.values(scene.objects).flat()]) { entities.push(shape.material); if (shape.areaLight) entities.push(shape.areaLight); }
  for (const entity of new Set(entities)) {
    const kind = entity.loc.kind === 'MakeNamedMaterial' ? 'Material' : entity.loc.kind;
    for (const key of Object.keys(entity.params)) {
      const name = kind === 'Material' && entity.type === 'coatedconductor' ? key.replace(/^(interface|conductor)\./, '') : key;
      if (allowed[kind] && !allowed[kind].includes(name)) warn(entity, `Parameter ${key} ignored`, 'parameter');
    }
  }
  if (scene.integrator && !['path', 'volpath'].includes(scene.integrator.type)) warn(scene.integrator, `${scene.integrator.type} integrator replaced by MuTracer path tracing`, 'integrator');
  const textures = new Textures(scene, resolver, warn, decode);
  const materials = new Map<Entity, Map<string, Promise<THREE.MeshPhysicalMaterial>>>();
  const getMaterial = (shape: Shape) => {
    let variants = materials.get(shape.material);
    if (!variants) { variants = new Map(); materials.set(shape.material, variants); }
    const key = JSON.stringify([shape.params.alpha, shape.params.displacement, shape.areaLight, shape.inside, shape.outside, shape.areaLight?.params.power ? shape.loc : null]);
    if (!variants.has(key)) variants.set(key, material(shape, scene, textures, warn));
    return variants.get(key)!;
  };
  let loaded = 0;
  const total = scene.shapes.length + Object.values(scene.objects).reduce((n, shapes) => n + shapes.length, 0);
  const meshes = new Map<Shape, { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalMaterial }>();
  const mediumInterfaces = new Map<THREE.BufferGeometry, Shape>();
  const create = async (shape: Shape) => {
    onProgress?.(loaded++, total);
    if (shape.type === 'loopsubdiv') warn(shape, 'Loop subdivision uses area-weighted vertex normals', 'shape');
    let g = await geometry(shape, scene.entry, resolver, decodePLY);
    if (!g) { warn(shape, `${shape.type} shape skipped`, 'shape'); return null; }
    const m = await getMaterial(shape);
    if (!g.attributes.uv && (m.map || m.alphaMap || m.normalMap || m.displacementMap || m.roughnessMap || m.emissiveMap || Number(m.userData.mutracerOpenPBR.specularAnisotropy) > 0 || Number(m.userData.mutracerOpenPBR.coatAnisotropy) > 0)) {
      // PBRT triangle meshes without authored UVs use these coordinates per
      // triangle. A nonindexed variant preserves them across shared vertices.
      if (g.index) g = g.toNonIndexed();
      const uv = new Float32Array(g.attributes.position.count * 2);
      for (let i = 0; i < g.attributes.position.count; i += 3) uv.set([0, 0, 1, 0, 1, 1], i * 2);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    const matrix = mirror.clone().multiply(new THREE.Matrix4().fromArray(shape.transform));
    g.applyMatrix4(matrix);
    const reverse = shape.reverse !== interiorMedium(shape, scene).flip;
    const flipWinding = (matrix.determinant() < 0) !== reverse;
    if (flipWinding) {
      const index = g.index;
      if (!index) g.setIndex(Array.from({length: g.attributes.position.count}, (_, i) => i));
      const data = g.index!;
      for (let i = 0; i < data.count; i += 3) { const a = data.getX(i); data.setX(i, data.getX(i + 1)); data.setX(i + 1, a); }
    }
    if (reverse) { const n = g.attributes.normal; if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); }
    if (shape.inside !== shape.outside) {
      mediumInterfaces.set(g, shape);
      const boundary = mediumBoundary(g);
      if (!boundary.closed) {
        m.userData.pbrtComparable = false;
        warn(shape, 'Medium boundary is not closed; ray medium state is ambiguous and the scene is excluded from strict comparison', 'medium-topology');
      }
      if (!boundary.oriented) {
        m.userData.pbrtComparable = false;
        warn(shape, 'Medium boundary winding or authored normals are inconsistent; the scene is excluded from strict comparison', 'medium-orientation');
      }
    }
    // PBRT Triangle::NormalBounds / InteractionFromIntersection face-forward
    // the geometric normal to authored shading normals. Match that by winding.
    if (g.attributes.normal) {
      if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
      const p = g.attributes.position, n = g.attributes.normal, indices = g.index!;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ns = new THREE.Vector3();
      for (let i = 0; i < indices.count; i += 3) {
        const i0 = indices.getX(i), i1 = indices.getX(i+1), i2 = indices.getX(i+2);
        a.fromBufferAttribute(p,i0); b.fromBufferAttribute(p,i1).sub(a); c.fromBufferAttribute(p,i2).sub(a);
        ns.set(n.getX(i0)+n.getX(i1)+n.getX(i2), n.getY(i0)+n.getY(i1)+n.getY(i2), n.getZ(i0)+n.getZ(i1)+n.getZ(i2));
        if (b.cross(c).dot(ns) < 0) { indices.setX(i,i1); indices.setX(i+1,i0); }
      }
    }
    if (shape.areaLight?.params.power) {
      let area = 0;
      const positions = g.attributes.position, indices = g.index;
      const point = (i: number) => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(i) : i);
      for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
        const a = point(i); area += point(i + 1).sub(a).cross(point(i + 2).sub(a)).length() / 2;
      }
      m.emissiveIntensity *= scalar(shape.areaLight.params, 'power', 1) / (Math.PI * Math.max(1e-12, area) * (m.side === THREE.DoubleSide ? 2 : 1));
    }
    const open = m.userData.mutracerOpenPBR;
    if (Number(open.specularAnisotropy) > 0 || Number(open.coatAnisotropy) > 0) {
      // Zero rotation uses the mesh tangent in MuTracer; supply PBRT's dpdu
      // frame as well as the explicit rotated-direction path.
      if (g.attributes.uv) { if (!g.attributes.normal) g.computeVertexNormals(); g.computeTangents(); }
    }
    const value = { geometry: g, material: m }; meshes.set(shape, value); return value;
  };
  for (const shape of scene.shapes) {
    const value = await create(shape); if (!value) continue;
    if (shape.type === 'sphere' && shape.areaLight) warn(shape, 'Sphere emitter uses emissive geometry to preserve primary-ray visibility', 'light');
    const mesh = new THREE.Mesh(value.geometry, value.material); mesh.name = `${shape.type} ${shape.loc.line}`;
    mesh.matrixAutoUpdate = false; root.add(mesh);
  }
  const instances = new Map<string, number[][]>();
  for (const instance of scene.instances) {
    if (!instances.has(instance.name)) instances.set(instance.name, []);
    instances.get(instance.name)!.push(instance.transform);
  }
  for (const [name, matrices] of instances) for (const shape of scene.objects[name]) {
    const value = meshes.get(shape) ?? await create(shape); if (!value) continue;
    for (const negative of [false, true]) {
      const selected = matrices.map(matrix => mirror.clone().multiply(new THREE.Matrix4().fromArray(matrix)).multiply(mirror)).filter(matrix => (matrix.determinant() < 0) === negative);
      if (!selected.length) continue;
      let g = value.geometry;
      const reflection = new THREE.Matrix4().makeScale(-1, 1, 1);
      if (negative) {
        g = g.clone().applyMatrix4(reflection);
        if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
        const indices = g.index!;
        for (let i = 0; i < indices.count; i += 3) { const a = indices.getX(i); indices.setX(i, indices.getX(i + 1)); indices.setX(i + 1, a); }
      }
      if (shape.inside !== shape.outside) mediumInterfaces.set(g, shape);
      const mesh = new THREE.InstancedMesh(g, value.material, selected.length); mesh.name = name;
      selected.forEach((matrix, i) => mesh.setMatrixAt(i, negative ? matrix.multiply(reflection) : matrix));
      root.add(mesh);
    }
  }
  const film = scene.film?.params ?? {}, cp = scene.camera?.params ?? {};
  const width = scalar(film, 'xresolution', 1280), height = scalar(film, 'yresolution', 720), aspect = width / height;
  const fov = verticalFov(scalar(cp, 'fov', 90), aspect);
  const lensRadius = scalar(cp, 'lensradius', 0), focusDistance = scalar(cp, 'focaldistance', 1e6);
  const fStop = lensRadius > 0 ? .024 / (2 * Math.tan(fov * Math.PI / 360)) / (2 * lensRadius) : 0;
  if (scene.camera) {
    const type = scene.camera.type;
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (type === 'orthographic') camera = new THREE.OrthographicCamera(-Math.max(1, aspect), Math.max(1, aspect), Math.max(1, 1 / aspect), -Math.max(1, 1 / aspect), .0001, 1e8);
    else {
      camera = new THREE.PerspectiveCamera(fov, aspect, .0001, 1e8);
      camera.filmGauge = 24 * Math.max(1, aspect); camera.focus = focusDistance;
      if (type !== 'perspective') warn(scene.camera, `${type} camera approximated as perspective`, 'camera');
    }
    camera.name = 'PBRT camera'; camera.matrixAutoUpdate = false;
    camera.matrix.copy(mirror).multiply(new THREE.Matrix4().fromArray(scene.camera.transform)).multiply(mirror);
    root.add(camera);
    if (cp.screenwindow) warn(scene.camera, 'Custom screenwindow ignored', 'camera');
  }
  for (const entity of scene.lights) {
    const p = entity.params, transform = mirror.clone().multiply(new THREE.Matrix4().fromArray(entity.transform));
    if (!['point', 'spot', 'distant', 'infinite'].includes(entity.type)) { warn(entity, `${entity.type} light skipped`, 'light'); continue; }
    if (entity.type === 'infinite') continue;
    const value = await textures.value(p, entity.type === 'distant' ? 'L' : 'I', [1, 1, 1], entity);
    const color = new THREE.Color(...value.color as [number, number, number]);
    let intensity = scalar(p, 'scale', 1);
    const power = scalar(p, 'power', -1), illuminance = scalar(p, 'illuminance', -1);
    const from = new THREE.Vector3(...vector(p, 'from', [0, 0, 0]) as [number, number, number]).applyMatrix4(transform);
    const to = new THREE.Vector3(...vector(p, 'to', [0, 0, 1]) as [number, number, number]).applyMatrix4(transform);
    let light: THREE.PointLight | THREE.SpotLight | THREE.DirectionalLight;
    if (entity.type === 'point') { if (power > 0) intensity *= power / (4 * Math.PI); light = new THREE.PointLight(color, intensity); }
    else if (entity.type === 'spot') {
      const angle = scalar(p, 'coneangle', 30), delta = scalar(p, 'conedeltaangle', 5);
      if (power > 0) intensity *= power / (2 * Math.PI * (1 - (Math.cos((angle - delta) * Math.PI / 180) + Math.cos(angle * Math.PI / 180)) / 2));
      light = new THREE.SpotLight(color, intensity, 0, angle * Math.PI / 180, delta / angle);
    } else { if (illuminance > 0) intensity *= illuminance; light = new THREE.DirectionalLight(color, intensity); }
    light.userData.mutracerRadius = 0; light.position.copy(from); light.name = `PBRT ${entity.type}`;
    if (light instanceof THREE.SpotLight || light instanceof THREE.DirectionalLight) { light.target.position.copy(to); root.add(light.target); }
    root.add(light);
  }
  let environment: Image | null = null;
  for (const entity of scene.lights.filter(l => l.type === 'infinite')) {
    const p = entity.params;
    if (p.portal) warn(entity, 'Environment portal ignored', 'light');
    const value = await textures.value(p, 'L', [1, 1, 1], entity);
    let image: Image;
    if (p.filename) {
      const source = await textures.image(String(first(p, 'filename', '')));
      const data = source.data instanceof Float32Array ? source.data : Float32Array.from(source.data, v => v / 255);
      image = reprojectEnvironment({ ...source, data }, mirror.clone().multiply(new THREE.Matrix4().fromArray(entity.transform)), true, 'nearest', 512);
      let scale = scalar(p, 'scale', 1);
      const illuminance = scalar(p, 'illuminance', -1);
      if (illuminance > 0) {
        let sum = 0;
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
          const d = 1 - Math.abs(2 * (x + .5) / source.width - 1) - Math.abs(2 * (y + .5) / source.height - 1);
          const r = 1 - Math.abs(d), z = Math.sign(d) * (1 - r * r), i = (y * source.width + x) * 4;
          if (z > 0) sum += (.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]) * z;
        }
        // Match the pinned renderer's normalization, including its 2π factor.
        const k = sum * 2 * Math.PI / (source.width * source.height);
        if (k > 0) scale *= illuminance / k;
      }
      for (let i = 0; i < image.data.length; i++) if (i % 4 < 3) image.data[i] *= scale;
      if (environment) warn(entity, 'Additional environment image replaces the previous map', 'light');
      environment = image;
    } else {
      const scale = scalar(p, 'scale', 1) * (scalar(p, 'illuminance', -1) > 0 ? scalar(p, 'illuminance', 1) / Math.PI : 1);
      image = { width: 1, height: 1, data: new Float32Array([...value.color.map(v => v * scale), 1]) };
      environment = image;
    }

  }
  for (const medium of Object.values(scene.media)) if (medium.type !== 'homogeneous') warn(medium, `${medium.type} medium skipped`, 'medium');
  if (film.sensor && first(film, 'sensor', 'cie1931') !== 'cie1931') warn(scene.film!, 'Sensor approximated by CIE 1931', 'camera');
  if (film.whitebalance) warn(scene.film!, 'White balance ignored', 'camera');
  root.updateMatrixWorld(true);
  if (scene.camera && mediumInterfaces.size) {
    const eye = new THREE.Vector3().setFromMatrixPosition(mirror.clone().multiply(new THREE.Matrix4().fromArray(scene.camera.transform)));
    const boundaries: THREE.Mesh[] = [];
    root.traverse(o => { if (o instanceof THREE.Mesh && mediumInterfaces.has(o.geometry)) boundaries.push(o); });
    const raycaster = new THREE.Raycaster(), center = new THREE.Vector3(), instance = new THREE.Matrix4();
    // Check the incoming side of the first interface on each probe ray,
    // rather than extrapolating every nested boundary's region to the camera.
    for (const target of boundaries) {
      target.geometry.computeBoundingSphere();
      const count = target instanceof THREE.InstancedMesh ? target.count : 1;
      for (let i = 0; i < count; i++) {
        center.copy(target.geometry.boundingSphere!.center);
        if (target instanceof THREE.InstancedMesh) { target.getMatrixAt(i, instance); center.applyMatrix4(instance); }
        center.applyMatrix4(target.matrixWorld).sub(eye);
        if (center.lengthSq() === 0) center.set(1, .317, .123);
        raycaster.set(eye, center.normalize());
        const hit = raycaster.intersectObjects(boundaries, false)[0];
        if (!hit?.face) continue;
        const object = hit.object as THREE.Mesh, material = object.material as THREE.Material;
        const shape = mediumInterfaces.get(object.geometry)!;
        const world = object.matrixWorld.clone();
        if (object instanceof THREE.InstancedMesh && hit.instanceId !== undefined) { object.getMatrixAt(hit.instanceId, instance); world.multiply(instance); }
        const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(world));
        if (interiorMedium(shape, scene).flip) normal.negate();
        const expected = normal.dot(raycaster.ray.direction) < 0 ? shape.outside : shape.inside;
        if (expected !== scene.cameraMedium) {
          material.userData.pbrtComparable = false;
          warn(shape, `Camera medium ${JSON.stringify(scene.cameraMedium)} disagrees with the first boundary's incoming medium ${JSON.stringify(expected)}; the scene is excluded from strict comparison`, 'medium-camera');
        }
      }
    }
  }
  // A primary-surface mask cannot isolate shadows or indirect paths through
  // null or inconsistent medium boundaries. Preserve all measurements.
  root.userData.pbrtComparable = !scene.warnings.some(w => ['medium-shadow', 'medium-topology', 'medium-orientation', 'medium-camera', 'path-depth'].includes(w.code));
  return { root, environment, settings: { width, height, bounces, samples: scalar(scene.sampler?.params ?? {}, 'pixelsamples', 16), exposure: scalar(film, 'iso', 100) / 100 * (scalar(cp, 'shutterclose', 1) - scalar(cp, 'shutteropen', 0)), fStop, focusDistance } };
}
