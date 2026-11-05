import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {mediumBoundary} from '../../tools/pbrt/mediumBoundary';
import {buildScene} from '../../tools/pbrt/scene';
import {convert} from '../../tools/pbrt/convert';

const load = async (text: string) => {
  const resolver = {async read() { return new TextEncoder().encode(text).buffer; }};
  const scene = await buildScene('medium.pbrt', resolver);
  return {scene, ...await convert(scene, resolver)};
};
const medium = 'MakeNamedMedium "m" "string type" "homogeneous" "rgb sigma_a" [.2 .2 .2] "rgb sigma_s" [0 0 0]';
const camera = 'LookAt 0 0 4 0 0 0 0 1 0 Camera "perspective"';
const boundary = 'Material "dielectric" Shape "sphere"';

describe('medium boundary diagnostics', () => {
  it('welds split normal vertices and ignores collapsed pole triangles', () => {
    expect(mediumBoundary(new THREE.BoxGeometry())).toEqual({closed: true, oriented: true});
    expect(mediumBoundary(new THREE.SphereGeometry(1, 16, 8))).toEqual({closed: true, oriented: true});
  });
  it('detects an opening and inconsistent winding without changing the geometry', () => {
    const g = new THREE.BoxGeometry(), indices = Array.from(g.index!.array);
    g.setIndex(indices.slice(3));
    expect(mediumBoundary(g).closed).toBe(false);
    [indices[0], indices[1]] = [indices[1], indices[0]]; g.setIndex(indices);
    expect(mediumBoundary(g)).toEqual({closed: true, oriented: false});
    expect(Array.from(g.index!.array)).toEqual(indices);
  });
  it('warns on open medium boundaries and excludes indirect-light comparisons', async () => {
    const {scene, root} = await load(`WorldBegin ${medium} MediumInterface "m" "" Material "dielectric"
      Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "integer indices" [0 1 2]`);
    expect(scene.warnings).toContainEqual(expect.objectContaining({code: 'medium-topology', statement: 'Shape', file: 'medium.pbrt'}));
    expect(root.userData.pbrtComparable).toBe(false);
  });
  it('reports inconsistent authored boundaries even when face-forwarding can repair their winding', async () => {
    const g = new THREE.BoxGeometry(), indices = Array.from(g.index!.array);
    [indices[0], indices[1]] = [indices[1], indices[0]];
    const {scene, root} = await load(`WorldBegin ${medium} MediumInterface "m" "" Material "dielectric"
      Shape "trianglemesh" "point3 P" [${Array.from(g.attributes.position.array).join(' ')}]
      "normal N" [${Array.from(g.attributes.normal.array).join(' ')}] "integer indices" [${indices.join(' ')}]`);
    expect(scene.warnings.some(w => w.code === 'medium-orientation')).toBe(true);
    expect(root.userData.pbrtComparable).toBe(false);
  });
  it('distinguishes a contradictory exterior medium from a consistent reversed boundary', async () => {
    for (const reverse of [false, true]) {
      const {scene, root} = await load(`${camera} WorldBegin ${medium} MediumInterface "" "m" ${reverse ? 'ReverseOrientation' : ''} ${boundary}`);
      expect(scene.warnings.some(w => w.code === 'medium-camera')).toBe(!reverse);
      expect(root.userData.pbrtComparable).toBe(reverse);
      const mesh = root.children.find(o => o instanceof THREE.Mesh) as THREE.Mesh;
      expect((mesh.material as THREE.Material).userData.pbrtComparable).toBe(reverse);
    }
  });
  it('detects a camera at the center of a medium with an empty initial state', async () => {
    const {scene, root} = await load(`Camera "perspective" WorldBegin ${medium} MediumInterface "m" "" ${boundary}`);
    expect(scene.warnings.some(w => w.code === 'medium-camera')).toBe(true);
    expect(root.userData.pbrtComparable).toBe(false);
  });
  it('checks transformed instances in their world orientation', async () => {
    for (const reverse of [false, true]) {
      const {scene} = await load(`${camera} WorldBegin ${medium}
        ObjectBegin "gem" MediumInterface "" "m" ${reverse ? 'ReverseOrientation' : ''} ${boundary} ObjectEnd
        Scale -1 1 1 Translate 2 0 0 ObjectInstance "gem"`);
      expect(scene.warnings.some(w => w.code === 'medium-camera')).toBe(!reverse);
    }
  });
});
