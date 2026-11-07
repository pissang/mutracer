import {afterEach, describe, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';
import RenderLoop from '../../src/RenderLoop';
import Camera from '../../src/scene/Camera';
import Mesh from '../../src/scene/Mesh';
import InstancedMesh from '../../src/scene/InstancedMesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {SpotLight, createPlaneGeometry, createSphereGeometry} from '../../src/main';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector';
import {CommittedScene} from '../../src/renderer/committedScene';
import {prepareSceneMeshes, selectVisibleInstances} from '../../src/renderer/scenePreparation';
import {computeGeometryBounds} from '../../src/renderer/geometryBvhBounds';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import type {Scene} from '../../src/scene/Scene';
import type {TLASInstance} from '../../src/renderer/bvhAccel';
import {installFakeDocument, installFakeGPU, installFakeWebGL} from '../helpers/fakeGPU';

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));
const emissive = () => new OpenPBRMaterial({emissionColor: [1, 1, 1], emissionLuminance: 2});

describe('mesh visibility change detection', () => {
  it('defaults to visible and reports toggles as incremental visibility changes', () => {
    const a = new Mesh(createSphereGeometry(4, 4), new OpenPBRMaterial()), b = new Mesh(createPlaneGeometry(), new OpenPBRMaterial());
    expect(a.visible).toBe(true);
    const scene: Scene = {meshes: [a, b], lights: []}, detector = new SceneChangeDetector();
    detector.detect(scene); detector.commit();
    a.visible = false;
    const changes = detector.detect(scene);
    expect(changes).toMatchObject({meshes: 'incremental', membershipOnly: false, visibility: [a], added: []});
    detector.commit();
    expect(detector.detect(scene).meshes).toBe('none');
    a.visible = false;
    expect(detector.detect(scene).visibility).toEqual([]);
  });

  it('separates membership edits from structural edits and matches retained meshes by identity', () => {
    const geometry = createSphereGeometry(4, 4), material = new OpenPBRMaterial();
    const a = new Mesh(geometry, material), b = new Mesh(geometry, material), c = new Mesh(geometry, material);
    const scene: Scene = {meshes: [a, b], lights: []}, detector = new SceneChangeDetector();
    detector.detect(scene); detector.commit();

    scene.meshes = [b];
    expect(detector.detect(scene)).toMatchObject({meshes: 'full', membershipOnly: true, added: []});
    detector.commit();

    scene.meshes = [c, b];
    b.transform[12] = 4; b.visible = false;
    expect(detector.detect(scene)).toMatchObject({meshes: 'full', membershipOnly: true, added: [c], transforms: [b], visibility: [b]});
    detector.commit();

    scene.meshes.reverse();
    expect(detector.detect(scene)).toMatchObject({meshes: 'full', membershipOnly: true, added: []});
    detector.commit();

    scene.meshes = [b];
    b.geometry = createPlaneGeometry();
    expect(detector.detect(scene)).toMatchObject({meshes: 'full', membershipOnly: false});
  });

  it('mirrors only added meshes and toggled flags into the committed scene', () => {
    const a = new Mesh(createSphereGeometry(4, 4), new OpenPBRMaterial()), b = new Mesh(createPlaneGeometry(), new OpenPBRMaterial());
    const scene: Scene = {meshes: [a], lights: []}, detector = new SceneChangeDetector(), committed = new CommittedScene();
    const first = committed.capture(scene, detector.detect(scene)); detector.commit();
    const mirrorA = first.meshes[0];
    a.visible = false;
    committed.capture(scene, detector.detect(scene)); detector.commit();
    expect(mirrorA.visible).toBe(false);
    expect(a.visible).toBe(false);
    scene.meshes = [b, a];
    const next = committed.capture(scene, detector.detect(scene)); detector.commit();
    expect(next.meshes[1]).toBe(mirrorA);
    expect(next.meshes[0]).not.toBe(b);
    expect(next.meshes[0].geometry).not.toBe(b.geometry);
    expect(next.meshes).not.toBe(scene.meshes);
  });
});

