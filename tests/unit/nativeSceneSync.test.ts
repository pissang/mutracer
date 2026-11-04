import {configureSceneParameters, retainedSceneParameters, releaseSceneParameters, sceneAtlasParameters} from '../../native/src/scene-core';
import {SETTINGS as S, RESOURCE as R, PACKET_HEADER as PH, PACKET_ENTRY as PE} from '../../native/src/layout';
import { describe, expect, it } from 'vitest';
import { SyncedScene } from '../../native/src/scene-sync';
import { HEADER as H, GEOMETRY as G, MESH as M, MATERIAL as MAT, TEXTURE as T, LIGHT as L, CAMERA as C, BATCH as B,
  VERSION } from '../../native/src/layout';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import type { SceneChanges } from '../../src/renderer/sceneChangeDetector';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import InstancedMesh from '../../src/scene/InstancedMesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import SphereLight from '../../src/scene/SphereLight';
import type { Scene } from '../../src/scene/Scene';
import type { TextureWrapMode } from '../../src/scene/TextureState';

// One scene description, encoded as a native descriptor and built as Web objects.
interface Spec {
  textures: { pixels: number[]; wrap?: [number, number]; scale?: [number, number] }[];
  geometries: { positions: number[]; indices: number[] }[];
  materials: { color: [number, number, number]; roughness: number; map?: number }[];
  meshes: { geometry: number; material: number; x: number; instances?: { transforms: number[]; colors?: number[] } }[];
  lights: { intensity: number; x: number }[];
  background: [number, number, number, number];
}
const identity = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const quad = () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], indices: [0, 1, 2, 2, 1, 3] });
function base(): Spec {
  return {
    textures: [{ pixels: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255] }],
    geometries: [quad(), quad()],
    materials: [{ color: [0.8, 0.8, 0.8], roughness: 0.3, map: 0 }, { color: [0.2, 0.4, 0.6], roughness: 0.5 }],
    meshes: [{ geometry: 0, material: 0, x: 0 }, { geometry: 1, material: 1, x: 2 },
      { geometry: 0, material: 1, x: 4, instances: { transforms: [...identity(0), ...identity(1)], colors: [1, 1, 1, 0.5, 0.5, 0.5] } }],
    lights: [{ intensity: 5, x: 1 }],
    background: [0.1, 0.2, 0.3, 1]
  };
}

