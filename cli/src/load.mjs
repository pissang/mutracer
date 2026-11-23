import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {parseMaterialX} from '../../src/materialx.ts';
import Texture from '../../src/scene/Texture.ts';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.ts';


function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function read(source, base, dependencies) {
  const url = new URL(source, base);
  if (url.protocol === 'data:') {
    const response = await fetch(url);
    return Buffer.from(await response.arrayBuffer());
  }
  if (url.protocol !== 'file:') throw new Error(`Only local assets are supported: ${url.href}`);
  const file = fileURLToPath(url);
  const bytes = await readFile(file);
  dependencies.set(file, createHash('sha256').update(bytes).digest('hex'));
  return bytes;
}

export function loaders(worker, moduleUrl, dependencies) {
  async function image(bytes, hdr) {
    const {header, bytes: pixels} = await worker.request('decode', {format: hdr ? 'hdr' : 'image'}, bytes);
    const data = hdr ? new Float32Array(toArrayBuffer(pixels)) : Uint8Array.from(pixels);
    const texture = new THREE.DataTexture(data, header.width, header.height, THREE.RGBAFormat,
        hdr ? THREE.FloatType : THREE.UnsignedByteType);
    texture.colorSpace = hdr ? THREE.LinearSRGBColorSpace : THREE.NoColorSpace;
    texture.needsUpdate = true;
    if (hdr) texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }

  async function materialX(source, {materialName} = {}) {
    const inline = typeof source === 'object' && source !== null && !(source instanceof URL);
    const url = inline ? moduleUrl : new URL(source, moduleUrl);
    const xml = inline ? source.source : (await read(url, moduleUrl, dependencies)).toString('utf8');
    if (typeof xml !== 'string') throw new Error('Supply a MaterialX path, URL or {source: xml}.');
    const parsed = parseMaterialX(xml, materialName);
    if (parsed.warnings.length) throw new Error(`${url.href}: ${parsed.warnings.join('; ')}`);
    if (parsed.displacement?.graph) throw new Error(`${url.href}: use a displacementMap for MaterialX displacement.`);
    if (parsed.graph) {
      const used = new Set(normalizeGraph(parsed.graph).nodes.map(node => node.id));
      for (const [id, reference] of parsed.images) {
        if (!used.has(id)) continue;
        const decoded = await image(await read(reference.file, url, dependencies), false);
        const texture = new Texture(decoded.image);
        texture.colorSpace = reference.srgb ? 'srgb' : 'linear';
        if (reference.wrapS) texture.wrapS = reference.wrapS;
        if (reference.wrapT) texture.wrapT = reference.wrapT;
        parsed.graph.setInput(id, 'file', {type:'filename', value:texture});
      }
    }
    return parsed;
  }

  return {
    materialX,
    texture: async path => image(await read(path, moduleUrl, dependencies), false),
    hdr: async path => image(await read(path, moduleUrl, dependencies), true),
    gltf: async path => {
      const url = new URL(path, moduleUrl);
      const bytes = await read(url, moduleUrl, dependencies);
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      const errors = [];
      loader.register(parser => {
        const loadBuffer = parser.loadBuffer.bind(parser);
        parser.loadBuffer = index => {
          const uri = parser.json.buffers[index].uri;
          return uri === undefined ? loadBuffer(index) : read(uri, url, dependencies).then(toArrayBuffer);
        };
        const textures = new Map();
        parser.loadImageSource = async index => {
          if (!textures.has(index)) {
            textures.set(index, (async () => {
              const source = parser.json.images[index];
              const pixelBytes = source.bufferView === undefined
                ? await read(source.uri, url, dependencies)
                : Buffer.from(await parser.getDependency('bufferView', source.bufferView));
              return image(pixelBytes, false);
            })());
          }
          try { return (await textures.get(index)).clone(); } catch (error) {
            errors.push(new Error(`${url.href} /images/${index}: ${error.message}`));
            throw error;
          }
        };
        return {name: 'mutracer-native-images'};
      });
      const gltf = await loader.parseAsync(toArrayBuffer(bytes), new URL('.', url).href);
      if (errors.length) throw errors[0];
      return gltf;
    }
  };
}
