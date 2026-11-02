import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { subdivideLoop } from '../../tools/pbrt/subdivision';
describe('PBRT Loop subdivision', () => {
  it('applies the boundary limit rule without changing the input mesh', () => {
    const input = new THREE.BufferGeometry(); input.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3)); input.setIndex([0,1,2]);
    const result = subdivideLoop(input,0); expect(result.attributes.position.getX(0)).toBeCloseTo(.2); expect(result.attributes.position.getY(0)).toBeCloseTo(.2); expect(input.attributes.position.getX(0)).toBe(0);
  });
  it('retains closed topology, symmetry and finite smooth normals', () => {
    const source = new THREE.TetrahedronGeometry(1), merged = new THREE.BufferGeometry();
    merged.setAttribute('position',new THREE.Float32BufferAttribute([1,1,1,-1,-1,1,-1,1,-1,1,-1,-1],3)); merged.setIndex([0,2,1,0,1,3,0,3,2,1,2,3]);
    const result = subdivideLoop(merged,2); expect(result.index!.count / 3).toBe(4 * 16); expect(result.attributes.position.count).toBe(34);
    const bounds = new THREE.Box3().setFromBufferAttribute(result.attributes.position as THREE.BufferAttribute); expect(bounds.getCenter(new THREE.Vector3()).length()).toBeLessThan(1e-7);
    for(const value of result.attributes.normal.array) expect(Number.isFinite(value)).toBe(true); source.dispose();
  });
  it('matches PBRT last-face selection at a welded multi-fan boundary', () => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,-1,0,0,0,-1,0],3)); g.setIndex([0,1,2,0,3,4]);
    const result = subdivideLoop(g,0); expect(result.attributes.position.getX(0)).toBeCloseTo(-.2); expect(result.attributes.position.getY(0)).toBeCloseTo(-.2);
  });
  it('bounds subdivision allocations', () => { expect(() => subdivideLoop(new THREE.BufferGeometry(),9)).toThrow('levels'); });
});
