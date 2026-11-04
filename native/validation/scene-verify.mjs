import {mat4 as referenceMat4} from 'gl-matrix';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { referenceScene, textureBytes } from './scene-reference.mjs';
import {executable} from '../scripts/platform.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '.native-build/scene-core'));
mkdirSync(out, { recursive: true });
const source = resolve(out, 'javascript-source');
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const program = ts.createProgram([resolve(root, 'native/src/scene-core.ts'), resolve(root, 'src/renderer/WGPURayTracePass.ts')], { ...options, rootDir: root, outDir: source, declaration: false, sourceMap: false, inlineSources: false });
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics];
if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error))
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: n => n, getNewLine: () => '\n' }));
writeFileSync(resolve(source, 'package.json'), '{"type":"module"}\n');
const { sceneParameters } = await import(pathToFileURL(resolve(source, 'native/src/scene-core.js')).href);
const results = [];
async function verifyScene(input, directory, variant, capture = true) {
    mkdirSync(directory, {recursive:true});
    writeFileSync(resolve(directory, 'scene-input.bin'), input);
    const actual = resolve(directory, 'packet.bin');
    const run = spawnSync(resolve(out, executable('core-host')), [resolve(directory, 'scene-input.bin'), actual], { encoding: 'utf8', timeout: 90000 });
    if (run.status !== 0)
        throw new Error(`Native packet ${variant}: ${run.stderr}`);
    const packet = readFileSync(actual), expected = sceneParameters(input);
    if (!packet.equals(Buffer.from(expected))) {
        writeFileSync(resolve(directory, 'packet-js.bin'), expected);
        const first = packet.findIndex((v, i) => v !== expected[i]);
        throw new Error(`Native/JS packet ${variant} differs at byte ${first}; ${packet.length}/${expected.length}`);
    }
    const { pass, device, camera, nativeShader, nativeResources } = await referenceScene(input, source);
    const header = new Uint32Array(packet.buffer, packet.byteOffset, packet.byteLength / 4);
    const records = new Map();
    for (let i = 0; i < header[1]; i++) {
        const o = 4 + i * 8;
        records.set(header[o], packet.subarray(header[o + 7], header[o + 7] + header[o + 2]));
    }
    const mappings = [[1, 0, 0], [2, 0, 1], [3, 0, 2], [4, 0, 3], [5, 1, 3], [6, 2, 0], [7, 2, 1], [8, 2, 2], [20, 1, 1], [21, 1, 4], [22, 1, 5], [23, 1, 6], [24, 1, 8], [25, 1, 9], [26, 1, 10]];
    const resources = [];
    for (const [id, group, binding] of mappings) {
        const resource = pass._rayTraceBindGroups[group].descriptor.entries.find(e => e.binding === binding).resource;
        let reference = nativeResources.get(id) ?? (resource.buffer ? resource.buffer.data : textureBytes(resource.texture));
        if (id === 6) {
            // Native preserves double intermediates until GPU packing; compare
            // against upstream gl-matrix rather than its own AOT implementation.
            // The independent browser capture below keeps its original precision.
            const matrix = new Float64Array(16);
            referenceMat4.invert(matrix, camera.getProjectionMatrix(header[2] / header[3]));
            referenceMat4.multiply(matrix, camera.transform, matrix);
            const cameraBlock = new Float32Array(Uint8Array.from(reference).buffer);
            cameraBlock.set(matrix);
            // Web appends projectionInverse; native keeps the documented 144-byte prefix.
            reference = new Uint8Array(cameraBlock.buffer, 0, 144);
        }
        const native = records.get(id);
        if (!Buffer.from(reference).equals(native)) {
            writeFileSync(resolve(directory, `reference-${id}.bin`), reference);
            const first = native.findIndex((v, i) => v !== reference[i]);
            throw new Error(`Browser resource ${variant}/${id} differs at ${first}; ${native.length}/${reference.length}`);
        }
        resources.push({ id, bytes: native.length, byteIdentical: true, reference: id === 6 ? 'independent Float64 camera' : id === 20 ? 'browser logical atlas pages' : nativeResources.has(id) ? 'browser geometry in native TLAS layout' : 'browser' });
    }
    const shader = device.resources.findLast(r => r.kind === 'pipeline').descriptor.compute.module.descriptor.code;
    if (!records.get(30).equals(Buffer.from(nativeShader))) {
        writeFileSync(resolve(directory, 'reference.wgsl'), nativeShader);
        throw new Error(`Browser WGSL ${variant} differs`);
    }
    if (capture) {
    // Save an independent browser-facade capture for actual WebGPU execution.
    const capture = resolve(directory, 'reference', 'scene');
    mkdirSync(capture, { recursive: true });
    function save(name, data) { writeFileSync(resolve(capture, name), data); return name; }
    const buffers = device.resources.filter(r => r.kind === 'buffer').map(r => ({ id: r.id, size: r.size, usage: r.descriptor.usage, file: save(`buffer-${r.id}.bin`, r.data) }));
    const textures = device.resources.filter(r => r.kind === 'texture').map(r => ({ id: r.id, width: r.width, height: r.height, depth: r.depthOrArrayLayers, format: r.format, usage: r.descriptor.usage, writes: r.writes.map((w, i) => ({ origin: w.origin, size: w.size, layout: w.layout, file: save(`texture-${r.id}-${i}.bin`, w.data) })) }));
    const samplers = device.resources.filter(r => r.kind === 'sampler').map(r => ({ id: r.id, ...r.descriptor }));
    const bindGroups = pass._rayTraceBindGroups.map(g => ({ layout: g.descriptor.layout.descriptor.entries, entries: g.descriptor.entries.map(({ binding, resource: r }) => ({ binding, ...(r.buffer ? { kind: 'buffer', id: r.buffer.id } : r.kind === 'view' ? { kind: 'texture', id: r.texture.id, options: r.options } : { kind: 'sampler', id: r.id }) })) }));
    save('scene.json', JSON.stringify({ format: 1, width: header[2], height: header[3], samples: 64, shader: save('raytrace.wgsl', shader), entryPoint: 'main', buffers, textures, samplers, bindGroups, rtUniform: pass._uniforms.rtUniform.id, colorOutput: pass.getOutputBuffer().color.id, normalOutput: pass.getOutputBuffer().normal.id, albedoOutput: pass.getOutputBuffer().albedo.id }, null, 2));
    }
    return { variant, packetBytes: packet.length, nativeJavaScriptPacketIdentical: true, resources,
        shaderPolicy: 'native retained material/light capabilities and baked environment', fullShaderIdentical: true };
}
for (const variant of process.argv.slice(2).length ? process.argv.slice(2) : ['baseline', 'textures', 'transforms', 'orthographic', 'emissive', 'missing-normals', 'float-textures', 'sphere-light', 'directional-light', 'spot-light', 'alpha', 'v2-environment', 'v2-environment-only', 'v2-background', 'v2-hidden-background', 'v2-film', 'v2-medium', 'v2-alpha', 'v2-bevel', 'v2-vertices', 'v2-multimaterial', 'v2-instances', 'v2-empty-batch', 'v3-displacement-uv', 'v3-displacement-triplanar', 'v3-displacement-spherical', 'v3-displacement-cylindrical', 'v3-displacement-negative', 'v3-displacement-bytes', 'v3-displacement-zero', 'v3-ies', 'v3-ies-shared', 'v3-rect-texture']) {
    const directory = resolve(out, variant === 'baseline' ? 'image' : variant);
    results.push(await verifyScene(readFileSync(resolve(directory, 'scene-input.bin')), directory, variant));
    console.log(`${variant}: native/JS packet, browser scene resources, independent Float64 camera and full WGSL exact`);
}
const properties = JSON.parse(readFileSync(resolve(root, 'native/schemas/material-properties.json'), 'utf8'));
const { openPbrSchema } = await import(pathToFileURL(resolve(source, 'src/scene/openPbrSchema.js')).href);
if (properties.length !== openPbrSchema.length || new Set(properties.map(p => p.id)).size !== properties.length ||
    new Set(properties.map(p => p.key)).size !== properties.length)
    throw new Error('Material wire schema has missing or duplicate properties');
