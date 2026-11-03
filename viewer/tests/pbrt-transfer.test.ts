import { describe, expect, it } from 'vitest';
import { buildScene } from '../../tools/pbrt/scene';
import { compactScene } from '../../tools/pbrt/transfer';
import { convert } from '../../tools/pbrt/convert';
import { prefetchResources } from '../../tools/pbrt/prefetch';
import * as THREE from 'three';
describe('PBRT worker payload and prefetch', () => {
  it('transfers shared geometry arrays once and converts the received scene', async () => {
    const resolver={read:async()=>new TextEncoder().encode('WorldBegin Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "normal N" [0 0 1 0 0 1 0 0 1] "point2 uv" [0 0 1 0 0 1] "integer indices" [0 1 2]').buffer};
    const scene=await buildScene('main.pbrt',resolver),transfer=compactScene(scene);
    expect(transfer).toHaveLength(4);expect(compactScene(scene)).toEqual(transfer);
    const received=structuredClone(scene,{transfer});
    expect(transfer.every(b=>b.byteLength===0)).toBe(true);
    expect(received.shapes[0].params.P.values).toBeInstanceOf(Float32Array);
    expect(received.shapes[0].params.indices.values).toBeInstanceOf(Uint32Array);
    const result=await convert(received,resolver);
    const geometry=(result.root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh).geometry;
    expect(geometry.attributes.position.count).toBe(3);expect(geometry.index!.count).toBe(3);
  });
  it('keeps invalid indices available for geometry validation rather than truncating them', async () => {
    const resolver={read:async()=>new TextEncoder().encode('WorldBegin Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "integer indices" [0 -1 2]').buffer};
    const scene=await buildScene('main.pbrt',resolver);compactScene(scene);
    await expect(convert(scene,resolver)).rejects.toThrow('invalid triangle indices');
  });
  it('fetches six assets concurrently, once each, without refetching text', async () => {
    let active=0,peak=0;const seen:string[]=[];
    const resources=[{path:'main',kind:'text' as const},...Array.from({length:20},(_,i)=>({path:String(i),kind:'geometry' as const}))];
    await prefetchResources([...resources,resources[1]],{async read(path) {active++;peak=Math.max(peak,active);seen.push(path);await new Promise(resolve=>setTimeout(resolve,1));active--;return new ArrayBuffer(0);}});
    expect(peak).toBe(6);expect(new Set(seen).size).toBe(20);expect(seen).toHaveLength(20);
  });
});
