import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { first, scalar, type Entity, type Params, type Scene } from './scene';
import { blackbody, namedSpectrum, sample, spectralRGB } from './spectrum';
import { resolvePath, type Resolver, type Warning } from './source';
import type { Parameter } from './parser';
export interface Image { width: number; height: number; data: Float32Array | Uint8Array | Uint8ClampedArray }
export type DecodeImage = (bytes: ArrayBuffer, path: string) => Promise<Image>;
export interface TextureValue { color: number[]; map?: THREE.DataTexture }
export class Textures {
  private cache = new Map<string, Promise<TextureValue>>();
  private images = new Map<string, Promise<Image>>();
  private heightMaps = new WeakMap<THREE.DataTexture, THREE.DataTexture>();
  private bumpMaps = new WeakMap<THREE.DataTexture, Map<number, THREE.DataTexture>>();
  private spectra = new Map<string, Promise<number[]>>();
  constructor(private scene: Scene, private resolver: Resolver, private warn: (entity: Entity, handling: string, code?: string) => void, private decode?: DecodeImage) {}
  image(path: string): Promise<Image> {
    const key = resolvePath(path, this.scene.entry);
    if (!this.images.has(key)) this.images.set(key, this.decodeFile(path));
    return this.images.get(key)!;
  }
  async spectrum(parameter: Parameter): Promise<number[] | undefined> {
    const value = parameter.values[0];
    if (typeof value !== 'string') return Array.from(parameter.values, Number);
    const named = namedSpectrum(value); if (named) return named;
    if (!/\.(spd|txt)$/i.test(value)) return undefined;
    const path = resolvePath(value, this.scene.entry);
    if (!this.spectra.has(path)) this.spectra.set(path, (async () => {
      const text = new TextDecoder().decode(await this.resolver.read(path));
      const curve = text.replace(/#[^\n]*/g, '').trim().split(/\s+/).map(Number);
      if (curve.length < 4 || curve.length % 2 || curve.some(v => !Number.isFinite(v))) throw new Error(`Invalid spectrum ${path}`);
      return curve;
    })());
    return this.spectra.get(path)!;
  }
  private async decodeFile(path: string): Promise<Image> {
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
      const curve = await this.spectrum(parameter);
      if (!curve) { this.warn(owner, `Unknown spectrum ${value}; uses ${fallback}`, 'spectrum'); return { color: fallback }; }
      const emission = /LightSource$/.test(owner.loc.kind), color = spectralRGB(w => sample(curve!, w), !emission);
      const y = .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
      return { color: emission && y > 0 ? color.map(v => v / y) : color };
    }
    const values = Array.from(parameter.values, Number);
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
      const encoding = String(first(p, 'encoding', /\.png$/i.test(filename) ? 'sRGB' : 'linear')).toLowerCase();
      if (!['linear', 'srgb'].includes(encoding) && !/^gamma\s+[\d.]+$/.test(encoding)) this.warn(entity, `Encoding ${encoding} treated as linear`, 'texture');
      const invert = first(p, 'invert', false), scale = scalar(p, 'scale', 1), bytes = !(image.data instanceof Float32Array);
      if (entity.loc.args[1] !== 'float' && !invert && scale >= 0 && scale <= 1 && (bytes && ['srgb', 'linear'].includes(encoding) || !bytes && encoding === 'linear')) {
        // Keep the source precision and let the existing texture color-space
        // path decode RGB. This avoids a fourfold CPU expansion and copies.
        let data = image.data; const alpha = bytes ? 255 : 1;
        if (data.some((v, i) => i % 4 === 3 && v !== alpha)) {
          data = bytes ? new Uint8Array(data) : new Float32Array(data); for (let i = 3; i < data.length; i += 4) data[i] = alpha;
        }
        const map = new THREE.DataTexture(data, image.width, image.height, THREE.RGBAFormat, bytes ? THREE.UnsignedByteType : THREE.FloatType);
        map.colorSpace = encoding === 'srgb' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
        return this.mapValue(map, p, entity, [scale, scale, scale]);
      }
      const data = new Float32Array(image.width * image.height * 4);
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
      return this.mapValue(map, p, entity);
    }
    const a = await this.value(p, 'tex1', [.5, .5, .5], entity, stack), b = await this.value(p, 'tex2', [.5, .5, .5], entity, stack);
    this.warn(entity, `${entity.type} texture replaced by its constant mean`, 'texture');
    return { color: this.average(a).map((v, i) => (v + this.average(b)[i]) / 2) };
  }
  private mapValue(map: THREE.DataTexture, p: Params, entity: Entity, color = [1, 1, 1]): TextureValue {
    // PBRT ImageTexture evaluates (s, 1-t). Image data here starts at the top.
    map.flipY = true;
    map.repeat.set(scalar(p, 'uscale', 1), scalar(p, 'vscale', 1)); map.offset.set(scalar(p, 'udelta', 0), scalar(p, 'vdelta', 0));
    const wrap = String(first(p, 'wrap', 'repeat'));
    if (!['repeat', 'clamp', 'black'].includes(wrap)) this.warn(entity, `Wrap ${wrap} uses repeat`, 'texture');
    map.wrapS = map.wrapT = wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (wrap === 'black') this.warn(entity, 'Black border wrapping approximated by clamp', 'texture');
    if (wrap === 'black') map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    if (p.mapping && first(p, 'mapping', 'uv') !== 'uv') this.warn(entity, 'Non-UV image mapping uses mesh UVs', 'texture');
    map.needsUpdate = true; return { color, map };
  }
  bumpMap(value: TextureValue): THREE.DataTexture | null {
    const source = value.map;
    if (!source) return null;
    const scale = value.color[0];
    let variants = this.bumpMaps.get(source);
    if (!variants) { variants = new Map(); this.bumpMaps.set(source, variants); }
    if (variants.has(scale)) return variants.get(scale)!;
    const { width, height } = source.image;
    const input = source.image.data!;
    const data = new Float32Array(width * height * 4);
    const wrap = (i: number, size: number, mode: THREE.Wrapping) => mode === THREE.RepeatWrapping
      ? ((i % size) + size) % size : Math.min(size - 1, Math.max(0, i));
    const sample = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      let value = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const offset = (wrap(iy + dy, height, source.wrapT) * width + wrap(ix + dx, width, source.wrapS)) * 4;
        value += input[offset] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      }
      return value * scale;
    };
    // PBRT materials.h::BumpMap uses forward UV differences; .0005 is its
    // fallback when ray differentials vanish. A static bake cannot reproduce
    // per-hit footprints, dpdu/dpdv lengths, or displace*dndu/dndv curvature.
    const du = .0005, dv = .0005;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const h = sample(x, y);
      const dhdu = (sample(x + du * source.repeat.x * width, y) - h) / du;
      const dhdv = (sample(x, y + dv * source.repeat.y * height * (source.flipY ? -1 : 1)) - h) / dv;
      const length = Math.hypot(dhdu, dhdv, 1), offset = (y * width + x) * 4;
      data.set([.5 - dhdu / (2 * length), .5 - dhdv / (2 * length), .5 + 1 / (2 * length), 1], offset);
    }
    const map = source.clone(); map.source = new THREE.Source({ width, height, data });
    map.colorSpace = THREE.NoColorSpace; map.needsUpdate = true;
    variants.set(scale, map); return map;
  }
  heightMap(source: THREE.DataTexture, owner: Entity): THREE.DataTexture {
    const { width, height } = source.image;
    const size = 2 ** Math.ceil(Math.log2(Math.max(width, height)));
    if (width === height && width === size) return source;
    const previous = this.heightMaps.get(source); if (previous) return previous;
    if (size > 8192) throw new Error('Displacement image exceeds the 8192-pixel texture limit');
    const input = source.image.data as Float32Array, data = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const px = (x + .5) / size * width - .5, py = (y + .5) / size * height - .5;
      const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = Math.min(width - 1, Math.max(0, ix + dx)), yy = Math.min(height - 1, Math.max(0, iy + dy));
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        for (let c = 0; c < 4; c++) data[(y * size + x) * 4 + c] += input[(yy * width + xx) * 4 + c] * weight;
      }
    }
    const result = source.clone(); result.source = new THREE.Source({ width: size, height: size, data }); result.needsUpdate = true;
    this.heightMaps.set(source, result); this.warn(owner, `Height image resampled to ${size}×${size} for the supported displacement layout`, 'displacement'); return result;
  }
  average(value: TextureValue): number[] {
    if (!value.map) return value.color;
    const data = value.map.image.data!, sum = [0, 0, 0], bytes = !(data instanceof Float32Array);
    for (let i = 0; i < data.length; i++) if (i % 4 < 3) {
      let v = data[i] / (bytes ? 255 : 1);
      if (value.map.colorSpace === THREE.SRGBColorSpace) v = v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
      sum[i % 4] += v;
    }
    return sum.map((v, c) => v / (data.length / 4) * value.color[c]);
  }
  private multiply(value: TextureValue, factor: number[]): TextureValue {
    return { color: value.color.map((v, i) => v * factor[i]), map: value.map };
  }
}
export type { Warning };