for (const field of openPbrSchema) {
    const wire = properties.find(p => p.key === field.key);
    if (!wire || wire.type !== field.type)
        throw new Error(`Material wire type differs from source schema: ${field.key}`);
}
const propertyResults = [];
const base = readFileSync(resolve(out, 'v3-rect-texture/scene-input.bin'));
for (const field of properties.filter(p => p.supported)) {
    const input = Buffer.concat([base, Buffer.alloc(16)]);
    const u = new Uint32Array(input.buffer, input.byteOffset, input.byteLength / 4);
    const f = new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4);
    const offset = base.byteLength / 4;
    u[1] = input.byteLength / 4; u[u[11] + 19] = 1; u[u[11] + 20] = offset; u[offset] = field.id;
    if (field.type === 'bool') u[offset + 1] = 1;
    else if (field.type === 'enum') u[offset + 1] = field.values.length - 1;
    else if (field.type === 'texture') u[offset + 1] = 1;
    else if (field.type === 'float') f[offset + 1] = field.key.includes('Ior') ? 1.4 : field.key.includes('Abbe') ? 30 : .4;
    else { f[offset + 1] = .2; f[offset + 2] = .4; if (field.type === 'color') f[offset + 3] = .6; }
    propertyResults.push(await verifyScene(input, resolve(out, 'properties', field.key), field.key, false));
}
writeFileSync(resolve(out, 'scene-verification.json'), JSON.stringify({complete:true, results, propertyResults}, null, 2) + '\n');
console.log(`${propertyResults.length} material properties: native/JS packet, browser material resources and independent Float64 camera exact`);
