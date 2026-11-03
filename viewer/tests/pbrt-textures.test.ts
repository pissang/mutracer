import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildScene } from '../../tools/pbrt/scene';
import { Textures } from '../../tools/pbrt/textures';
const image = async () => ({ width: 1, height: 1, data: new Float32Array([.2,.4,.6,1]) });
async function setup(text: string, decode = image) {
  const resolver = { async read(path: string) { return new TextEncoder().encode(path.endsWith('.pbrt') ? text : '').buffer; } };
  const scene = await buildScene('main.pbrt',resolver), textures = new Textures(scene,resolver,()=>{},decode);
  const owner = scene.shapes[0].material; return { textures, owner, scene };
}
describe('PBRT image and texture parameter semantics', () => {
  it('keeps float and spectrum texture namespaces separate', async () => {
    const { textures, owner } = await setup('WorldBegin Texture "x" "spectrum" "constant" "rgb value" [.1 .2 .3] Texture "x" "float" "constant" "float value" .7 Material "diffuse" "texture reflectance" "x" "texture roughness" "x" Shape "sphere"');
    expect((await textures.value(owner.params,'reflectance',[0,0,0],owner)).color).toEqual([.1,.2,.3]);
    expect((await textures.value(owner.params,'roughness',[0,0,0],owner)).color).toEqual([.7,.7,.7]);
  });
  it('keeps byte RGB precision and factors scale without copying pixels', async () => {
    const { textures, owner } = await setup('WorldBegin Texture "base" "spectrum" "imagemap" "string filename" "x.png" Texture "scaled" "spectrum" "scale" "texture tex" "base" "float scale" .25 Material "diffuse" "texture reflectance" "base" "texture secondary" "scaled" Shape "sphere"', async()=>({width:1,height:1,data:new Uint8Array([128,64,32,255])}));
    const base = await textures.value(owner.params,'reflectance',[0,0,0],owner), scaled = await textures.value(owner.params,'secondary',[0,0,0],owner);
    expect(base.map!.image.data).toBeInstanceOf(Uint8Array); expect(base.map!.colorSpace).toBe(THREE.SRGBColorSpace); expect(Array.from(base.map!.image.data)).toEqual([128,64,32,255]); expect(scaled.map).toBe(base.map); expect(scaled.color).toEqual([.25,.25,.25]);
  });
  it('scales before invert and uses the pinned default encoding for JPEG', async () => {
    const { textures, owner } = await setup('WorldBegin Texture "t" "spectrum" "imagemap" "string filename" "x.jpg" "float scale" 2 "bool invert" true Material "diffuse" "texture reflectance" "t" Shape "sphere"');
    const map = (await textures.value(owner.params,'reflectance',[0,0,0],owner)).map!;
    expect(Array.from(map.image.data).slice(0,3)).toEqual(expect.arrayContaining([expect.closeTo(.6),expect.closeTo(.2),0]));
  });
  it('bakes scaled forward UV slopes with the PBRT (s, 1-t) orientation', async () => {
    const { textures } = await setup('WorldBegin Shape "sphere"');
    const data = new Float32Array(8*8*4);
    for (let y=0;y<8;y++) for(let x=0;x<8;x++) data.set([x/8 + 2*y/8,0,0,1],(y*8+x)*4);
    const source = new THREE.DataTexture(data,8,8,THREE.RGBAFormat,THREE.FloatType);
    source.flipY = true; source.repeat.set(2,3); source.wrapS = source.wrapT = THREE.ClampToEdgeWrapping;
    const map = textures.bumpMap({ color: [.25,.25,.25], map: source })!;
    const offset = (3*8+3)*4, normal = Array.from(map.image.data.slice(offset,offset+3), v=>2*v-1);
    const length = Math.hypot(.5,1.5,1);
    [-.5/length,1.5/length,1/length].forEach((v,i)=>expect(normal[i]).toBeCloseTo(v,5));
    expect(textures.bumpMap({ color: [.25,.25,.25], map: source })).toBe(map);
    expect(map.flipY).toBe(true); expect(map.repeat.toArray()).toEqual([2,3]);
  });
  it('prepares nonsquare height maps with a reusable supported layout', async () => {
    const { textures, owner } = await setup('WorldBegin Shape "sphere"');
    const data = new Float32Array(2*3*4).fill(.5), source = new THREE.DataTexture(data,2,3,THREE.RGBAFormat,THREE.FloatType);
    source.flipY = true; source.repeat.set(2,3);
    const map = textures.heightMap(source,owner); expect(source.image.width).toBe(2); expect(source.image.height).toBe(3); expect(source.image.data).toBe(data); expect(map.image.width).toBe(4); expect(map.image.height).toBe(4); expect(map.image.data.every(v=>Math.abs(v-.5)<1e-6)).toBe(true); expect(map.flipY).toBe(true); expect(map.repeat.toArray()).toEqual([2,3]); expect(textures.heightMap(source,owner)).toBe(map);
  });
  it('uses nonopaque alpha for float images and opaque RGB mean otherwise', async () => {
    for (const alpha of [.25,1]) {
      const { textures, owner } = await setup('WorldBegin Texture "t" "float" "imagemap" "string filename" "x.jpg" Material "diffuse" "texture roughness" "t" Shape "sphere"', async()=>({width:1,height:1,data:new Float32Array([.2,.4,.6,alpha])}));
      const map = (await textures.value(owner.params,'roughness',[0,0,0],owner)).map!;
      expect(map.image.data[0]).toBeCloseTo(alpha < 1 ? alpha : .4); expect(map.image.data[3]).toBe(1);
    }
  });
});
