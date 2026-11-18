import {describe, expect, it} from 'vitest';
import {parseMaterialX} from '../../src/materialx';

const document = `<materialx version="1.39">
  <open_pbr_surface name="plainShader">
    <input name="base_color" type="color3" value="1,0.5,0.25"/>
  </open_pbr_surface>
  <nodegraph name="library">
    <image name="image" type="color3">
      <input name="file" type="filename" fileprefix="textures/" value="albedo.png"/>
    </image>
    <open_pbr_surface name="imageShader"><input name="base_color" type="color3" nodename="image"/></open_pbr_surface>
    <output name="surface" type="surfaceshader" nodename="imageShader"/>
  </nodegraph>
  <surfacematerial name="plain"><input name="surfaceshader" nodename="plainShader"/></surfacematerial>
  <surfacematerial name="textured"><input name="surfaceshader" nodegraph="library" output="surface"/></surfacematerial>
</materialx>`;

describe('MaterialX document parsing', () => {
  it('defaults to the first material and folds its literal inputs', () => {
    const material = parseMaterialX(document);
    expect(material.name).toBe('plain');
    expect(material.values.baseColor).toEqual([1, 0.5, 0.25]);
    expect(material.graph).toBeUndefined();
    expect(material.images.size).toBe(0);
  });

  it('resolves a named material and reports filenames by graph node ID', () => {
    const material = parseMaterialX(document, 'textured');
    const node = material.graph?.terminal.baseColor?.node;
    expect(node).toBe('library/image');
    expect(material.images.get(node!)).toMatchObject({file: 'textures/albedo.png', srgb: true});
    expect(material.coverage).toBe('complete');
  });

  it('reports a missing material or surface shader', () => {
    expect(() => parseMaterialX(document, '')).toThrow(/No surface material/);
    expect(() => parseMaterialX(document, 'other')).toThrow(/other/);
    expect(() => parseMaterialX('<materialx><surfacematerial name="empty"/></materialx>')).toThrow(/No surface shader/);
  });
});
