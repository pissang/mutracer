import Texture, {isTextureDataSource} from '../../scene/Texture.js';
import type OpenPBRMaterial from '../../scene/OpenPBRMaterial.js';
import {isProceduralSkyImage} from '../../scene/skyParameters.js';
import {createCanvas} from '../../util/canvas.js';
import {normalizeGraph} from './normalize.js';
import {planDirectMaterial, type DirectMap} from './lower.js';

const slotSources = new WeakSet<object>();
export function slotTextureSource(texture: Texture) { return slotSources.has(texture) ? texture.image : texture; }
export function slotTextureSources(textures: readonly Texture[]) {
    const images = new Set(textures.filter(texture => slotSources.has(texture)).map(texture => texture.image));
    return (texture: Texture) => images.has(texture.image) ? texture.image : texture;
}

/** GPU channel copies keep DOM images off the synchronous CPU readback path.
 * A batch uploads each source once, and releases its temporary GL resources. */
class ChannelCopy {
    private canvas = createCanvas(1, 1, true) as OffscreenCanvas;
    private gl = this.canvas.getContext('webgl2', {premultipliedAlpha: false, antialias: false}) as WebGL2RenderingContext | null;
    private sources = new Map<Texture['image'], WebGLTexture>();
    private program: WebGLProgram;
    private opacityProgram: WebGLProgram;
    private opaque = new Set<Texture['image']>();
    constructor() {
        const gl = this.gl;
        if (!gl) throw new Error('Texture channel copies require WebGL 2.');
        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Channel shader compilation failed');
            return shader;
        };
        const program = (vertexSource: string, fragmentSource: string) => {
            const vertex = compile(gl.VERTEX_SHADER, vertexSource), fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
            const result = gl.createProgram()!;
            gl.attachShader(result, vertex); gl.attachShader(result, fragment); gl.linkProgram(result);
            gl.deleteShader(vertex); gl.deleteShader(fragment);
            if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) ?? 'Channel program link failed');
            return result;
        };
        this.program = program(`#version 300 es
        void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`, `#version 300 es
        precision highp float; uniform sampler2D image; uniform ivec4 channels; out vec4 color;
        float pick(vec4 p,int c){return c==-2?1.0:c==-1?0.0:p[c];}
        void main(){ivec2 uv=ivec2(gl_FragCoord.xy);uv.y=textureSize(image,0).y-1-uv.y;vec4 p=texelFetch(image,uv,0);color=vec4(pick(p,channels.x),pick(p,channels.y),pick(p,channels.z),pick(p,channels.w));}`);
        // A one-pixel MIN reduction proves opacity without reading image-sized
        // buffers. Premultiplied Canvas resizing is not channel-linear for alpha
        // images, so those keep their graph instead of approximating it.
        this.opacityProgram = program(`#version 300 es
        precision highp float; uniform sampler2D image; out float alpha;
        void main(){ivec2 size=textureSize(image,0);alpha=texelFetch(image,ivec2(gl_VertexID%size.x,gl_VertexID/size.x),0).a;gl_Position=vec4(0,0,0,1);gl_PointSize=1.0;}`, `#version 300 es
        precision highp float; in float alpha;out vec4 color;void main(){color=vec4(alpha);}`);
    }
    copy(source: Texture['image'], channels: number[]) {
        const gl = this.gl!;
        this.canvas.width = source.width; this.canvas.height = source.height;
        let texture = this.sources.get(source);
        if (!texture) {
            texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            // Match the atlas's Canvas color conversion before permuting data
            // channels, including display-P3 images. This blit has no readback.
            const canonical = createCanvas(source.width, source.height, true) as OffscreenCanvas;
            const context = canonical.getContext('2d');
            if (!context) throw new Error('Texture channel copies require a 2D canvas.');
            context.drawImage(source as CanvasImageSource, 0, 0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canonical);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            this.sources.set(source, texture);
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (!this.opaque.has(source)) {
            this.canvas.width = 1; this.canvas.height = 1;
            gl.viewport(0, 0, 1, 1); gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(this.opacityProgram); gl.enable(gl.BLEND); gl.blendEquation(gl.MIN); gl.blendFunc(gl.ONE, gl.ONE);
            gl.drawArrays(gl.POINTS, 0, source.width * source.height);
            const minimum = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,minimum);
            gl.disable(gl.BLEND);
            if (minimum[0] !== 255) throw new Error('Alpha image channel copies retain the graph');
            this.opaque.add(source);
            this.canvas.width = source.width; this.canvas.height = source.height;
        }
        gl.useProgram(this.program);
        gl.uniform4iv(gl.getUniformLocation(this.program, 'channels'), channels);
        gl.viewport(0, 0, source.width, source.height); gl.disable(gl.DITHER); gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw new Error('Texture channel copy failed');
        const output = createCanvas(source.width, source.height, true);
        const context = output.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new Error('Texture channel copies require a 2D canvas.');
        context.drawImage(this.canvas, 0, 0);
        return output;
    }
    dispose() {
        const gl = this.gl!;
        for (const texture of this.sources.values()) gl.deleteTexture(texture);
        gl.deleteProgram(this.program); gl.deleteProgram(this.opacityProgram); gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
}

/** Cached image variants are independent of gains and sampler edits. The authored
 * Texture is never modified; its version/image invalidates all derived pixels. */