function encode(spec: Spec): Uint8Array {
  const words: number[] = new Array(H.WORDS).fill(0);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const bits = (x: number) => { f32[0] = x; return u32[0]; };
  const reserve = (count: number) => { const at = words.length; for (let i = 0; i < count; i++) words.push(0); return at; };
  const floats = (values: number[]) => { const at = reserve(values.length); values.forEach((v, i) => { words[at + i] = bits(v); }); return at; };
  const uints = (values: number[]) => { const at = reserve(values.length); values.forEach((v, i) => { words[at + i] = v; }); return at; };
  const textures = reserve(spec.textures.length * T.WORDS);
  spec.textures.forEach((texture, i) => {
    const o = textures + i * T.WORDS, pixels = reserve(4);
    for (let p = 0; p < 4; p++) words[pixels + p] = (texture.pixels[p * 4] | texture.pixels[p * 4 + 1] << 8 |
      texture.pixels[p * 4 + 2] << 16 | texture.pixels[p * 4 + 3] << 24) >>> 0;
    words[o + T.WIDTH] = 2; words[o + T.HEIGHT] = 2; words[o + T.PIXELS] = pixels;
    words[o + T.UV_SCALE] = bits(texture.scale?.[0] ?? 1); words[o + T.UV_SCALE + 1] = bits(texture.scale?.[1] ?? 1);
    words[o + T.WRAP_S] = texture.wrap?.[0] ?? 0; words[o + T.WRAP_T] = texture.wrap?.[1] ?? 0;
  });
  const geometryData = spec.geometries.map(g => ({ position: floats(g.positions), index: uints(g.indices), g }));
  const geometries = reserve(spec.geometries.length * G.WORDS);
  geometryData.forEach(({ position, index, g }, i) => {
    const o = geometries + i * G.WORDS;
    words[o + G.VERTEX_COUNT] = g.positions.length / 3; words[o + G.INDEX_COUNT] = g.indices.length;
    words[o + G.POSITION] = position; words[o + G.INDICES] = index;
  });
  const materials = reserve(spec.materials.length * MAT.WORDS);
  spec.materials.forEach((m, i) => {
    const o = materials + i * MAT.WORDS;
    m.color.forEach((c, k) => { words[o + MAT.BASE_COLOR + k] = bits(c); });
    words[o + MAT.ROUGHNESS] = bits(m.roughness); words[o + MAT.IOR] = bits(1.5); words[o + MAT.OPACITY] = bits(1);
    for (let k = 0; k < 3; k++) words[o + MAT.EMISSION_COLOR + k] = bits(1);
    words[o + MAT.MAP] = m.map ?? 0xffffffff;
    words[o + MAT.NORMAL_MAP] = words[o + MAT.METALLIC_ROUGHNESS_MAP] = words[o + MAT.EMISSIVE_MAP] = 0xffffffff;
  });
  const batchData = spec.meshes.map(mesh => mesh.instances ? {
    transforms: floats(mesh.instances.transforms), colors: mesh.instances.colors ? floats(mesh.instances.colors) : 0,
    count: mesh.instances.transforms.length / 16 } : undefined);
  const meshes = reserve(spec.meshes.length * M.WORDS);
  spec.meshes.forEach((mesh, i) => {
    const o = meshes + i * M.WORDS;
    words[o + M.GEOMETRY] = mesh.geometry; words[o + M.MATERIAL] = mesh.material;
    identity(mesh.x).forEach((v, k) => { words[o + M.TRANSFORM + k] = bits(v); });
  });
  const batches = reserve(spec.meshes.length * B.WORDS);
  batchData.forEach((batch, i) => {
    const o = batches + i * B.WORDS;
    if (!batch) { words[o + B.COUNT] = 0xffffffff; return; }
    words[o + B.COUNT] = batch.count; words[o + B.TRANSFORMS] = batch.transforms; words[o + B.COLORS] = batch.colors;
  });
  const lights = reserve(spec.lights.length * L.WORDS);
  spec.lights.forEach((light, i) => {
    const o = lights + i * L.WORDS;
    words[o + L.TYPE] = 1; for (let k = 0; k < 3; k++) words[o + L.COLOR + k] = bits(1);
    words[o + L.INTENSITY] = bits(light.intensity); words[o + L.SIZE] = bits(0.25);
    identity(light.x).forEach((v, k) => { words[o + L.TRANSFORM + k] = bits(v); });
  });
  const camera = reserve(C.WORDS);
  words[camera + C.FOV] = bits(45); words[camera + C.NEAR] = bits(0.1); words[camera + C.FAR] = bits(100);
  words[camera + C.ZOOM] = bits(1); words[camera + C.SENSOR_HEIGHT] = bits(24); words[camera + C.METERS_PER_UNIT] = bits(1);
  identity(0).forEach((v, k) => { words[camera + C.TRANSFORM + k] = bits(v); });
  Object.assign(words, { [H.VERSION]: VERSION.SCENE, [H.LENGTH]: words.length, [H.WIDTH]: 8, [H.HEIGHT]: 8,
    [H.GEOMETRY_COUNT]: spec.geometries.length, [H.MESH_COUNT]: spec.meshes.length, [H.MATERIAL_COUNT]: spec.materials.length,
    [H.LIGHT_COUNT]: spec.lights.length, [H.TEXTURE_COUNT]: spec.textures.length, [H.GEOMETRY_OFFSET]: geometries,
    [H.MESH_OFFSET]: meshes, [H.MATERIAL_OFFSET]: materials, [H.LIGHT_OFFSET]: lights, [H.TEXTURE_OFFSET]: textures,
    [H.CAMERA_OFFSET]: camera, [H.BATCH_OFFSET]: batches });
  spec.background.forEach((c, k) => { words[H.BACKGROUND_COLOR + k] = bits(c); });
  return new Uint8Array(new Uint32Array(words).buffer);
}

