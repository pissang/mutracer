import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseMaterialXGraph } from '../src/engine/materialxGraph';
import { readMaterialXPackage } from '../src/engine/materialxFiles';
import { findMaterialXHeights } from '../src/engine/materialxHeights';

const doc = (nodes = '', inputs = '', displacement = '') => `<materialx version="1.39">${nodes}<standard_surface name="S" type="surfaceshader">${inputs}</standard_surface><surfacematerial name="Rock"><input name="surfaceshader" nodename="S"/>${displacement}</surfacematerial></materialx>`;
async function packageWith(text: string, names: string[], zipped = true) {
  const entries = { 'Rock/Rock.mtlx': strToU8(text), ...Object.fromEntries(names.map(name => [name, new Uint8Array([1, 2, 3])])) };
  return readMaterialXPackage(zipped
    ? [{ file: new File([zipSync(entries)], 'Rock.zip'), path: 'Rock.zip' }]
    : Object.entries(entries).map(([path, data]) => ({ file: new File([data], path.split('/').pop()!), path })));
}

describe('optional MaterialX package heights', () => {
  it.each([true, false])('finds supported height filenames in %s zip packages without enabling displacement', async zipped => {
    const text = doc();
    const pkg = await packageWith(text, ['Rock/textures/Rock_height.png', 'Rock/textures/RockDisplacement.webp',
      'Rock/textures/Rock_disp_2k.JPG', 'Rock/textures/Rock_normal.png', 'Rock/textures/heightfield.png',
      'Rock/textures/Rock_height.exr', 'Other/Other_height.png'], zipped);
    const material = parseMaterialXGraph(text), heights = findMaterialXHeights(material, pkg);
    expect(heights.map(height => height.name).sort()).toEqual([
      'textures/Rock_disp_2k.JPG', 'textures/Rock_height.png', 'textures/RockDisplacement.webp'
    ].sort());
    expect(await heights[0].file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(heights[0].transform).toMatchObject({ uvScale: [1, 1], flipY: true, colorSpace: 'linear' });
    expect(material.displacement).toBeUndefined();
  });

  it('does not replace authored displacement, including unsupported connections', async () => {
    const text = doc('', '', '<input name="displacementshader" nodename="Missing"/>');
    const pkg = await packageWith(text, ['Rock/Rock_height.png']);
    expect(findMaterialXHeights(parseMaterialXGraph(text), pkg)).toEqual([]);
  });

  it('accepts an empty displacement port and retains choices when no image node uses the files', async () => {
    const text = doc('', '', '<input name="displacementshader" type="displacementshader"/>');
    const pkg = await packageWith(text, ['Rock/Height.png']);
    expect(findMaterialXHeights(parseMaterialXGraph(text), pkg).map(height => height.name)).toEqual(['Height.png']);
  });

  it('finds matching textures outside the document folder', async () => {
    const text = doc();
    const pkg = await packageWith(text, ['textures/Rock_height.png', 'textures/Wood_height.png']);
    expect(findMaterialXHeights(parseMaterialXGraph(text), pkg).map(height => height.name)).toEqual(['textures/Rock_height.png']);
  });

  it('uses the surface image UV scale, offset, channel and wrapping', async () => {
    const text = doc(`<texcoord name="uv" type="vector2"><input name="index" type="integer" value="1"/></texcoord>
      <multiply name="repeat" type="vector2"><input name="in1" type="vector2" nodename="uv"/><input name="in2" type="vector2" value="2,3"/></multiply>
      <add name="offset" type="vector2"><input name="in1" type="vector2" nodename="repeat"/><input name="in2" type="vector2" value="0.1,0.2"/></add>
      <image name="color" type="color3"><input name="file" type="filename" value="textures/Rock_basecolor.png"/><input name="texcoord" type="vector2" nodename="offset"/><input name="uaddressmode" type="string" value="mirror"/><input name="vaddressmode" type="string" value="clamp"/></image>`,
    '<input name="base_color" type="color3" nodename="color"/>');
    const pkg = await packageWith(text, ['Rock/textures/Rock_height.png']);
    expect(findMaterialXHeights(parseMaterialXGraph(text), pkg)[0].transform).toEqual({
      uvScale: [2, 3], uvOffset: [.1, .2], uvChannel: 1, wrapS: 'mirrored-repeat', wrapT: 'clamp-to-edge', flipY: true, colorSpace: 'linear'
    });
  });

  it('does not offer another material’s named heights from a shared texture folder', async () => {
    const text = doc();
    const pkg = await readMaterialXPackage([{ file: new File([zipSync({
      'Rock.mtlx': strToU8(text), 'Wood.mtlx': strToU8(doc()),
      'textures/Rock_height.png': new Uint8Array([1]), 'textures/Wood_height.png': new Uint8Array([2])
    })], 'materials.zip'), path: 'materials.zip' }]);
    expect(findMaterialXHeights(parseMaterialXGraph(text), pkg).map(height => height.name)).toEqual(['textures/Rock_height.png']);
  });
});