export class SlotTextures {
    private cache = new WeakMap<Texture, {image: Texture['image']; version: number; pixels: Map<string, Texture['image']>; samplers: Map<string, Texture>; rejected: Set<string>}>();
    private copier?: ChannelCopy;
    finish() { this.copier?.dispose(); this.copier = undefined; }
    private texture(source: Texture, map: DirectMap) {
        let cached = this.cache.get(source);
        if (!cached || cached.image !== source.image || cached.version !== source.version) {
            cached = {image: source.image, version: source.version, pixels: new Map(), samplers: new Map(), rejected: new Set()};
            this.cache.set(source, cached);
        }
        // Unused output components retain source bytes. Base color explicitly
        // ignores alpha, so no forced opaque channel/quantization is needed.
        const targets = ['map','normalMap','specularColorMap','fuzzColorMap'].includes(map.slot) ? [0,1,2] : map.slot === 'roughnessMap' ? [1] : map.slot === 'metalnessMap' ? [2] : ['specularWeightMap','fuzzRoughnessMap'].includes(map.slot) ? [3] : [0];
        const channels = map.channels.map((c, i) => targets.includes(i) ? c : i);
        if (!targets.includes(3)) channels[3] = -2;
        const channelKey = channels.join(',');
        if (cached.rejected.has(channelKey)) throw new Error('Unavailable channel copy');
        let image = cached.pixels.get(channelKey);
        if (!image) {
            if (channels.every((c, i) => c === i || i===3&&!targets.includes(3))) image = source.image;
            else if (isTextureDataSource(source.image)) {
                const input = source.image.data;
                const data = input.slice();
                for (let i = 0; i < data.length; i++) { const c = channels[i % 4]; data[i] = c === -2 ? (input instanceof Uint8Array || input instanceof Uint8ClampedArray ? 255 : 1) : c === -1 ? 0 : input[i - i % 4 + c]; }
                image = {...source.image, data};
            } else {
                try { image = (this.copier ??= new ChannelCopy()).copy(source.image, channels); }
                catch (error) { cached.rejected.add(channelKey); throw error; }
            }
            cached.pixels.set(channelKey, image);
        }
        const scale = map.transform.uvScale.map((v,i) => v * source.uvScale[i]) as [number,number];
        const offset = map.transform.uvOffset.map((v,i) => v * source.uvScale[i] + source.uvOffset[i]) as [number,number];
        const key = JSON.stringify([channelKey, scale, offset, map.transform.uvChannel, source.flipY, source.wrapS, source.wrapT, map.transform.colorSpace, map.slot === 'normalMap']);
        let texture = cached.samplers.get(key);
        if (!texture) {
            texture = new Texture(image);
            texture.version = source.version;
            Object.assign(texture, map.transform, {uvScale: scale, uvOffset: offset, flipY: source.flipY, wrapS: source.wrapS, wrapT: source.wrapT});
            if (map.slot === 'normalMap') texture.normalMapFrame = 'materialx';
            slotSources.add(texture);
            cached.samplers.set(key, texture);
        }
        return texture;
    }
    lower(material: OpenPBRMaterial): OpenPBRMaterial | undefined {
        const result = materialSlotPlan(material);
        if (!result) return;
        const {plan, sources} = result;
        const lowered = Object.assign(Object.create(Object.getPrototypeOf(material)), material, plan.values) as OpenPBRMaterial;
        lowered.aovId = material.aovId;
        try {
            for (const map of plan.maps) lowered[map.slot] = this.texture(sources.get(map.node)!, map);
        } catch { return; } // Preserve the graph on unavailable/failed image conversion.
        return lowered;
    }
}

/** Pure classification shared by parameter updates and resource preparation. */
export function materialSlotPlan(material: OpenPBRMaterial) {
    if (!material.graph || material.uvProjection !== 'none') return;
    const normalized = normalizeGraph(material.graph), images = new Map<string, {srgb: boolean; bounded: boolean}>(), sources = new Map<string, Texture>();
    for (const node of normalized.nodes) {
        if (node.category !== 'image' && node.category !== 'tiledimage') continue;
        const input = node.inputs.file;
        const source = input?.slot === undefined ? undefined : normalized.parameters[input.slot];
        if (!(source instanceof Texture) || source.udim || isProceduralSkyImage(source.image) || source.image.width <= 0 || source.image.height <= 0) continue;
        const data = isTextureDataSource(source.image) ? source.image.data : undefined;
        images.set(node.id, {bounded: !data || data instanceof Uint8Array || data instanceof Uint8ClampedArray, srgb: source.colorSpace ? source.colorSpace === 'srgb' : !data || data instanceof Uint8Array || data instanceof Uint8ClampedArray});
        sources.set(node.id, source);
    }
    const plan = planDirectMaterial(material.graph, images, material);
    if (!plan) return;
    // A combined map would multiply the replacement scalar a second time.
    if (material.metallicRoughnessMap && ('specularRoughness' in plan.values || 'baseMetalness' in plan.values)) return;
    if ('baseColor' in plan.values && material.map && material.mapAlphaUsage !== 'opaque') return;
    if ('transmissionWeight' in plan.values &&
        (!material.thinWalled && material.transmissionDepth > 0 || material.map && material.mapAlphaUsage === 'transmission')) return;
    // Graph roughness overrides the earlier glTF conversion; an ordinary slot
    // feeds that conversion instead, so these contexts cannot share a slot.
    if ('specularRoughness' in plan.values && material.specularAnisotropy > 0 &&
        (material.specularAnisotropyModel === 'gltf' || material.anisotropyMap)) return;
    return {plan, sources};
}