class WebScene {
  textures: Texture[]; geometries: Geometry[]; materials: OpenPBRMaterial[]; meshes: Mesh[]; lights: SphereLight[]; scene: Scene;
  constructor(spec: Spec) {
    this.textures = spec.textures.map(t => new Texture({ data: new Uint8Array(t.pixels), width: 2, height: 2 }));
    this.textures.forEach((texture, i) => {
      const specTexture = spec.textures[i];
      const modes: TextureWrapMode[] = ['repeat', 'clamp-to-edge', 'mirrored-repeat'];
      texture.wrapS = modes[specTexture.wrap?.[0] ?? 0]; texture.wrapT = modes[specTexture.wrap?.[1] ?? 0];
      texture.uvScale = specTexture.scale ?? [1, 1];
    });
    this.geometries = spec.geometries.map(g => new Geometry({ position: new Attribute(new Float32Array(g.positions), 3),
      indices: new Attribute(new Uint32Array(g.indices), 1) }));
    this.materials = spec.materials.map(m => new OpenPBRMaterial({ baseColor: [...m.color], specularRoughness: m.roughness,
      map: m.map === undefined ? undefined : this.textures[m.map] }));
    this.meshes = spec.meshes.map(m => this.mesh(m));
    this.lights = spec.lights.map(l => { const light = new SphereLight({ intensity: l.intensity, radius: 0.25 }); light.transform = identity(l.x); return light; });
    this.scene = { meshes: this.meshes, lights: this.lights, background: [...spec.background] };
  }
  mesh(m: Spec['meshes'][number]): Mesh {
    const geometry = this.geometries[m.geometry], material = this.materials[m.material];
    const mesh = m.instances ? new InstancedMesh(geometry, material, { count: m.instances.transforms.length / 16,
      transforms: new Float32Array(m.instances.transforms), colors: m.instances.colors ? new Float32Array(m.instances.colors) : undefined })
      : new Mesh(geometry, material);
    mesh.transform = new Float32Array(identity(m.x));
    return mesh;
  }
}

type Normalized = { meshes: string; transforms: number[]; colors: number[]; geometries: number[]; materials: number[]; lights: boolean; background: boolean };
// A full mesh update ignores the partial lists, and with index identity they may
// name different records than object identity does; compare them only when incremental.
function partial(result: Normalized): Normalized {
  return result.meshes === 'full' ? { ...result, transforms: [], colors: [], geometries: [], materials: [] } : result;
}
function normalizeWeb(changes: SceneChanges, web: WebScene): Normalized {
  return { meshes: changes.meshes, transforms: changes.transforms.map(m => web.meshes.indexOf(m)).sort(),
    colors: changes.colors.map(m => web.meshes.indexOf(m)).sort(), geometries: changes.geometries.map(g => web.geometries.indexOf(g)).sort(),
    materials: changes.materials.map(m => web.materials.indexOf(m)).sort(), lights: changes.lights, background: changes.background };
}
function normalizeNative(scene: SyncedScene, bytes: Uint8Array, unchanged?: Uint8Array): Normalized {
  const { scene: changes } = scene.sync(bytes, false, unchanged);
  return { meshes: changes.meshes, transforms: changes.transforms.map(m => scene.meshes.indexOf(m)).sort(),
    colors: changes.colors.map(m => scene.meshes.indexOf(m)).sort(), geometries: changes.geometries.map(g => scene.geometries.indexOf(g)).sort(),
    materials: changes.materials.map(m => scene.materials.indexOf(m)).sort(), lights: changes.lights, background: changes.background };
}

