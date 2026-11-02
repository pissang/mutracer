import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { first, scalar, type Entity, type Params, type Scene } from './scene';
import { blackbody, namedSpectrum, sample, spectralRGB } from './spectrum';
import { resolvePath, type Resolver, type Warning } from './source';
export interface Image { width: number; height: number; data: Float32Array | Uint8Array | Uint8ClampedArray }
export type DecodeImage = (bytes: ArrayBuffer, path: string) => Promise<Image>;
export interface TextureValue { color: number[]; map?: THREE.DataTexture }
export class Textures {
  private cache = new Map<string, Promise<TextureValue>>();
  constructor(private scene: Scene, private resolver: Resolver, private warn: (entity: Entity, handling: string, code?: string) => void, private decode?: DecodeImage) {}
  async image(path: string): Promise<Image> {
    const bytes = await this.resolver.read(resolvePath(path, this.scene.entry));
    if (/\.exr$/i.test(path)) {
      const image = new EXRLoader().setDataType(THREE.FloatType).parse(bytes);
      if (!image.width || !image.height) throw new Error(`Invalid EXR ${path}`);
      // EXRLoader returns bottom-up rows; use top-down throughout this module.
      const data = new Float32Array(image.data!.length), input = image.data as Float32Array;
      for (let y = 0; y < image.height; y++) data.set(input.subarray(y * image.width * 4, (y + 1) * image.width * 4), (image.height - y - 1) * image.width * 4);
      return { width: image.width, height: image.height, data };
    }
    if (/\.tga$/i.test(path)) { const image = new TGALoader().parse(bytes); return { width: image.width!, height: image.height!, data: new Uint8Array(image.data!) }; }
    if (/\.tiff?$/i.test(path)) { const image = new TIFFLoader().parse(bytes); return { width: image.width!, height: image.height!, data: new Uint8Array(image.data!) }; }
    if (!this.decode) throw new Error(`An image decoder is required for ${path}`);
    return this.decode(bytes, path);
  }
  async value(p: Params, key: string, fallback: number[], owner: Entity, stack = new Set<string>()): Promise<TextureValue> {
    const parameter = p[key];
    if (!parameter) return { color: fallback };
    if (parameter.type === 'texture') return this.named(String(parameter.values[0]), owner, stack, ['alpha', 'roughness', 'uroughness', 'vroughness', 'amount', 'displacement', 'scale'].includes(key) || owner.loc.kind === 'Texture' && owner.loc.args[1] === 'float' ? 'float' : 'spectrum');
    if (parameter.type === 'blackbody') {
      const color = blackbody(Number(parameter.values[0]));
      const y = .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
      return { color: /LightSource$/.test(owner.loc.kind) ? color.map(v => v / y) : color };
    }
    if (parameter.type === 'spectrum') {
      const value = parameter.values[0];
      let curve = typeof value === 'string' ? namedSpectrum(value) : parameter.values.map(Number);
      if (!curve && typeof value === 'string' && /\.(spd|txt)$/i.test(value)) {
        const text = new TextDecoder().decode(await this.resolver.read(resolvePath(value, this.scene.entry)));
        curve = text.replace(/#[^\n]*/g, '').trim().split(/\s+/).map(Number);
      }
      if (!curve) { this.warn(owner, `Unknown spectrum ${value}; uses ${fallback}`, 'spectrum'); return { color: fallback }; }
      const emission = /LightSource$/.test(owner.loc.kind), color = spectralRGB(w => sample(curve!, w), !emission);
      const y = .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
      return { color: emission && y > 0 ? color.map(v => v / y) : color };
    }
    const values = parameter.values.map(Number);
    return { color: values.length === 1 ? [values[0], values[0], values[0]] : values.slice(0, 3) };
  }
  private async named(name: string, owner: Entity, stack: Set<string>, kind: 'float' | 'spectrum'): Promise<TextureValue> {
    const identity = `${kind}:${name}`;
    if (stack.has(identity)) throw new Error(`Cyclic texture ${name}`);
    if (this.cache.has(identity)) return this.cache.get(identity)!;
    const next = new Set(stack).add(identity);
    const entity = this.scene.textures[identity] ?? this.scene.textures[name];
    if (!entity) throw new Error(`${owner.loc.file}:${owner.loc.line}: Undefined texture ${name}`);
    const promise = this.create(entity, next);
    this.cache.set(identity, promise); return promise;
  }
  private async create(entity: Entity, stack: Set<string>): Promise<TextureValue> {
    const p = entity.params;
    const handled = ['filename', 'encoding', 'invert', 'scale', 'uscale', 'vscale', 'udelta', 'vdelta', 'wrap', 'mapping', 'value', 'tex', 'tex1', 'tex2'];
    for (const key of Object.keys(p)) if (!handled.includes(key)) this.warn(entity, `Texture parameter ${key} ignored`, 'texture');
    if (entity.type === 'constant') return this.value(p, 'value', [1, 1, 1], entity, stack);
    if (entity.type === 'scale') {
      const tex = await this.value(p, p.tex ? 'tex' : 'tex1', [1, 1, 1], entity, stack);
      const factor = await this.value(p, p.scale ? 'scale' : 'tex2', [1, 1, 1], entity, stack);
      if (factor.map) this.warn(entity, 'Spatial scale texture averaged to a constant', 'texture');
      return this.multiply(tex, this.average(factor));
    }
    if (entity.type === 'checkerboard') {
      const a = await this.value(p, 'tex1', [1, 1, 1], entity, stack), b = await this.value(p, 'tex2', [0, 0, 0], entity, stack);
      if (a.map || b.map) this.warn(entity, 'Checkerboard child textures averaged', 'texture');
      const ac = this.average(a), bc = this.average(b);
      const data = new Float32Array([...ac, 1, ...bc, 1, ...bc, 1, ...ac, 1]);
      const map = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat, THREE.FloatType);
      map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(scalar(p, 'uscale', 1) / 2, scalar(p, 'vscale', 1) / 2);
      map.offset.set(scalar(p, 'udelta', 0) / 2, scalar(p, 'vdelta', 0) / 2); map.needsUpdate = true;
      return { color: [1, 1, 1], map };
    }
    if (entity.type === 'imagemap') {
      const filename = String(first(p, 'filename', '')), image = await this.image(filename);
      const data = new Float32Array(image.width * image.height * 4);
      const encoding = String(first(p, 'encoding', /\.png$/i.test(filename) ? 'sRGB' : 'linear')).toLowerCase();
      if (!['linear', 'srgb'].includes(encoding) && !/^gamma\s+[\d.]+$/.test(encoding)) this.warn(entity, `Encoding ${encoding} treated as linear`, 'texture');
      const invert = first(p, 'invert', false), scale = scalar(p, 'scale', 1), bytes = !(image.data instanceof Float32Array);
      for (let i = 0; i < data.length; i++) {
        let value = image.data[i] / (bytes ? 255 : 1);
        if (i % 4 < 3) {
          if (encoding === 'srgb') value = value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4);
          else if (encoding.startsWith('gamma')) value = Math.pow(value, Number(encoding.split(/\s+/)[1]) || 2.2);
          value *= scale;
          if (invert) value = Math.max(0, 1 - value);
        }
        data[i] = value;
      }
      const isFloat = entity.loc.args[1] === 'float';
      const sourceScale = image.data instanceof Float32Array ? 1 : 255;
      const hasAlpha = isFloat && image.data.some((value, i) => i % 4 === 3 && value !== sourceScale);
      for (let i = 0; i < data.length; i += 4) {
        if (isFloat) {
          // PBRT drops all-opaque alpha. Float image lookup then averages RGB,
          // otherwise it samples alpha; invert follows scaling.
          const linear = (c: number) => {
            let v = image.data[i + c] / sourceScale;
            if (encoding === 'srgb') v = v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
            else if (encoding.startsWith('gamma')) v = Math.pow(v, Number(encoding.split(/\s+/)[1]) || 2.2);
            return v;
          };
          let value = scale * (hasAlpha ? image.data[i + 3] / sourceScale : (linear(0) + linear(1) + linear(2)) / 3);
          if (invert) value = Math.max(0, 1 - value);
          data[i] = data[i + 1] = data[i + 2] = value;
        }
        data[i + 3] = 1;
      }
      const map = new THREE.DataTexture(data, image.width, image.height, THREE.RGBAFormat, THREE.FloatType);
      // PBRT ImageTexture evaluates (s, 1-t). Image data here starts at the top.
      map.flipY = true;
      map.repeat.set(scalar(p, 'uscale', 1), scalar(p, 'vscale', 1)); map.offset.set(scalar(p, 'udelta', 0), scalar(p, 'vdelta', 0));
      const wrap = String(first(p, 'wrap', 'repeat'));
      if (!['repeat', 'clamp', 'black'].includes(wrap)) this.warn(entity, `Wrap ${wrap} uses repeat`, 'texture');
      map.wrapS = map.wrapT = wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      if (wrap === 'black') this.warn(entity, 'Black border wrapping approximated by clamp', 'texture');
      if (wrap === 'black') map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      if (p.mapping && first(p, 'mapping', 'uv') !== 'uv') this.warn(entity, 'Non-UV image mapping uses mesh UVs', 'texture');
      map.needsUpdate = true; return { color: [1, 1, 1], map };
    }
    const a = await this.value(p, 'tex1', [.5, .5, .5], entity, stack), b = await this.value(p, 'tex2', [.5, .5, .5], entity, stack);
    this.warn(entity, `${entity.type} texture replaced by its constant mean`, 'texture');
    return { color: this.average(a).map((v, i) => (v + this.average(b)[i]) / 2) };
  }
  private average(value: TextureValue): number[] {
    if (!value.map) return value.color;
    const data = value.map.image.data as Float32Array, sum = [0, 0, 0];
    for (let i = 0; i < data.length; i++) if (i % 4 < 3) sum[i % 4] += data[i];
    return sum.map((v, c) => v / (data.length / 4) * value.color[c]);
  }
  private multiply(value: TextureValue, factor: number[]): TextureValue {
    if (!value.map) return { color: value.color.map((v, i) => v * factor[i]) };
    const map = value.map.clone(), input = value.map.image.data as Float32Array, data = new Float32Array(input);
    for (let i = 0; i < data.length; i++) if (i % 4 < 3) data[i] *= factor[i % 4];
    map.image = { ...value.map.image, data }; map.needsUpdate = true; return { color: value.color, map };
  }
}
export type { Warning };
