// Independent browser-facade oracle for the native wire protocol. This file is
// validation only; no generated resource from it is used by scene-host.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const materialProperties = JSON.parse(readFileSync(new URL('../schemas/material-properties.json', import.meta.url), 'utf8'));
import { CaptureDevice, installWebGPUConstants } from './resource-recorder.mjs';
export async function referenceScene(bytes, sourceRoot) {
    const load = path => import(pathToFileURL(resolve(sourceRoot, 'src', path)).href);
    const [{ default: Geometry, Attribute }, { default: Mesh }, { default: Material }, { default: Texture }, { default: Camera }, { default: Rect }, { default: Sphere }, { default: Directional }, { default: Spot }, { default: Pass }, { default: Environment }, { default: InstancedMesh }] = await Promise.all([
        'scene/Geometry.js', 'scene/Mesh.js', 'scene/OpenPBRMaterial.js', 'scene/Texture.js', 'scene/Camera.js',
        'scene/RectLight.js', 'scene/SphereLight.js', 'scene/DirectionalLight.js', 'scene/SpotLight.js', 'renderer/WGPURayTracePass.js', 'scene/EnvironmentLight.js', 'scene/InstancedMesh.js'
    ].map(load));
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const {parseIESProfile} = await load('scene/IESProfile.js');
    const profiles = new Map();
    const textures = [], materials = [], geometries = [], meshes = [], lights = [];
    for (let i = 0; i < u[8]; i++) {
        const o = u[13] + i * 12, w = u[o], h = u[o + 1], p = u[o + 3];
        const texture = new Texture({ width: w, height: h, data: u[o + 2] === 0
                ? new Uint8Array(bytes.buffer, bytes.byteOffset + p * 4, w * h * 4).slice() : f.slice(p, p + w * h * 4) });
        texture.flipY = !!u[o + 4];
        texture.uvChannel = u[o + 5];
        texture.uvScale = [f[o + 6], f[o + 7]];
        texture.uvOffset = [f[o + 8], f[o + 9]];
        textures.push(texture);
    }
    for (let i = 0; i < u[6]; i++) {
        const o = u[11] + i * 24, m = new Material({ baseColor: [f[o], f[o + 1], f[o + 2]], specularRoughness: f[o + 3],
            baseMetalness: f[o + 4], transmissionWeight: f[o + 5], specularIor: f[o + 6], emissionColor: [f[o + 7], f[o + 8], f[o + 9]],
            emissionLuminance: f[o + 10], coatWeight: f[o + 11], coatRoughness: f[o + 12], geometryOpacity: f[o + 13], geometryThinWalled: !!u[o + 14] });
        for (const [k, name] of [[15, 'map'], [16, 'normalMap'], [17, 'metallicRoughnessMap'], [18, 'emissiveMap']])
            m[name] = u[o + k] === 0xffffffff ? undefined : textures[u[o + k]];
        for (let i = 0; i < u[o + 19]; i++) {
            const entry = u[o + 20] + i * 4, field = materialProperties.find(p => p.id === u[entry]);
            if (!field || !field.supported) throw new Error('Unsupported property in reference');
            m[field.key] = field.type === 'float' ? f[entry + 1] : field.type === 'color' ? Array.from(f.slice(entry + 1, entry + 4)) :
                field.type === 'vec2' ? Array.from(f.slice(entry + 1, entry + 3)) : field.type === 'bool' ? !!u[entry + 1] :
                field.type === 'enum' ? field.values[u[entry + 1]] : u[entry + 1] === 0xffffffff ? undefined : textures[u[entry + 1]];
        }
        materials.push(m);
    }
    for (let i = 0; i < u[4]; i++) {
        const o = u[9] + i * 12, n = u[o], count = u[o + 1], g = new Geometry({ position: new Attribute(f.slice(u[o + 2], u[o + 2] + n * 3), 3), indices: new Attribute(u.slice(u[o + 3], u[o + 3] + count), 1) });
        for (const [k, name, stride] of [[4, 'normal', 3], [5, 'uv', 2], [6, 'uv1', 2]])
            if (u[o + k])
                g[name] = new Attribute(f.slice(u[o + k], u[o + k] + n * stride), stride);

        if (u[o + 7]) g.color = new Attribute(f.slice(u[o + 7], u[o + 7] + n * 3), 3);
        if (u[o + 8]) g.tangent = new Attribute(f.slice(u[o + 8], u[o + 8] + n * 4), 4);
        if (u[o + 9]) g.materialIndex = new Attribute(new Int32Array(u.slice(u[o + 9], u[o + 9] + n)), 1);

        geometries.push(g);
    }
    for (let i = 0; i < u[5]; i++) {
        const o = u[10] + i * 20;
        const material = u[o + 3] ? Array.from(u.slice(u[o + 2], u[o + 2] + u[o + 3]), id => materials[id]) : materials[u[o + 1]];
        const io = u[23] ? u[23] + i * 4 : 0;
        const m = io && u[io] !== 0xffffffff ? new InstancedMesh(geometries[u[o]], material, {count:u[io],
            transforms:f.slice(u[io + 1],u[io + 1]+u[io]*16),colors:u[io+2]?f.slice(u[io+2],u[io+2]+u[io]*3):undefined}) : new Mesh(geometries[u[o]], material);
        m.transform = f.slice(o + 4, o + 20);
        meshes.push(m);
    }
    for (let i = 0; i < u[7]; i++) {
        const o = u[12] + i * 28, type = u[o], light = type === 0 ? new Rect({ size: [f[o + 5], f[o + 6]], spread: f[o + 7] }) : type === 1 ? new Sphere({ radius: f[o + 5] }) : type === 2 ? new Directional() : new Spot({ radius: f[o + 5], innerAngle: f[o + 6], outerAngle: f[o + 7] });
        if (type === 0 && u[o + 8]) light.texture = textures[u[o + 8] - 1];
        if (type === 3 && u[o + 10]) {
            const key = `${u[o + 9]}:${u[o + 10]}`;
            if (!profiles.has(key)) profiles.set(key, parseIESProfile(new TextDecoder().decode(bytes.subarray(u[o + 9] * 4, u[o + 9] * 4 + u[o + 10])), 'native scene'));
            light.iesProfile = profiles.get(key);
        }
        light.color = [f[o + 1], f[o + 2], f[o + 3]];
        light.intensity = f[o + 4];
        light.transform = f.slice(o + 12, o + 28);
        lights.push(light);
    }
    const o = u[14], camera = u[o] === 0 ? new Camera({ projection: 'perspective', fov: f[o + 1], near: f[o + 2], far: f[o + 3] }) : new Camera({ projection: 'orthographic', left: f[o + 4], right: f[o + 5], bottom: f[o + 6], top: f[o + 7], near: f[o + 2], far: f[o + 3] });
    [camera.zoom, camera.fStop, camera.focusDistance, camera.sensorHeight, camera.metersPerUnit] = [f[o + 8], f[o + 9], f[o + 10], f[o + 11], f[o + 12]];
    camera.transform = f.slice(o + 16, o + 32);
    installWebGPUConstants();
    const device = new CaptureDevice();
    device.limits.maxTextureDimension2D = 4096;
    const pass = new Pass(device);
    pass._maxTextureArrayBytes = 64 * 1024 * 1024;
    pass.setSize(u[2], u[3]);
    pass.setCamera(camera);
    pass.setMeshes(meshes);
    if (u[20]) lights.push(new Environment({map: textures[u[20] - 1]}));
    pass.setLights(lights);
    const flags = u[22];
    pass.setBackground(flags & 4 ? undefined : u[21] ? textures[u[21] - 1] : Array.from(f.slice(16, 20)));
    pass.setQuality({ bounces: 6, bevel: !!(flags & 1), dispersionWavelengths: flags & 2 ? 3 : 1, directLightCandidates: 2 });
    pass.setTransmissiveOutputAlphaMin(1);
    pass.setSamplingPattern('sobol', 64, 12345);
    pass.setSampleTiles(1, 1, 0, 0);
    pass.setSampleCount(0);
    pass.setJitter(.5, .5);
    for (let pending; (pending = pass.updatePipeline());) await pending;
    if (!pass.isPipelineReady())
        throw pass.getPipelineError() ?? new Error('Reference pipeline not ready');
    pass.createPass(device.createCommandEncoder(), true, [1, 1]);
    // Match native's retained scalar-edit support and baked environment policy
    // when comparing shader source. The independent browser capture below
    // keeps its own lean pipeline and dynamic environment implementation.
    const {wgpuShaderSource} = await load('renderer/wgpuShaderSource.js');
    const {ALL_MATERIAL_SHADER_CAPABILITIES, ALL_LIGHT_SHADER_CAPABILITIES, updateSceneShaderCapabilities} = await load('renderer/shaderCapabilities.js');
    const constants = {...pass._constants, MATERIAL_CAPABILITIES: ALL_MATERIAL_SHADER_CAPABILITIES,
        LIGHT_CAPABILITIES: ALL_LIGHT_SHADER_CAPABILITIES};
    updateSceneShaderCapabilities(constants);
    const nativeShader = wgpuShaderSource(constants, {hasDisplacement:pass._hasDisplacement, hasAlpha:false,
        hasSceneAlpha:Boolean(constants.HAS_ALPHA),hasAnisotropyDirections:Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
        hasCoatNormals:Boolean(constants.USE_COAT_NORMAL_FRAMES),blasLayoutMask:1}, true);
    return { device, pass, camera, nativeShader };
}
export function textureBytes(texture) {
    const bpp = { rgba8unorm: 4, rgba16float: 8, rgba32float: 16, r32float: 4, rg32float: 8 }[texture.format];
    if (!bpp)
        throw new Error(`Unsupported reference format ${texture.format}`);
    const result = new Uint8Array(texture.width * texture.height * texture.depthOrArrayLayers * bpp);
    for (const write of texture.writes) {
        const [x = 0, y = 0, z = 0] = write.origin;
        const w = write.size.width ?? write.size[0], h = write.size.height ?? write.size[1] ?? 1, d = write.size.depthOrArrayLayers ?? write.size[2] ?? 1;
        const row = write.layout.bytesPerRow ?? w * bpp, rows = write.layout.rowsPerImage ?? h, off = write.layout.offset ?? 0;
        for (let layer = 0; layer < d; layer++)
            for (let yy = 0; yy < h; yy++)
                result.set(write.data.subarray(off + (layer * rows + yy) * row, off + (layer * rows + yy) * row + w * bpp), (((z + layer) * texture.height + y + yy) * texture.width + x) * bpp);
    }
    return result;
}