// Each edit: the descriptor change, and the equivalent Web edit with its notifications.
const edits: [string, (s: Spec) => void, (w: WebScene) => void][] = [
  ['nothing', () => {}, () => {}],
  ['mesh transform', s => { s.meshes[1].x = 3; }, w => { w.meshes[1].transform[12] = 3; }],
  ['material roughness', s => { s.materials[1].roughness = 0.9; }, w => { w.materials[1].specularRoughness = 0.9; }],
  ['material color', s => { s.materials[0].color = [1, 0, 0]; }, w => { w.materials[0].baseColor = [1, 0, 0]; }],
  ['texture pixels', s => { s.textures[0].pixels[0] = 7; }, w => { (w.textures[0].image as { data: Uint8Array }).data[0] = 7; w.textures[0].markUpdated(); }],
  ['texture wrapping', s => { s.textures[0].wrap = [1, 2]; },
    w => { w.textures[0].wrapS = 'clamp-to-edge'; w.textures[0].wrapT = 'mirrored-repeat'; }],
  ['texture repeat', s => { s.textures[0].scale = [-2, 0]; }, w => { w.textures[0].uvScale = [-2, 0]; }],
  ['vertex positions', s => { s.geometries[1].positions[0] = 0.5; },
    w => { w.geometries[1].position.array[0] = 0.5; w.geometries[1].markVerticesUpdated(); }],
  ['index order', s => { s.geometries[1].indices = [0, 2, 1, 2, 3, 1]; },
    w => { w.geometries[1].indices.array.set([0, 2, 1, 2, 3, 1]); w.geometries[1].markUpdated(); }],
  ['vertex count', s => { s.geometries[1].positions.push(2, 2, 0); },
    w => { w.geometries[1].position = new Attribute(new Float32Array([...w.geometries[1].position.array, 2, 2, 0]), 3); w.geometries[1].markUpdated(); }],
  ['material assignment', s => { s.meshes[0].material = 1; }, w => { w.meshes[0].materials[0] = w.materials[1]; }],
  ['add mesh', s => { s.meshes.push({ geometry: 1, material: 0, x: 6 }); },
    w => { w.meshes.push(w.mesh({ geometry: 1, material: 0, x: 6 })); }],
  ['remove mesh', s => { s.meshes.splice(1, 1); }, w => { w.meshes.splice(1, 1); }],
  ['instance transform', s => { s.meshes[2].instances!.transforms[12] = 9; },
    w => { (w.meshes[2] as InstancedMesh).transforms[12] = 9; (w.meshes[2] as InstancedMesh).markTransformsUpdated(); }],
  ['instance colors', s => { s.meshes[2].instances!.colors![0] = 0.25; },
    w => { (w.meshes[2] as InstancedMesh).colors![0] = 0.25; (w.meshes[2] as InstancedMesh).markColorsUpdated(); }],
  ['light intensity', s => { s.lights[0].intensity = 8; }, w => { w.lights[0].intensity = 8; }],
  ['add light', s => { s.lights.push({ intensity: 1, x: 5 }); },
    w => { const light = new SphereLight({ intensity: 1, radius: 0.25 }); light.transform = identity(5); w.lights.push(light); }],
  ['background color', s => { s.background[1] = 0.6; }, w => { (w.scene.background as number[])[1] = 0.6; }],
  ['mesh transform and material', s => { s.meshes[0].x = 1; s.materials[0].roughness = 0.1; },
    w => { w.meshes[0].transform[12] = 1; w.materials[0].specularRoughness = 0.1; }]
];

