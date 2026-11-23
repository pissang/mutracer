// Use the browser compiler as the reference for the native CLI's graph IR.
import {build} from 'esbuild';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const result = await build({
    stdin: {
        contents: `
            export {parseMaterialX} from './src/materialx/parse.ts';
            export {normalizeGraph} from './src/renderer/materialGraph/normalize.ts';
            export {flattenGraphUnchecked} from './src/renderer/materialGraph/flatten.ts';
        `,
        resolveDir: root,
    },
    bundle: true, write: false, platform: 'node', format: 'esm',
});
const {parseMaterialX, normalizeGraph, flattenGraphUnchecked} =
    await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
const assets = resolve(root, 'viewer/src/assets/materialx');
const files = readdirSync(assets).filter(file => file.endsWith('.mtlx')).sort();
const rows = files.map(file => {
    const xml = readFileSync(resolve(assets, file), 'utf8');
    let material;
    try {
        material = parseMaterialX(xml);
    } catch (error) {
        return {file, rejection: error.message};
    }
    const normalized = material.graph && normalizeGraph(material.graph);
    const diagnostics = [...material.warnings, ...(normalized?.diagnostics.map(item => item.message) ?? [])];
    let graph;
    if (normalized) {
        const {nodes, inputs, terminal, parameters} = flattenGraphUnchecked(normalized);
        graph = {nodes, inputs, terminal, parameters: parameters.map(Math.fround)};
    }
    return {file, graph, ...(diagnostics.length && {diagnostics})};
});
const output = '[\n' + rows.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n';
const path = resolve(root, 'native/cli/tests/fixtures/materialx-browser-ir.json');
if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw new Error('Regenerate ' + path);
} else {
    writeFileSync(path, output);
}
