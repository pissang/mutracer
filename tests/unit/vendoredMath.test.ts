import { describe, expect, it } from 'vitest';
import { mat3 as reference3, mat4 as reference4, vec2 as reference2, vec3 as referenceVector3 } from 'gl-matrix';
import { mat3, mat4, vec2, vec3 } from '../../src/math.js';

// Compare the retained API against the independent, unmodified upstream package.
// Function tables also exercise output aliasing and both ordinary/typed storage.
type Operation = (...args: any[]) => any;
const groups = [
  { actual: mat3, reference: reference3, size: 9, cases: {
    fromMat4: () => [Array.from({ length: 16 }, (_, i) => i * .125)],
    normalFromMat4: () => [[2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1]]
  } },
  { actual: mat4, reference: reference4, size: 16, cases: {
    copy: () => [Array.from({ length: 16 }, (_, i) => i * .125)],
    invert: () => [[2, 0, 0, 0, .3, 3, 0, 0, 0, .2, 4, 0, 1, 2, 3, 1]],
    multiply: () => [Array.from(reference4.fromTranslation(reference4.create(), [1, 2, 3])), Array.from(reference4.fromScaling(reference4.create(), [2, 3, 4]))],
    mul: () => [Array.from(reference4.create()), Array.from(reference4.create())],
    scale: () => [Array.from(reference4.create()), [2, -3, .25]],
    rotateZ: () => [Array.from(reference4.create()), .37],
    fromScaling: () => [[2, -3, .25]],
    translate: () => [Array.from(reference4.create()), [1.25, -3, .5]],
    lookAt: () => [[1, 2, 3], [0, 0, 0], [0, 1, 0]],
    targetTo: () => [[1, 2, 3], [0, 0, 0], [0, 1, 0]],
    perspective: () => [.7, 1.5, .1, 100],
    ortho: () => [-2, 2, -3, 3, .1, 100],
    getScaling: () => [[2, 0, 0, 0, .3, 3, 0, 0, 0, .2, 4, 0, 1, 2, 3, 1]]
  } },
  { actual: vec2, reference: reference2, size: 2, cases: {
    copy: () => [[1.5, -2.25]], set: () => [1.5, -2.25],
    max: () => [[1.5, -2.25], [-3, 4]], min: () => [[1.5, -2.25], [-3, 4]],
    normalize: () => [[1.5, -2.25]], scale: () => [[1.5, -2.25], .7],
    sub: () => [[1.5, -2.25], [-3, 4]]
  } },
  { actual: vec3, reference: referenceVector3, size: 3, cases: {
    copy: () => [[1.5, -2.25, .7]], set: () => [1.5, -2.25, .7],
    cross: () => [[1.5, -2.25, .7], [-3, 4, .2]],
    lerp: () => [[1.5, -2.25, .7], [-3, 4, .2], .37],
    max: () => [[1.5, -2.25, .7], [-3, 4, .2]], min: () => [[1.5, -2.25, .7], [-3, 4, .2]],
    normalize: () => [[1.5, -2.25, .7]], scale: () => [[1.5, -2.25, .7], .7],
    scaleAndAdd: () => [[1.5, -2.25, .7], [-3, 4, .2], .7],
    sub: () => [[1.5, -2.25, .7], [-3, 4, .2]],
    transformMat3: () => [[1.5, -2.25, .7], Array.from(reference3.create())],
    transformMat4: () => [[1.5, -2.25, .7], Array.from(reference4.fromTranslation(reference4.create(), [1, 2, 3]))]
  } }
];

describe('vendored gl-matrix behavior', () => {
  for (const [index, group] of groups.entries()) {
    it(`matches upstream matrix/vector operations and storage (${index})`, () => {
      for (const storage of ['float32', 'float64', 'array']) for (const [name, parameters] of Object.entries(group.cases)) {
        const make = () => storage === 'float32' ? new Float32Array(group.size) : storage === 'float64' ? new Float64Array(group.size) : new Array(group.size).fill(0);
        const actual = make(), expected = make();
        const a = (group.actual as Record<string, Operation>)[name](actual, ...parameters());
        const b = (group.reference as unknown as Record<string, Operation>)[name](expected, ...parameters());
        expect(actual, `${index}/${name}/${storage}`).toStrictEqual(expected);
        expect(a === actual).toBe(b === expected);
      }
      expect((group.actual.create() as Float32Array)).toStrictEqual(group.reference.create());
    });
  }
  it('preserves in-place operations, singular matrices and projection limits', () => {
    for (const operation of ['invert', 'rotateZ', 'translate', 'scale', 'multiply']) {
      const a = reference4.fromTranslation(reference4.create(), [1, 2, 3]);
      const b = new Float32Array(a);
      const extra = operation === 'rotateZ' ? [.3] : operation === 'invert' ? [] : operation === 'multiply' ? [reference4.create()] : [[2, 3, 4]];
      (mat4 as Record<string, Operation>)[operation](a, a, ...extra);
      (reference4 as unknown as Record<string, Operation>)[operation](b, b, ...extra);
      expect(a).toStrictEqual(b);
    }
    expect(mat4.invert(new Float32Array(16), new Float32Array(16))).toBeNull();
    expect(mat3.normalFromMat4(new Float32Array(9), new Float32Array(16))).toBeNull();
    for (const far of [Infinity, null]) {
      expect(mat4.perspective(new Float32Array(16), .7, 1.5, .1, far)).toStrictEqual((reference4.perspective as Operation)(reference4.create(), .7, 1.5, .1, far));
    }
    for (const v of [[0, 0, 0], [-0, 0, -0], [1e-30, -1e-30, 0]]) {
      expect(vec3.normalize(new Float32Array(3), v)).toStrictEqual(referenceVector3.normalize(referenceVector3.create(), v));
    }
  });
  it('preserves creators, scalar results and strided callbacks', () => {
    for (const matrix of [Array.from(reference4.create()), Array.from({length: 16}, (_, i) => Math.sin(i * 3.7)), new Array(16).fill(0)]) {
      expect(mat4.determinant(matrix)).toBe(reference4.determinant(matrix));
    }
    const v = [1.25, -3, .5];
    expect(vec3.fromValues(...v as [number, number, number])).toStrictEqual(referenceVector3.fromValues(...v as [number, number, number]));
    expect(vec3.clone(v)).toStrictEqual(referenceVector3.clone(v));
    expect(vec3.length(v)).toBe(referenceVector3.length(v));
    expect(vec3.dist(v, [3, 2, 1])).toBe(referenceVector3.dist(v, [3, 2, 1]));
    expect(vec2.len(v)).toBe(reference2.len(v));
    for (const count of [undefined, 0, 1, 2]) {
      const a = new Float32Array([99, 1, 2, 3, 77, 4, 5, 6, 88]), b = new Float32Array(a);
      const matrix = new Float32Array(reference4.fromTranslation(reference4.create(), [1, 2, 3]));
      vec3.forEach(a, 4, 1, count, vec3.transformMat4, matrix);
      referenceVector3.forEach(b, 4, 1, count, referenceVector3.transformMat4, matrix);
      expect(a).toStrictEqual(b);
    }
  });
});