describe('native scene sync', () => {
  it.each([0, 1, 2])('decodes and retains wrapping mode %s on either axis', mode => {
    const spec = base(); spec.textures[0].wrap = [mode, 2 - mode]; spec.textures[0].scale = [-2, 0];
    const synced = new SyncedScene(); synced.sync(encode(spec)); synced.accept();
    const modes = ['repeat', 'clamp-to-edge', 'mirrored-repeat'];
    expect(synced.textures[0].wrapS).toBe(modes[mode]);
    expect(synced.textures[0].wrapT).toBe(modes[2 - mode]);
    expect(synced.textures[0].uvScale).toEqual([-2, 0]);
    spec.textures[0].wrap = [2 - mode, mode]; synced.sync(encode(spec));
    expect(synced.textures[0].wrapS).toBe(modes[2 - mode]);
    expect(synced.textures[0].wrapT).toBe(modes[mode]);
  });

  it.each(edits)('classifies %s like the Web change detector', (_name, editSpec, editWeb) => {
    const spec = base(), web = new WebScene(spec), detector = new SceneChangeDetector(), synced = new SyncedScene();
    detector.detect(web.scene); detector.commit();
    expect(synced.sync(encode(spec)).scene.meshes).toBe('full'); synced.accept();
    editSpec(spec); editWeb(web);
    const expected = partial(normalizeWeb(detector.detect(web.scene), web));
    expect(partial(normalizeNative(synced, encode(spec)))).toEqual(expected);
  });
  it.each(edits)('classifies %s the same with unchanged-record hints', (_name, editSpec) => {
    const spec = base(), plain = new SyncedScene(), hinted = new SyncedScene();
    plain.sync(encode(spec)); plain.accept();
    hinted.sync(encode(spec)); hinted.accept();
    const before = JSON.stringify(spec);
    editSpec(spec);
    const previous = JSON.parse(before) as Spec;
    // The host marks records whose contents it found identical.
    const same = (a: unknown, b: unknown) => Number(JSON.stringify(a) === JSON.stringify(b));
    const hints = previous.geometries.length === spec.geometries.length && previous.textures.length === spec.textures.length
      ? new Uint8Array([...spec.geometries.map((g, i) => same(g, previous.geometries[i])), ...spec.textures.map((t, i) => same(t, previous.textures[i]))])
      : undefined;
    expect(partial(normalizeNative(hinted, encode(spec), hints))).toEqual(partial(normalizeNative(plain, encode(spec))));
  });
  it('reports only camera, resolution and quality edits outside the scene', () => {
    const spec = base(), synced = new SyncedScene();
    synced.sync(encode(spec)); synced.accept();
    const bytes = encode(spec), words = new Uint32Array(bytes.buffer);
    words[words[H.CAMERA_OFFSET] + C.FOV] = new Uint32Array(new Float32Array([50]).buffer)[0];
    words[H.WIDTH] = 16;
    const changes = synced.sync(bytes);
    expect([changes.scene.meshes, changes.camera, changes.resolution, changes.quality]).toEqual(['none', true, true, false]);
  });
  it('keeps pending changes until they are accepted', () => {
    const spec = base(), synced = new SyncedScene();
    synced.sync(encode(spec)); synced.accept();
    spec.materials[1].roughness = 0.9;
    expect(synced.sync(encode(spec)).scene.materials).toHaveLength(1);
    expect(synced.sync(encode(spec)).scene.materials).toHaveLength(1);
    synced.accept();
    expect(synced.sync(encode(spec)).scene.meshes).toBe('none');
  });
});

it('detects environment controls without treating them as topology changes', () => {
  const original = encode(base()), scene = new SyncedScene();
  scene.sync(original); scene.accept();
  const bytes = new Uint8Array(original.byteLength + 16);
  bytes.set(original);
  const words = new Uint32Array(bytes.buffer), floats = new Float32Array(bytes.buffer);
  words[H.ENVIRONMENT_SETTINGS] = original.byteLength / 4;
  words[H.LENGTH] = words.length;
  floats.set([2, 1.2, 0.5, -0.7], original.byteLength / 4);
  const changes = scene.sync(bytes);
  expect(changes.scene.meshes).toBe('none');
  expect(changes.scene.background).toBe(true);
  scene.accept();
  expect(scene.sync(bytes).scene.background).toBe(false);
  scene.accept();
  expect(scene.sync(original).scene.background).toBe(true);
});

