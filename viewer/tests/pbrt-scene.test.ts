import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { buildScene } from '../../tools/pbrt/scene';
const build = (text: string, extra: Record<string, string> = {}) => buildScene('scene/main.pbrt', { async read(path) { return new TextEncoder().encode(({ 'scene/main.pbrt': text, ...extra })[path]).buffer; } });
const at = (values: number[]) => new Vector3().applyMatrix4(new Matrix4().fromArray(values)).toArray();
describe('PBRT scene state', () => {
  it('restores transforms, material and reverse state at AttributeEnd', async () => {
    const scene = await build('WorldBegin Translate 1 2 3 AttributeBegin Scale 2 2 2 Material "conductor" ReverseOrientation Shape "sphere" AttributeEnd Shape "sphere"');
    expect(scene.shapes.map(s => s.material.type)).toEqual(['conductor', 'diffuse']);
    expect(scene.shapes.map(s => s.reverse)).toEqual([true, false]);
    expect(at(scene.shapes[1].transform)).toEqual([1, 2, 3]); expect(scene.shapes[0].transform[0]).toBe(2);
  });
  it('isolates Import state while Include changes the parent state', async () => {
    const scene = await build('WorldBegin Include "a.pbrt" Import "b.pbrt" Shape "sphere"', { 'scene/a.pbrt': 'Translate 1 0 0', 'scene/b.pbrt': 'Translate 0 2 0 Shape "sphere"' });
    expect(scene.shapes.map(s => at(s.transform))).toEqual([[1, 2, 0], [1, 0, 0]]);
  });
  it('keeps named material, texture and medium definitions, and instances', async () => {
    const scene = await build('WorldBegin MakeNamedMaterial "m" "string type" "dielectric" Texture "t" "spectrum" "constant" "rgb value" [.1 .2 .3] MakeNamedMedium "fog" "string type" "homogeneous" NamedMaterial "m" MediumInterface "fog" "" ObjectBegin "ball" Shape "sphere" ObjectEnd Translate 1 0 0 ObjectInstance "ball"');
    expect(scene.shapes).toHaveLength(0); expect(scene.objects.ball[0].material.type).toBe('dielectric');
    expect(scene.objects.ball[0].inside).toBe('fog'); expect(scene.textures.t.type).toBe('constant');
    expect(at(scene.instances[0].transform)).toEqual([1, 0, 0]);
  });
  it('resolves named materials defined after the shapes that use them', async () => {
    const scene = await build('WorldBegin NamedMaterial "later" Shape "sphere" MakeNamedMaterial "later" "string type" "dielectric"');
    expect(scene.shapes[0].material.type).toBe('dielectric');
  });
  it('uses the starting motion transform and named coordinates', async () => {
    const scene = await build('WorldBegin Translate 1 0 0 CoordinateSystem "a" ActiveTransform EndTime Translate 99 0 0 ActiveTransform All Translate 0 2 0 CoordSysTransform "a" Shape "sphere"');
    expect(at(scene.shapes[0].transform)).toEqual([1, 0, 0]); expect(scene.warnings).toHaveLength(1); expect(scene.warnings[0].count).toBe(2);
  });
  it('captures inverse LookAt for the camera then resets the world transform', async () => {
    const scene = await build('LookAt 1 2 3 1 2 4 0 1 0 Camera "perspective" WorldBegin Shape "sphere"');
    expect(at(scene.camera!.transform)).toEqual([1, 2, 3]); expect(at(scene.shapes[0].transform)).toEqual([0, 0, 0]);
  });
  it('applies Attribute defaults and permits a local override', async () => {
    const scene = await build('WorldBegin Attribute "shape" "float alpha" .5 Shape "sphere" Shape "sphere" "float alpha" 1');
    expect(scene.shapes.map(s => s.params.alpha.values[0])).toEqual([.5, 1]);
  });
  it.each(['WorldBegin AttributeEnd', 'WorldBegin AttributeBegin', 'WorldBegin NamedMaterial "missing" Shape "sphere"', 'WorldBegin ObjectInstance "missing"'])('reports state errors at the source location', async (text) => {
    await expect(build(text)).rejects.toThrow(/scene\/main.pbrt:1:/);
  });
});
