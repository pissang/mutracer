import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createShaderIdentifierMap,
  loadShaderIdentifierMap,
  renameShaderIdentifiers,
  type ShaderSourceFile
} from '../../scripts/shader-identifiers.mjs';
import { createShaderFormattingTransformer } from '../../scripts/shader-formatting.mjs';

const file = (name: string, source: string): ShaderSourceFile => ({ filename: path.resolve(`src/${name}`), source });
function evaluate(input: ShaderSourceFile, mapping: ReadonlyMap<string, string>) {
  const exports: Record<string, string> = {};
  const code = ts.transpileModule(input.source, {
    fileName: input.filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
    transformers: { before: [createShaderFormattingTransformer(mapping)] }
  }).outputText;
  runInNewContext(code, { exports });
  return exports;
}

describe('build-time shader identifier shortening', () => {
  it('uses one collision-free mapping across chunks, scopes and both languages', () => {
    const files = [
      file('renderer/wgsl/definition.ts', 'export const source = `fn privateHelper(longArgument: f32) -> f32 { let longTemporary = longArgument; return longTemporary; }`;'),
      file('renderer/wgsl/call.ts', 'export const source = `fn main() { let otherTemporary = privateHelper(1.0); }`;'),
      file('renderer/glsl/definition.ts', 'export const source = /* glsl */ `float privateHelper(float longArgument) { float longTemporary = longArgument; return longTemporary; }`;')
    ];
    const mapping = createShaderIdentifierMap(files);
    expect(mapping.has('privateHelper')).toBe(true);
    expect(mapping.has('longArgument')).toBe(true);
    expect(mapping.has('longTemporary')).toBe(true);
    expect(new Set(mapping.values()).size).toBe(mapping.size);
    expect([...mapping]).toEqual([...createShaderIdentifierMap([...files].reverse())]);
    const inverse = new Map([...mapping].map(([a, b]) => [b, a]));
    for (const input of files) {
      const original = evaluate(input, new Map()).source;
      const compact = evaluate(input, mapping).source;
      expect(compact.length).toBeLessThan(original.length);
      expect(renameShaderIdentifiers(compact, inverse)).toBe(original);
      expect(renameShaderIdentifiers(compact, mapping)).toBe(compact);
    }
  });

  it('protects CPU strings, interpolation values, fields, bindings, overrides and entry points', () => {
    const input = file('renderer/wgsl/fixture.ts', `
      const field = 'materialWeight';
      export const source = \`
        struct Parameters { materialWeight: f32, privateTemporary: f32, }
        @group(0) @binding(0) var<uniform> parameters: Parameters;
        override imageWidth: f32;
        fn helperFunction(materialWeight: f32) -> f32 { return materialWeight; }
        @compute @workgroup_size(1) fn publicEntry() {
          let privateTemporary = parameters.\${field};
          let cpuNamedTemporary = helperFunction(privateTemporary);
        }
      \`;
      export const url = 'https://example.test/helperFunction';
    `);
    const host = file('host.ts', 'export const cpuNamedTemporary = 1;');
    const mapping = createShaderIdentifierMap([input, host]);
    for (const name of ['Parameters', 'materialWeight', 'privateTemporary', 'parameters', 'imageWidth', 'publicEntry', 'cpuNamedTemporary', 'helperFunction']) {
      expect(mapping.has(name), name).toBe(false);
    }
    expect(evaluate(input, mapping).url).toBe('https://example.test/helperFunction');
  });

  it('protects dynamically assembled names and leaves raw tags untouched', () => {
    const input = file('renderer/wgsl/fixture.ts', `
      const name = 'colorTex';
      export const generated = /* wgsl */ \`fn load_\${name}() -> f32 { return 1.0; }\`;
      export const source = \`fn main() { let longTemporary = load_colorTex(); }\`;
      export const raw = String.raw\`fn rawHelper() { let rawTemporary = 0; }\`;
    `);
    const declaration = file('renderer/wgsl/static.ts', 'export const source = `fn load_colorTex() -> f32 { return 1.0; }`;');
    const mapping = createShaderIdentifierMap([input, declaration]);
    expect(mapping.has('load_colorTex')).toBe(false);
    expect(mapping.has('rawHelper')).toBe(false);
    expect(mapping.has('longTemporary')).toBe(true);
    const output = evaluate(input, mapping);
    expect(output.generated).toContain('fn load_colorTex()');
    expect(output.source).toContain('load_colorTex()');
    expect(output.raw).toBe(evaluate(input, new Map()).raw);
  });

  it('unions builtin protections across WGSL and GLSL and preserves macro references', () => {
    const files = [
      file('renderer/wgsl/bits.ts', 'export const source = `fn main() { let reversedValue = reverseBits(1u); let castValue = bitcast<f32>(reversedValue); }`;'),
      file('renderer/glsl/bits.ts', 'export const source = `uint reverseBits(uint originalValue) { return originalValue; } float bitcast(uint originalValue) { return uintBitsToFloat(originalValue); }\n#define WRAP(value) macroHelper(value)\nfloat macroHelper(float longArgument) { return longArgument; }`;')
    ];
    const mapping = createShaderIdentifierMap(files);
    expect(mapping.has('reverseBits')).toBe(false);
    expect(mapping.has('bitcast')).toBe(false);
    expect(mapping.has('macroHelper')).toBe(false);
    expect(mapping.has('originalValue')).toBe(true);
  });

  it('preserves GLSL interfaces and fields whose names also look like swizzles', () => {
    const input = file('renderer/glsl/fixture.ts', 'export const source = `struct Intersection { float distanceValue; float rgba; }; uniform vec3 uniformColor; in vec2 textureCoordinate; out vec4 fragmentColor; void main() { Intersection hitRecord; hitRecord.distanceValue = 1.0; hitRecord.rgba = 0.0; fragmentColor = vec4(uniformColor, 1.0); }`;');
    const mapping = createShaderIdentifierMap([input]);
    for (const name of ['distanceValue', 'rgba', 'uniformColor', 'textureCoordinate', 'fragmentColor', 'main']) expect(mapping.has(name), name).toBe(false);
    expect(mapping.has('hitRecord')).toBe(true);
  });

  it('preserves aliases and nested types used in uniform or storage bindings', () => {
    const input = file('renderer/wgsl/buffer.ts', 'export const source = `struct NestedPayload { value: f32, } struct UniformPayload { nested: NestedPayload, } alias PublicPayload = UniformPayload; @group(0) @binding(0) var<uniform> payload: PublicPayload; struct PrivatePayload { unused: f32, }`;');
    const mapping = createShaderIdentifierMap([input]);
    for (const name of ['NestedPayload', 'UniformPayload', 'PublicPayload', 'payload']) expect(mapping.has(name), name).toBe(false);
    expect(mapping.has('PrivatePayload')).toBe(true);
  });

  it('avoids existing names and keywords even after exhausting two-letter names', () => {
    const input = file('renderer/wgsl/large.ts', 'export const source = `' +
      'fn aa() {} fn ab() {}\n' + Array.from({ length: 3000 }, (_, i) => `fn privateHelper${i}() {}`).join('\n') + '`;');
    const mapping = createShaderIdentifierMap([input]);
    const values = [...mapping.values()];
    expect(mapping.size).toBe(3000);
    expect(new Set(values).size).toBe(values.length);
    expect(values).not.toContain('aa');
    expect(values).not.toContain('ab');
    for (const keyword of ['as', 'do', 'fn', 'if', 'in', 'is', 'or']) expect(values).not.toContain(keyword);
    expect(values.some(name => name.startsWith('_'))).toBe(true);
  });

  it('renames tokens without modifying numbers, comments, quotes or larger identifiers', () => {
    const source = 'longValue + longValueExtra + 0xdeadbeefu + 1.0e999; // longValue\n/* outer /* longValue */ longValue */\n#include "longValue"';
    expect(renameShaderIdentifiers(source, new Map([['longValue', 'aa'], ['deadbeefu', 'bb'], ['e999', 'cc']])))
      .toBe('aa + longValueExtra + 0xdeadbeefu + 1.0e999; // longValue\n/* outer /* longValue */ longValue */\n#include "longValue"');
  });

  it('derives production names from source without shrinking host-visible contracts', () => {
    const mapping = loadShaderIdentifierMap();
    expect(mapping.size).toBeGreaterThan(0);
    expect(mapping.has('transmissionRayOrigin')).toBe(true);
    for (const name of ['main', 'depthQuery', 'rtUniform', 'RayTraceUniform', 'reverseBits', 'sample_colorTex', 'load_colorTex', 'thinFilmWeight', 'offsetSurfaceRay']) {
      expect(mapping.has(name), name).toBe(false);
    }
  });
});