it('prepares tangents for a material-only edit even when geometry records are unchanged', () => {
  const raw = encode(base()), count = raw.byteLength / 4;
  const u = new Uint32Array(count + 12), f = new Float32Array(u.buffer);
  u.set(new Uint32Array(raw.buffer));
  u[H.LENGTH] = u.length;
  u[u[H.GEOMETRY_OFFSET] + G.UV] = count;
  f.set([0,0, 1,0, 0,1, 1,1], count);
  const material = u[H.MATERIAL_OFFSET];
  u[material + MAT.EXTENSION_OFFSET] = count + 8;
  u[material + MAT.EXTENSION_COUNT] = 1;
  u[count + 8] = 9;
  const scene = new SyncedScene();
  const first = new Uint8Array(u.buffer.slice(0));
  scene.sync(first); scene.accept();
  expect(scene.geometries[0].tangent).toBeUndefined();
  f[count + 9] = .5;
  const unchanged = new Uint8Array(u[H.GEOMETRY_COUNT] + u[H.TEXTURE_COUNT]).fill(1);
  expect(scene.sync(new Uint8Array(u.buffer), false, unchanged).scene.meshes).toBe('full');
  expect(scene.geometries[0].tangent).toBeDefined();
  scene.accept();
  expect(scene.sync(new Uint8Array(u.buffer)).scene.meshes).toBe('none');
});

it('shares descriptor image storage and isolates a pixel edit to one sampler', () => {
  const spec = base();
  spec.textures.push({...spec.textures[0], wrap: [1, 2]});
  spec.materials[1].map = 1;
  const bytes = encode(spec), u = new Uint32Array(bytes.buffer), off = u[H.TEXTURE_OFFSET];
  u[off + T.WORDS + T.PIXELS] = u[off + T.PIXELS];
  const synced = new SyncedScene(); synced.sync(bytes); synced.accept();
  expect(synced.textures[0].pixels).toBe(synced.textures[1].pixels);
  expect(synced.textures[1].wrapS).toBe('clamp-to-edge');
  spec.textures[1] = {...spec.textures[1], pixels: [...spec.textures[1].pixels]};
  spec.textures[1].pixels[0] = 7;
  const changes = synced.sync(encode(spec));
  expect(synced.textures[0].pixels.data[0]).toBe(255);
  expect(synced.textures[1].pixels.data[0]).toBe(7);
  expect(synced.textures[0].pixels).not.toBe(synced.textures[1].pixels);
  expect(changes.scene.materials).toContain(synced.materials[1]);
});

it('emits one bindless GPU image for logical samplers sharing pixels, and rebuilds on detach', () => {
  const spec = base();
  spec.textures.push({...spec.textures[0], wrap: [1, 2]}); spec.materials[1].map = 1;
  const bytes = encode(spec), u = new Uint32Array(bytes.buffer), off = u[H.TEXTURE_OFFSET];
  u[off + T.WORDS + T.PIXELS] = u[off + T.PIXELS];
  const settings = new Uint8Array(S.WORDS * 4), su = new Uint32Array(settings.buffer);
  su[S.STRUCT_SIZE] = settings.length; su[S.TEXTURE_BINDINGS] = 1;
  const token = 94731;
  try {
    configureSceneParameters(settings, token);
    const packet = retainedSceneParameters(bytes, token), words = new Uint32Array(packet.buffer);
    expect(words[0]).toBe(VERSION.RESOURCE_PACKET);
    const images: number[] = [];
    for (let i = 0; i < words[PH.COUNT]; i++) {
      const p = PH.WORDS + i * PE.WORDS;
      if (words[p + PE.ID] >= R.MATERIAL_TEXTURE_BASE) images.push(p);
    }
    expect(images).toHaveLength(1);
    expect(words[images[0] + PE.LENGTH]).toBe(16);
    expect([words[images[0] + PE.WIDTH], words[images[0] + PE.HEIGHT]]).toEqual([2, 2]);
    expect(new Uint32Array(sceneAtlasParameters(bytes, token).buffer)[0]).toBe(VERSION.RESOURCE_WRITES);
    const samplerEdit = bytes.slice(), editWords = new Uint32Array(samplerEdit.buffer);
    editWords[off + T.WORDS + T.WRAP_T] = 0;
    expect(new Uint32Array(sceneAtlasParameters(samplerEdit, token).buffer)[0]).toBe(VERSION.RESOURCE_WRITES);
    const detached = encode(spec); // Equal pixels with distinct ownership still detach.
    expect([...new Uint32Array(sceneAtlasParameters(detached, token).buffer)]).toEqual([2, 2, 0, 0]);
  } finally {releaseSceneParameters(token);}
});
