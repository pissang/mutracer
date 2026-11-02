import { describe, expect, it } from 'vitest';
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
  it('scales before invert and uses the pinned default encoding for JPEG', async () => {
    const { textures, owner } = await setup('WorldBegin Texture "t" "spectrum" "imagemap" "string filename" "x.jpg" "float scale" 2 "bool invert" true Material "diffuse" "texture reflectance" "t" Shape "sphere"');
    const map = (await textures.value(owner.params,'reflectance',[0,0,0],owner)).map!;
    expect(Array.from(map.image.data).slice(0,3)).toEqual(expect.arrayContaining([expect.closeTo(.6),expect.closeTo(.2),0]));
  });
  it('uses nonopaque alpha for float images and opaque RGB mean otherwise', async () => {
    for (const alpha of [.25,1]) {
      const { textures, owner } = await setup('WorldBegin Texture "t" "float" "imagemap" "string filename" "x.jpg" Material "diffuse" "texture roughness" "t" Shape "sphere"', async()=>({width:1,height:1,data:new Float32Array([.2,.4,.6,alpha])}));
      const map = (await textures.value(owner.params,'roughness',[0,0,0],owner)).map!;
      expect(map.image.data[0]).toBeCloseTo(alpha < 1 ? alpha : .4); expect(map.image.data[3]).toBe(1);
    }
  });
});