describe('visible instance selection', () => {
  const prepare = (meshes: Mesh[]) => prepareSceneMeshes(meshes, mesh => ({geometry: mesh.geometry, displacementScale: 0}), computeGeometryBounds, false, false);
  function scene() {
    const geometry = createSphereGeometry(4, 4), material = new OpenPBRMaterial(), light = emissive();
    const meshes = [new Mesh(geometry, material), new Mesh(createPlaneGeometry(), light), new Mesh(geometry, material)];
    meshes.forEach((mesh, i) => { mesh.transform[12] = i * 3; });
    return meshes;
  }

  it('keeps hidden meshes resident and excludes them from instances and emitters', () => {
    const meshes = scene();
    meshes[1].visible = false;
    const prepared = prepare(meshes);
    expect(prepared.residentBindings.map(b => b.mesh)).toEqual(meshes);
    expect(prepared.instanceBindings.map(b => b.mesh)).toEqual([meshes[0], meshes[2]]);
    expect(prepared.instances).toHaveLength(2);
    expect(prepared.emissiveBindings).toEqual([]);
    expect(prepared.materials).toHaveLength(2);
  });

  it('reselects exactly what a full preparation of the visible meshes produces', () => {
    const meshes = scene();
    const prepared = prepare(meshes);
    meshes[0].visible = false;
    const hidden = selectVisibleInstances(prepared, meshes);
    const removed = prepare(meshes.slice(1).map(mesh => mesh));
    expect(hidden.instanceBindings.map(b => b.mesh)).toEqual(meshes.slice(1));
    const records = (instances: unknown) => (instances as TLASInstance[]).map(i => [...i.bounds.min, ...i.bounds.max, ...i.transform]);
    expect(records(hidden.instances)).toEqual(records(removed.instances));
    expect(hidden.emissiveBindings.map(b => b.mesh)).toEqual([meshes[1]]);
    expect(hidden.blases).toBe(prepared.blases);
    meshes[0].visible = true; meshes[1].visible = false;
    expect(selectVisibleInstances(hidden, meshes).emissiveBindings).toEqual([]);
    meshes[1].visible = true;
    expect(selectVisibleInstances(hidden, meshes).instanceBindings.map(b => b.mesh)).toEqual(meshes);
  });

  it('packs instanced meshes only while a visible batch exists', () => {
    const geometry = createSphereGeometry(4, 4), material = new OpenPBRMaterial();
    const batch = new InstancedMesh(geometry, material, {count: 2}), plain = new Mesh(geometry, material);
    const prepared = prepare([batch, plain]);
    expect(Array.isArray(prepared.instances)).toBe(false);
    batch.visible = false;
    const selected = selectVisibleInstances(prepared, [batch, plain]);
    expect(Array.isArray(selected.instances)).toBe(true);
    expect(selected.instances).toHaveLength(1);
  });
});

describe('mesh visibility in the renderers', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['webgpu', 'webgl'] as const)('%s toggles visibility without preparing mesh data again', async backend => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Pass = backend === 'webgpu' ? WGPURayTracePass : WebGLRayTracePass;
    const full = vi.spyOn(Pass.prototype as never, '_updateMeshData' as never);
    const membership = vi.spyOn(Pass.prototype as never, '_updateMeshMembership' as never);
    let canvas: HTMLCanvasElement, settle: () => void, lose: (() => void) | undefined;
    if (backend === 'webgpu') { const gpu = installFakeGPU(); canvas = gpu.canvas; settle = () => gpu.settle(); lose = gpu.loseDevice; }
    else { installFakeDocument(); const gl = installFakeWebGL(); canvas = gl.canvas; settle = () => gl.settle(); }
    const engine = new Engine({canvas, backend});
    const camera = new Camera({projection: 'perspective', aspect: 4 / 3, fov: 50});
    camera.position = [3, 2, 4]; camera.lookAt([0, 0, 0]);
    const spot = new SpotLight({intensity: 50, radius: 0, innerAngle: 25, outerAngle: 35});
    spot.position = [0, 3, 0]; spot.lookAt([0, 0, 0]);
    const sphere = new Mesh(createSphereGeometry(8, 6), emissive()), floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial());
    engine.camera = camera;
    engine.scene = {meshes: [floor, sphere], lights: [spot]};
    await engine.init();
    const loop = new RenderLoop(engine, {final: {maxSamples: 2}, preview: false});
    const run = async () => { for (let frame = 0; frame < 40; frame++) { if (loop.tick() === 'finished' && frame) break; settle(); await macrotask(); } };
    await run();
    expect(loop.status).toBe('finished');
    const prepared = full.mock.calls.length;
    sphere.visible = false;
    await run();
    sphere.visible = true;
    await run();
    expect(loop.status).toBe('finished');
    expect(full.mock.calls.length).toBe(prepared);
    expect(membership.mock.calls.length).toBeGreaterThanOrEqual(2);
    loop.dispose(); engine.dispose();
    lose?.(); await macrotask();
  });
});
