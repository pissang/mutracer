// Adapted from gl-matrix 3.4.4, https://github.com/toji/gl-matrix/tree/v3.4.4/src
// Copyright (c) 2015-2025 Brandon Jones and Colin MacKenzie IV, MIT.
// See LICENSES/GlMatrix-MIT.txt. Arithmetic/order retained; creators use Float32Array.
import {create} from './sceneVec3.js';
import type { MathArray, ReadonlyMathArray } from './types.js';

export function clone<T0 extends ReadonlyMathArray>(a: T0): Float32Array {
  var out = new Float32Array(3);
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function copy<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export const dist = distance;

export function distance<T0 extends ReadonlyMathArray, T1 extends ReadonlyMathArray>(a: T0, b: T1): number {
  var x = b[0] - a[0];
  var y = b[1] - a[1];
  var z = b[2] - a[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function fromValues(x: number, y: number, z: number): Float32Array {
  var out = new Float32Array(3);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function length<T0 extends ReadonlyMathArray>(a: T0): number {
  var x = a[0];
  var y = a[1];
  var z = a[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function lerp<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2, t: number): T0 {
  var ax = a[0];
  var ay = a[1];
  var az = a[2];
  out[0] = ax + t * (b[0] - ax);
  out[1] = ay + t * (b[1] - ay);
  out[2] = az + t * (b[2] - az);
  return out;
}

export function max<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  out[0] = Math.max(a[0], b[0]);
  out[1] = Math.max(a[1], b[1]);
  out[2] = Math.max(a[2], b[2]);
  return out;
}

export function min<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  out[2] = Math.min(a[2], b[2]);
  return out;
}

export const len = length;

export function scale<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1, b: number): T0 {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  out[2] = a[2] * b;
  return out;
}

export function scaleAndAdd<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2, scale: number): T0 {
  out[0] = a[0] + b[0] * scale;
  out[1] = a[1] + b[1] * scale;
  out[2] = a[2] + b[2] * scale;
  return out;
}

export function transformMat3<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, m: T2): T0 {
  var x = a[0],
    y = a[1],
    z = a[2];
  out[0] = x * m[0] + y * m[3] + z * m[6];
  out[1] = x * m[1] + y * m[4] + z * m[7];
  out[2] = x * m[2] + y * m[5] + z * m[8];
  return out;
}

export function transformMat4<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, m: T2): T0 {
  var x = a[0],
    y = a[1],
    z = a[2];
  var w = m[3] * x + m[7] * y + m[11] * z + m[15];
  w = w || 1.0;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

const forEachVector = create();
export function forEach<T extends MathArray, A = undefined>(a: T, stride: number | undefined, offset: number | undefined, count: number | undefined, fn: (out: Float32Array, input: Float32Array, arg: A) => unknown, arg?: A): T {
  stride = stride || 3; offset = offset || 0;
  const end = count ? Math.min(count * stride + offset, a.length) : a.length;
  for (let i = offset; i < end; i += stride) {
    forEachVector[0] = a[i]; forEachVector[1] = a[i + 1]; forEachVector[2] = a[i + 2];
    fn(forEachVector, forEachVector, arg as A);
    a[i] = forEachVector[0]; a[i + 1] = forEachVector[1]; a[i + 2] = forEachVector[2];
  }
  return a;
}

export type Vec3Array = Float32Array | Float64Array | number[];

export {create,cross,normalize,set,subtract,sub} from './sceneVec3.js';
