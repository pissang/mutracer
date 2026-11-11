// Private viewer adapter. Wire offsets and property IDs are the SDK's frozen contracts.
import { HEADER as H, GEOMETRY as G, MATERIAL as M, MESH, TEXTURE as T, LIGHT as L, GRAPH, VERSION } from '../../../native/src/layout';
import properties from '../../../native/schemas/material-properties.json';
import type { Scene } from '../../../src/scene/Scene';
import Camera from '../../../src/scene/Camera';
import Texture, { isTextureDataSource } from '../../../src/scene/Texture';
import type OpenPBRMaterial from '../../../src/scene/OpenPBRMaterial';
import type { EnvironmentSource, EnvironmentMapSource, ProceduralEnvironmentSource } from '../../../src/renderer/envMapDistribution';
import { generateEnvMapFromSceneComponents, generateBackgroundMapFromSceneBackground } from '../../../src/renderer/envMapCreation';
import { normalizeGraph } from '../../../src/renderer/materialGraph/normalize';
import { flattenGraph } from '../../../src/renderer/materialGraph/flatten';
import { textureWrapIndex } from '../../../src/scene/TextureState';
const NONE = 0xffffffff;
const colorMaps = new Set(['map', 'emissiveMap', 'fuzzColorMap', 'specularColorMap']);
const aliases: Record<string, string> = { opacity: 'geometryOpacity', thinWalled: 'geometryThinWalled' };
class Words {
    chunks: Uint32Array[] = [];
    length = 0;
    reserve(length: number) { const data = new Uint32Array(length); const at = this.length; this.chunks.push(data); this.length += length; return { at, u: data, f: new Float32Array(data.buffer) }; }
    append(data: ArrayLike<number>, floats = false) {
        if (floats && data instanceof Float32Array || !floats && data instanceof Uint32Array) {
            const at = this.length;
            this.chunks.push(new Uint32Array(data.buffer, data.byteOffset, data.length));
            this.length += data.length;
            return at;
        }
        const part = this.reserve(data.length);
        (floats ? part.f : part.u).set(data);
        return part.at;
    }
    bytes(data: Uint8Array) { const part = this.reserve(Math.ceil(data.byteLength / 4)); new Uint8Array(part.u.buffer).set(data); return part.at; }
    finish() { if (this.length > NONE)
        throw new Error('Scene exceeds the SDK descriptor word limit'); const u = new Uint32Array(this.length); let at = 0; for (const c of this.chunks) {
        u.set(c, at);
        at += c.length;
    } return u; }
}
export function cameraWords(camera: Camera) {
    const u = new Uint32Array(32), f = new Float32Array(u.buffer);
    u[0] = Number(camera.projection === 'orthographic');
    f.set([camera.fov, camera.near, camera.far, camera.left, camera.right, camera.bottom, camera.top, camera.zoom, camera.fStop, camera.focusDistance, camera.sensorHeight, camera.metersPerUnit], 1);
    f.set(camera.transform, 16);
    return u;
}
export type SkyResolver = (source: ProceduralEnvironmentSource) => Promise<EnvironmentMapSource>;
export class NativeSceneEncoder {
    private pixels = new WeakMap<object, {
        image: object;
        version: number;
        pixels: Uint8Array | Float32Array;
    }>();
    private skyCache = new Map<string, Promise<EnvironmentMapSource>>();
    constructor(private sky: SkyResolver) { }
    private readPixels(texture: Texture): Uint8Array | Float32Array {
        const cached = this.pixels.get(texture);
        if (cached?.image === texture.image && cached.version === texture.version)
            return cached.pixels;
        const image = texture.image;
        let pixels: Uint8Array | Float32Array;
        if (isTextureDataSource(image))
            pixels = image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray ? new Uint8Array(image.data) : Float32Array.from(image.data);
        else {
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(image as CanvasImageSource, 0, 0);
            pixels = new Uint8Array(ctx.getImageData(0, 0, image.width, image.height).data);
        }
        this.pixels.set(texture, { image, version: texture.version, pixels });
        return pixels;
    }
    async encode(scene: Scene, camera: Camera, size: [
        number,
        number
    ]): Promise<Uint32Array> {
        const w = new Words(), header = w.reserve(H.WORDS), h = header.u;
        const geometries = [...new Set(scene.meshes.map(mesh => mesh.geometry))];
        const materials = [...new Set(scene.meshes.flatMap(mesh => mesh.materials))] as OpenPBRMaterial[];
        const lights = scene.lights.filter(light => light.type !== 'AmbientLight' && light.type !== 'EnvironmentLight');
        const textures: {
            texture: Texture;
            pixels: Uint8Array | Float32Array;
        }[] = [];
        const textureIds = new Map<Texture, Map<string, number>>();
        const textureId = (texture: Texture | undefined, color = false) => {
            if (!texture)
                return NONE;
            const usage = color ? 'color' : 'data';
            let ids = textureIds.get(texture);
            if (!ids)
                textureIds.set(texture, ids = new Map());
            const old = ids.get(usage);
            if (old !== undefined)
                return old;
            let pixels = this.readPixels(texture);
            // v8 has implicit sRGB bytes / linear floats for color slots. Canonicalize
            // each use separately so a shared color+data image preserves both meanings.
            const linear = texture.colorSpace ? texture.colorSpace === 'linear' : pixels instanceof Float32Array;
            if (color && linear && !(pixels instanceof Float32Array))
                pixels = Float32Array.from(pixels, v => v / 255);
            else if (color && !linear && pixels instanceof Float32Array)
                pixels = pixels.map((v, i) => i % 4 === 3 ? v : v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
            const id = textures.length;
            textures.push({ texture, pixels });
            ids.set(usage, id);
            return id;
        };
        const graphData = materials.map(material => {
            if (!material.graph)
                return;
            const normalized = normalizeGraph(material.graph), ir = flattenGraph(normalized);
            const slots = normalized.parameters.map(value => value instanceof Texture ? textureId(value, true) : NONE);
            for (let i = 0; i < slots.length; i++)
                if (slots[i] !== NONE)
                    ir.parameters[i * 4] = i;
            return { normalized, ir, slots };
        });
        for (const material of materials)
            for (const property of properties)
                if (property.type === 'texture')
                    textureId(material[property.key as keyof OpenPBRMaterial] as Texture | undefined, colorMaps.has(property.key));
        for (const light of lights)
            if (light.type === 'RectLight')
                textureId(light.texture as Texture | undefined);
        const resolve = async (source: EnvironmentSource) => {
            if (!('sky' in source))
                return source;
            const key = JSON.stringify(source);
            let pending = this.skyCache.get(key);
            if (!pending) {
                pending = this.sky(source);
                this.skyCache.set(key, pending);
                if (this.skyCache.size > 3)
                    this.skyCache.delete(this.skyCache.keys().next().value!);
                void pending.catch(() => this.skyCache.delete(key));
            }
            return pending;
        };
        const env = await resolve(generateEnvMapFromSceneComponents(scene.lights.filter(l => l.type === 'AmbientLight'), scene.lights.filter(l => l.type === 'EnvironmentLight')));
        const background = scene.background;
        const envTexture = new Texture(env), envId = textures.length;
        textures.push({ texture: envTexture, pixels: env.data instanceof Float32Array ? env.data : Float32Array.from(env.data) });
        let backgroundId = envId;
        if (background && !Array.isArray(background)) {
            const source = generateBackgroundMapFromSceneBackground(background);
            if (!source)
                throw new Error('Native background requires decoded RGBA pixels');
            const map = await resolve(source);
            backgroundId = textures.length;
            textures.push({ texture: new Texture(map), pixels: map.data instanceof Float32Array ? map.data : Float32Array.from(map.data) });
        }
        h[H.VERSION] = VERSION.SCENE;
        h[H.WIDTH] = size[0];
        h[H.HEIGHT] = size[1];
        h[H.GEOMETRY_COUNT] = geometries.length;
        h[H.MESH_COUNT] = scene.meshes.length;
        h[H.MATERIAL_COUNT] = materials.length;
        h[H.LIGHT_COUNT] = lights.length;
        h[H.TEXTURE_COUNT] = textures.length;
        const gs = w.reserve(geometries.length * G.WORDS), ms = w.reserve(scene.meshes.length * MESH.WORDS), mats = w.reserve(materials.length * M.WORDS), ts = w.reserve(textures.length * T.WORDS), ls = w.reserve(lights.length * L.WORDS);
        h[H.GEOMETRY_OFFSET] = gs.at;
        h[H.MESH_OFFSET] = ms.at;
        h[H.MATERIAL_OFFSET] = mats.at;
        h[H.TEXTURE_OFFSET] = ts.at;
        h[H.LIGHT_OFFSET] = ls.at;
        h[H.CAMERA_OFFSET] = w.append(cameraWords(camera));
        geometries.forEach((g, i) => {
            const o = i * G.WORDS;
            gs.u[o + G.VERTEX_COUNT] = g.position.array.length / g.position.itemSize;
            gs.u[o + G.INDEX_COUNT] = g.indices.array.length;
            for (const [key, field] of [['position', G.POSITION], ['indices', G.INDICES], ['normal', G.NORMAL], ['uv', G.UV], ['uv1', G.UV1], ['color', G.COLOR], ['tangent', G.TANGENT], ['materialIndex', G.MATERIAL_INDEX]] as const) {
                const attr = g[key];
                if (!attr)
                    continue;
                const n = key === 'tangent' ? 4 : key === 'color' || key === 'position' || key === 'normal' ? 3 : key === 'uv' || key === 'uv1' ? 2 : 1;
                const count = attr.array.length / attr.itemSize;
                const values = attr.itemSize === n ? attr.array : Array.from({ length: count * n }, (_, j) => j % n < attr.itemSize ? attr.array[Math.floor(j / n) * attr.itemSize + j % n] : 1);
                gs.u[o + field] = w.append(values, key !== 'indices' && key !== 'materialIndex');
            }
        });
        scene.meshes.forEach((mesh, i) => { const o = i * MESH.WORDS; ms.u[o + MESH.GEOMETRY] = geometries.indexOf(mesh.geometry); ms.u[o + MESH.MATERIAL] = materials.indexOf(mesh.materials[0] as OpenPBRMaterial); ms.f.set(mesh.transform, o + MESH.TRANSFORM); ms.u[o + MESH.FLAGS] = Number(!mesh.visible); ms.u[o + MESH.MATERIAL_COUNT] = mesh.materials.length; ms.u[o + MESH.MATERIAL_TABLE] = w.append(mesh.materials.map(m => materials.indexOf(m as OpenPBRMaterial))); });
        h[H.MESH_AOV_IDS] = w.append(scene.meshes.map(m => m.aovId));
        h[H.MATERIAL_AOV_IDS] = w.append(materials.map(m => m.aovId));
        if (scene.meshes.some(m => m.instanceData)) {
            const batches = w.reserve(scene.meshes.length * 4);
            h[H.BATCH_OFFSET] = batches.at;
            scene.meshes.forEach((mesh, i) => { const data = mesh.instanceData, o = i * 4; batches.u[o] = data?.count ?? NONE; if (data) {
                batches.u[o + 1] = w.append(data.transforms, true);
                if (data.colors)
                    batches.u[o + 2] = w.append(data.colors, true);
            } });
        }
        materials.forEach((material, i) => {
            const o = i * M.WORDS;
            for (const [key, field] of [['baseColor', M.BASE_COLOR], ['specularRoughness', M.ROUGHNESS], ['baseMetalness', M.METALNESS], ['transmissionWeight', M.TRANSMISSION], ['specularIor', M.IOR], ['emissionColor', M.EMISSION_COLOR], ['emissionLuminance', M.EMISSION_LUMINANCE], ['coatWeight', M.COAT_WEIGHT], ['coatRoughness', M.COAT_ROUGHNESS], ['geometryOpacity', M.OPACITY]] as const) {
                const value = material[key];
                mats.f.set(typeof value === 'number' ? [value] : value, o + field);
            }
            mats.u[o + M.THIN_WALLED] = Number(material.geometryThinWalled);
            ['map', 'normalMap', 'metallicRoughnessMap', 'emissiveMap'].forEach((key, k) => mats.u[o + M.MAP + k] = textureId(material[key as keyof OpenPBRMaterial] as Texture | undefined, colorMaps.has(key)));
            const extensions = w.reserve(properties.length * 4);
            mats.u[o + M.EXTENSION_COUNT] = properties.length;
            mats.u[o + M.EXTENSION_OFFSET] = extensions.at;
            properties.forEach((p, j) => {
                const at = j * 4;
                extensions.u[at] = p.id;
                const value = material[(aliases[p.key] ?? p.key) as keyof OpenPBRMaterial];
                if (p.type === 'texture')
                    extensions.u[at + 1] = textureId(value as Texture | undefined, colorMaps.has(p.key));
                else if (p.type === 'bool')
                    extensions.u[at + 1] = Number(value);
                else if (p.type === 'enum')
                    extensions.u[at + 1] = ('values' in p ? p.values : [])!.indexOf(value as never);
                else
                    extensions.f.set(p.key === 'displacementStepSize' && value === 0 ? [Math.abs(material.displacementScale) > 1e-6 ? Math.abs(material.displacementScale) / 32 : .01] : typeof value === 'number' ? [value] : value as number[], at + 1);
            });
            const graph = graphData[i];
            if (graph) {
                const record = w.reserve(GRAPH.WORDS), u = record.u, ir = graph.ir;
                mats.u[o + M.GRAPH] = record.at;
                u[GRAPH.VERSION] = ir.version;
                for (const [data, count, offset, stride, floats] of [[ir.nodes, GRAPH.NODE_COUNT, GRAPH.NODES, 5, false], [ir.inputs, GRAPH.INPUT_COUNT, GRAPH.INPUTS, 5, false], [ir.terminal, GRAPH.TERMINAL_COUNT, GRAPH.TERMINALS, 3, false], [ir.parameters, GRAPH.PARAMETER_COUNT, GRAPH.PARAMETERS, 4, true], [graph.slots, GRAPH.TEXTURE_COUNT, GRAPH.TEXTURES, 1, false]] as const) {
                    u[count] = data.length / stride;
                    u[offset] = w.append(data, floats);
                }
                const ids = w.reserve(graph.normalized.nodes.length * 2);
                u[GRAPH.AUTHOR_IDS] = ids.at;
                graph.normalized.nodes.forEach((node, j) => { const text = new TextEncoder().encode(node.id); ids.u[j * 2] = w.bytes(text); ids.u[j * 2 + 1] = text.length; });
            }
        });
        const pixelOffsets = new Map<Uint8Array | Float32Array, number>();
        textures.forEach(({ texture, pixels }, i) => { const o = i * T.WORDS; ts.u[o + T.WIDTH] = texture.image.width; ts.u[o + T.HEIGHT] = texture.image.height; ts.u[o + T.STORAGE] = Number(pixels instanceof Float32Array); let offset = pixelOffsets.get(pixels); if (offset === undefined) {
            offset = pixels instanceof Float32Array ? w.append(pixels, true) : w.bytes(pixels);
            pixelOffsets.set(pixels, offset);
        } ts.u[o + T.PIXELS] = offset; ts.u[o + T.FLIP_Y] = Number(texture.flipY); ts.u[o + T.UV_CHANNEL] = texture.uvChannel; ts.f.set(texture.uvScale, o + T.UV_SCALE); ts.f.set(texture.uvOffset, o + T.UV_OFFSET); ts.u[o + T.WRAP_S] = textureWrapIndex(texture.wrapS); ts.u[o + T.WRAP_T] = textureWrapIndex(texture.wrapT); ts.u[o + T.UDIM] = Number(!!texture.udim); });
        lights.forEach((light, i) => {
            const o = i * L.WORDS;
            ls.u[o + L.TYPE] = ['RectLight', 'SphereLight', 'DirectionalLight', 'SpotLight', 'DiskLight', 'CylinderLight'].indexOf(light.type);
            ls.f.set(light.color, o + L.COLOR);
            ls.f[o + L.INTENSITY] = light.intensity;
            ls.f.set(light.transform, o + L.TRANSFORM);
            if (light.type === 'RectLight') {
                ls.f.set(light.size, o + L.SIZE);
                ls.f[o + L.SPREAD_OR_OUTER] = light.spread;
                ls.u[o + L.TEXTURE] = light.texture ? textureId(light.texture as Texture) + 1 : 0;
            }
            if ('radius' in light)
                ls.f[o + L.SIZE] = ls.f[o + L.RADIUS] = light.radius;
            if (light.type === 'SpotLight') {
                ls.f[o + L.HEIGHT_OR_INNER] = light.innerAngle;
                ls.f[o + L.SPREAD_OR_OUTER] = light.outerAngle;
                const ies = light.iesProfile;
                if (ies) {
                    const text = new TextEncoder().encode(`IESNA:LM-63-2002\nTILT=NONE\n1 1 1 ${ies.verticalAngles.length} ${ies.horizontalAngles.length} 1 1 0 0 0\n1 1 0\n${ies.verticalAngles.join(' ')}\n${ies.horizontalAngles.join(' ')}\n${ies.candelaValues.join(' ')}\n`);
                    ls.u[o + L.IES_OFFSET] = w.bytes(text);
                    ls.u[o + L.IES_BYTES] = text.length;
                }
            }
            if ('normalize' in light)
                ls.u[o + L.NORMALIZE] = Number(light.normalize);
            if (light.type === 'CylinderLight') {
                ls.f[o + L.LENGTH] = light.length;
                ls.u[o + L.TREAT_AS_LINE] = Number(light.treatAsLine);
            }
        });
        h[H.ENVIRONMENT_TEXTURE] = envId + 1;
        h[H.BACKGROUND_TEXTURE] = Array.isArray(background) ? 0 : backgroundId + 1;
        header.f.set(Array.isArray(background) ? background : [0, 0, 0, 1], H.BACKGROUND_COLOR);
        const envLight = scene.lights.find(light => light.type === 'EnvironmentLight');
        const transform = envLight?.type === 'EnvironmentLight' ? envLight.transform : undefined;
        const yaw = transform ? Math.atan2(transform[8], transform[10]) : 0;
        const described = background && !Array.isArray(background) && 'type' in background ? background : undefined;
        const bgYaw = described?.type === 'GroundedSkybox' ? described.rotation ?? 0 : described?.type === 'Equirect' && described.transform ? Math.atan2(described.transform[8], described.transform[10]) : background === undefined ? yaw : 0;
        h[H.ENVIRONMENT_SETTINGS] = w.append([1, yaw, background === undefined ? 1 : described?.intensity ?? 1, bgYaw], true);
        if (described?.type === 'GroundedSkybox')
            h[H.GROUNDED_BACKGROUND] = w.append([described.height, described.radius, described.groundHeight ?? 0, ...described.center ?? [0, 0], 0], true);
        h[H.LENGTH] = w.length;
        return w.finish();
    }
}
// Transport deltas operate on byte ranges of the SDK descriptor. The SDK still
// classifies scene changes itself; this wire layer never chooses a render plan.
export function descriptorDeltaParts(previous: Uint32Array | undefined, next: Uint32Array): Uint8Array[] {
    const spans: {
        at: number;
        data: Uint32Array;
    }[] = [];
    if (!previous || previous.length !== next.length)
        spans.push({ at: 0, data: next });
    else
        for (let at = 0; at < next.length;) {
            if (previous[at] === next[at]) {
                at++;
                continue;
            }
            const start = at++;
            while (at < next.length && (previous[at] !== next[at] || at + 1 < next.length && previous[at + 1] !== next[at + 1]))
                at++;
            spans.push({ at: start, data: next.subarray(start, at) });
        }
    const bytes = (words: Uint32Array) => new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
    return [bytes(new Uint32Array([1, Number(!previous || previous.length !== next.length), next.length, spans.length])),
        ...spans.flatMap(span => [bytes(new Uint32Array([span.at, span.data.length])), bytes(span.data)])];
}
export function descriptorDelta(previous: Uint32Array | undefined, next: Uint32Array): Uint8Array {
    const parts = descriptorDeltaParts(previous, next);
    const packet = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { packet.set(part, offset); offset += part.byteLength; }
    return packet;
}
