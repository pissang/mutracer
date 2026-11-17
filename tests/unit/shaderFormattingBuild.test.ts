import { runInNewContext } from 'node:vm';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { rollup } from 'rollup';
import { createShaderIdentifierMap, readShaderSourceFiles, renameShaderIdentifiers } from '../../scripts/shader-identifiers.mjs';
import {
  createShaderFormattingTransformer,
  shaderFormattingPlugin,
  stripShaderFormatting
} from '../../scripts/shader-formatting.mjs';

const filename = path.resolve('src/renderer/formattingFixture.ts');
function evaluate(source: string, compact: boolean, fileName = filename) {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
    transformers: compact ? { before: [createShaderFormattingTransformer()] } : undefined
  });
  const exports: Record<string, any> = {};
  runInNewContext(result.outputText, { exports });
  return exports;
}

describe('production shader formatting', () => {
  it('keeps GLSL directives and line endings while compacting expressions', () => {
    const source = '#version 300 es\r\n  #define VALUE 1 // explanation\r\n\t#if VALUE\r\n  float x = clamp(v, 0.0, 1.0);\r\n  #endif\r\n';
    expect(stripShaderFormatting(source)).toBe(
      '#version 300 es\r\n#define VALUE 1 \r\n#if VALUE\r\nfloat x=clamp(v,0.0,1.0);\r\n#endif\r\n');
  });

  it('removes nested WGSL block comments without joining tokens or losing newlines', () => {
    expect(stripShaderFormatting('let/* outer /* inner */\n comment */value = 1; // end')).toBe('let \nvalue=1; ');
    expect(stripShaderFormatting('a/* comment */b')).toBe('a b');
    expect(stripShaderFormatting('/* comment with // marker */\nfn main() {}')).toBe('\nfn main(){}');
    expect(stripShaderFormatting('/* unterminated\n  comment')).toBe('/* unterminated\ncomment');
  });

  it('preserves quoted preprocessor text', () => {
    expect(stripShaderFormatting('#include "https://example.test/a/*b*/" // comment\n'))
      .toBe('#include "https://example.test/a/*b*/" \n');
  });

  it('compacts marked shaders and nested fragments while preserving ordinary JS and raw templates', () => {
    const source = `
      const glsl = (parts: TemplateStringsArray, ...values: unknown[]) =>
        parts.reduce((text, part, i) => text + (i ? values[i - 1] : '') + part, '');
      export const url = 'https://example.test/model';
      export const message = \`  // ordinary JS text\n  stays indented\`;
      export const raw = String.raw\`  // raw text\n  \\n\`;
      const name = 'main';
      export const wgsl = /* wgsl */ \`\n  // shader comment\n  fn \${name}() {\n    \${true ? \`\n    // nested comment\n    let value = 1;\` : ''}\n  }\n\`;
      export const fragment = glsl\`#version 300 es\n  // GLSL comment\n  void main() {}\n\`;
    `;
    const original = evaluate(source, false), compact = evaluate(source, true);
    expect(compact.url).toBe(original.url);
    expect(compact.message).toBe(original.message);
    expect(compact.raw).toBe(original.raw);
    expect(compact.wgsl).not.toContain('//');
    expect(compact.wgsl).toContain('fn main()');
    expect(compact.wgsl).toContain('\nlet value=1;');
    expect(compact.fragment).toBe('#version 300 es\n\nvoid main(){}\n');
    expect(stripShaderFormatting(compact.wgsl)).toBe(stripShaderFormatting(original.wgsl));
    expect(evaluate(source, true, path.resolve('src/util/formattingFixture.ts'))).toEqual(original);
  });

  it('preserves comments across interpolation boundaries and required inline whitespace', () => {
    const source = `
      const name = 'value';
      export const shader = /* wgsl */ \`\n  // commented \${name} must stay commented\n  let\${''} value = 1;\n  /* block \${name} comment */\n  fn main() {}\n\`;
    `;
    const original = evaluate(source, false).shader, compact = evaluate(source, true).shader;
    expect(compact).toContain('// commented value must stay commented\n');
    expect(compact).toContain('let value=1;');
    expect(stripShaderFormatting(compact)).toBe(stripShaderFormatting(original));
  });

  it('compacts unmarked templates in dedicated shader modules', () => {
    const source = 'export const shader = `\n  // comment\n  fn main() {}\n`;';
    expect(evaluate(source, true, path.resolve('src/renderer/wgsl/fixture.ts')).shader)
      .toBe('\nfn main(){}\n');
  });

  it('preserves leading spaces in nested fragments inserted between tokens', () => {
    const source = `
      const keyword = 'let';
      export const shader = /* wgsl */ \`\${keyword}\${true ? \` value \` : ''}= 1;\`;
    `;
    expect(evaluate(source, true).shader).toBe('let value =1;');
  });

  it('emits source maps containing the original shader source for Vite builds', async () => {
    const plugin = shaderFormattingPlugin();
    expect(plugin.apply).toBe('build');
    const source = 'export const shader = /* wgsl */ `\n  // comment\n  fn main() {}\n`;';
    if (typeof plugin.transform !== 'function') throw new Error('Expected a transform hook');
    const output = await plugin.transform.call({} as any, source, filename);
    if (!output || typeof output === 'string' || typeof output.code !== 'string') {
      throw new Error('Expected code and source map');
    }
    const map = typeof output.map === 'string' ? JSON.parse(output.map) : output.map;
    expect(map.sourcesContent).toEqual([source]);
    expect(evaluate(output.code, false).shader).toBe('\nfn main(){}\n');
    expect(await plugin.transform.call({} as any, source, path.resolve('src/util/fixture.ts'))).toBeNull();
  });

  it('keeps cached chunk definitions and changed callers in sync when a rebuild changes names', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mutracer-shader-cache-'));
    const sourceRoot = path.join(root, 'src');
    const renderer = path.join(sourceRoot, 'renderer');
    mkdirSync(renderer, { recursive: true });
    const definition = 'fn firstPrivateFunction() -> i32 { return 1; }';
    const body = (extra: string) => `fn secondPrivateFunction() -> i32 { return 2; }
@compute @workgroup_size(1) fn main() { let result = firstPrivateFunction() + secondPrivateFunction()${extra}; }`;
    const entry = path.join(renderer, 'entry.ts');
    writeFileSync(path.join(renderer, 'definition.ts'), `export const definition = /* wgsl */ ${JSON.stringify(definition).replace(/^"|"$/g, '`')};`);
    const writeEntry = (extra: string) => writeFileSync(entry,
      "import { definition } from './definition.ts';\nexport const shader = definition + /* wgsl */ `" + body(extra) + '`;');
    try {
      writeEntry('');
      const initialNames = createShaderIdentifierMap(readShaderSourceFiles(sourceRoot));
      const plugin = shaderFormattingPlugin({ sourceRoot });
      const first = await rollup({ input: entry, plugins: [plugin] });
      const cache = first.cache;
      await first.close();
      const extra = ' + firstPrivateFunction()'.repeat(5);
      writeEntry(extra);
      const nextNames = createShaderIdentifierMap(readShaderSourceFiles(sourceRoot));
      expect(nextNames.get('firstPrivateFunction')).not.toBe(initialNames.get('firstPrivateFunction'));
      const second = await rollup({ input: entry, cache, plugins: [plugin] });
      try {
        const output = await second.generate({ format: 'es' });
        const chunk = output.output.find(item => item.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw new Error('Expected shader bundle');
        const shader = evaluate(chunk.code, false).shader;
        const inverse = new Map([...nextNames].map(([a, b]) => [b, a]));
        expect(renameShaderIdentifiers(shader, inverse)).toBe(stripShaderFormatting(definition + body(extra), false));
      } finally { await second.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('preserves token boundaries, macro continuations, quotes and interpolation separators', () => {
  expect(stripShaderFormatting('a + +b - -c / *d / /e; x < < y; z > = q;'))
    .toBe('a+ +b- -c/ *d/ /e;x< <y;z> =q;');
  const macro = '#define MIX(a, b) ((a) + \\\n  (b))\n';
  expect(stripShaderFormatting(macro)).toBe('#define MIX(a, b) ((a) + \\\n(b))\n');
  expect(stripShaderFormatting('let a = "quoted + / *";\n\n\n\nlet b = x + \0 + y;'))
    .toBe('let a="quoted + / *";\n\nlet b=x+ \0 +y;');
  expect(stripShaderFormatting('value . 5 + 1 . suffix')).toBe('value. 5+1 .suffix');
});
