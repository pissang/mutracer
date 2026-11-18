import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fromTHREEScene } from '@meimu/mutracer/three';
import { loadModelLighting, parsePFM, reprojectEnvironment } from '../src/engine/modelLighting';
import { groundModel } from '../src/engine/modelGrounding';

function pfm(width: number, height: number, values: number[], littleEndian = true) {
  const header = new TextEncoder().encode(`PF\n# image\n${width} ${height}\n${littleEndian ? -1 : 1}\n`);
  const bytes = new Uint8Array(header.length + values.length * 4);
  bytes.set(header);
  const view = new DataView(bytes.buffer, header.length);
  values.forEach((value, i) => view.setFloat32(i * 4, value, littleEndian));
  return bytes.buffer;
}

const infinite = (source?: string) => ({ pbrt: { light_sources: [
  { pbrt: 'infinite', gltf: 'metadata_only', ...(source ? { source } : { radiance_rgb: [0.3, 0.2, 0.1] }) }
] } });

describe('model lighting', () => {
  it('does not offer scene lighting for geometry or decorative emissive materials alone', async () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    expect((await loadModelLighting(root, {}, vi.fn())).available).toBe(false);
    material.emissive.set(0xff9900);
    expect((await loadModelLighting(root, {}, vi.fn())).available).toBe(false);
    expect(material.emissive.getHex()).toBe(0xff9900);
    expect(material.emissiveIntensity).toBe(1);
  });

  it('uses authored PBRT emission even without metadata-only lights', async () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ emissive: 0xffffff })));
    const lighting = await loadModelLighting(root, { pbrt: { render: { integrator: 'path' } } }, vi.fn());
    expect(lighting).toMatchObject({ available: true, useByDefault: true, environment: null });
    expect(root.children).toHaveLength(1);
  });

  it('ignores hidden, black and zero-power lights', async () => {
    const root = new THREE.Group();
    const hidden = new THREE.Group().add(new THREE.PointLight());
    hidden.visible = false;
    root.add(hidden, new THREE.PointLight(0xffffff, 0), new THREE.PointLight(0x000000, 1));
    expect((await loadModelLighting(root, {}, vi.fn())).available).toBe(false);
    hidden.visible = true;
    expect((await loadModelLighting(root, {}, vi.fn())).available).toBe(true);
  });

  it('retains explicitly authored emissive area lighting without adding duplicate lights', async () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ emissive: 0xffffff })));
    const lighting = await loadModelLighting(root, { pbrt: { light_sources: [
      { pbrt: 'diffuse area light', gltf: 'emissive mesh + KHR_materials_emissive_strength', radiance_rgb: [10, 10, 10] }
    ] } }, vi.fn());
    expect(lighting.available).toBe(true);
    expect(root.children).toHaveLength(1);
  });

  it('does not offer scene lighting for a black environment', async () => {
    const lighting = await loadModelLighting(new THREE.Group(), { pbrt: { light_sources: [
      { pbrt: 'infinite', gltf: 'metadata_only', radiance_rgb: [0, 0, 0] }
    ] } }, vi.fn());
    expect(lighting.available).toBe(false);
  });

  it.each([true, false])('decodes PFM endianness and reverses bottom-up rows (%s)', (littleEndian) => {
    const image = parsePFM(pfm(1, 2, [1, 2, 3, 4, 5, 6], littleEndian));
    expect(image).toMatchObject({ width: 1, height: 2 });
    expect([...image.data]).toEqual([4, 5, 6, 1, 1, 2, 3, 1]);
  });

  it('rejects incomplete PFM data', () => {
    expect(() => parsePFM(pfm(2, 2, [1, 2, 3]))).toThrow('Invalid PFM');
  });

  it('imports transformed distant lights in the same grounded space as the model', async () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)));
    const metadata = { pbrt: { light_sources: [{ pbrt: 'distant', gltf: 'metadata_only', radiance_rgb: [8, 4, 2],
      from: [1, 0, 0], to: [0, 0, 0], pbrt_transform: new THREE.Matrix4().makeRotationZ(Math.PI / 2).toArray() }] } };
    const lighting = await loadModelLighting(root, metadata, vi.fn());
    expect(lighting.available).toBe(true);
    groundModel(root);
    const scene = new THREE.Scene(); scene.add(root);
    const converted = fromTHREEScene(scene);
    expect(converted.lights).toHaveLength(1);
    expect(converted.lights[0]).toMatchObject({ type: 'DirectionalLight', color: [8, 4, 2], intensity: 1 });
    const light = root.children.find((object) => (object as THREE.DirectionalLight).isDirectionalLight) as THREE.DirectionalLight;
    const incoming = light.target.getWorldPosition(new THREE.Vector3()).sub(light.getWorldPosition(new THREE.Vector3())).normalize();
    expect(incoming.x).toBeCloseTo(0); expect(incoming.y).toBeCloseTo(-1);
  });

  it('keeps standard lights and emissive meshes without duplicating area-light metadata', async () => {
    const root = new THREE.Group(); root.add(new THREE.PointLight());
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ emissive: 0xffffff })));
    const lighting = await loadModelLighting(root, { pbrt: { light_sources: [
      { pbrt: 'diffuse area light', gltf: 'emissive mesh + KHR_materials_emissive_strength', radiance_rgb: [10, 10, 10] }
    ] } }, vi.fn());
    expect(lighting.available).toBe(true); expect(root.children).toHaveLength(2);
  });

  it('loads a PFM infinite light and keeps the source transform', async () => {
    // An image that varies with latitude makes a 90-degree tilt observable.
    const bytes = pfm(4, 2, [...Array(4).fill([1, 1, 1]).flat(), ...Array(4).fill([3, 3, 3]).flat()]);
    const resource = vi.fn().mockResolvedValue(bytes);
    const root = new THREE.Group();
    const lighting = await loadModelLighting(root, infinite('textures/sky.pfm'), resource);
    expect(resource).toHaveBeenCalledWith('../source/textures/sky.pfm');
    expect(lighting.available).toBe(true); expect(lighting.environment?.width).toBe(4);
    expect(lighting.environment!.data.every(Number.isFinite)).toBe(true);
    const source = parsePFM(bytes);
    const aligned = reprojectEnvironment(source, new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    expect(aligned.data[0]).toBeGreaterThan(aligned.data[4 * 4]);
  });

  it('preserves constant radiance and reports missing maps without rejecting the model', async () => {
    const light = await loadModelLighting(new THREE.Group(), infinite(), vi.fn());
    expect(light.environment?.data).toEqual(new Float32Array([0.3, 0.2, 0.1, 1]));
    const missing = await loadModelLighting(new THREE.Group(), infinite('textures/missing.pfm'), vi.fn().mockRejectedValue(new Error('404')));
    expect(missing.available).toBe(false); expect(missing.warnings[0]).toContain('missing.pfm');
  });

  it('reprojects equal-area maps with finite directions and the source orientation', () => {
    const width = 64, height = 64, data = new Float32Array(width * height * 4);
    // Independently build an equal-area map whose radiance is the sphere's z.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = Math.abs(2 * (x + 0.5) / width - 1), b = Math.abs(2 * (y + 0.5) / height - 1);
      const d = 1 - a - b, r = 1 - Math.abs(d), z = Math.sign(d) * (1 - r * r);
      data.set([z + 1, z + 1, z + 1, 1], (y * width + x) * 4);
    }
    const projected = reprojectEnvironment({ width, height, data }, new THREE.Matrix4().makeRotationX(-Math.PI / 2), true);
    expect(projected.data.every(Number.isFinite)).toBe(true);
    expect(projected.data[0]).toBeGreaterThan(1.9);
    expect(projected.data[projected.data.length - 4]).toBeLessThan(0.1);
  });
});
