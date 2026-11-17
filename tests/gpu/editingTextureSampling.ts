import Texture, {isTextureDataSource} from '../../src/scene/Texture.js';
import UdimTexture from '../../src/scene/UdimTexture.js';
import Material from '../../src/scene/OpenPBRMaterial.js';
import MaterialTable from '../../src/renderer/MaterialTable.js';
import {createMaterialBufferWgsl} from '../../src/renderer/wgsl/chunks/materialBuffer.wgsl.js';
import {constants} from '../../src/renderer/webgl.js';

/** Compare the universal filter with the unchanged scalar filter, including
 * coordinates outside the image, mixed wrap axes, narrow images and UDIMs. */
export async function runEditingTextureSampling(identifiers: readonly (readonly [string, string])[] = []) {
  const names = new Map(identifiers), name = (value: string) => names.get(value) ?? value;
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw Error('Texture sampling regression requires WebGPU');
  const device = await adapter.requestDevice(), rows = [];
  const modes = ['repeat', 'clamp-to-edge', 'mirrored-repeat'] as const;
  const coordinates = [-11, -2, -1.01, -1, -1e-5, 0, 1e-5, .125, .5, .875, 1 - 1e-5, 1, 1 + 1e-5, 2, 10, 10 + 1e-5, 21];
  try {
    for (const floating of [false, true]) {
      const image = (width: number, height: number) => ({width, height, data: floating
        ? Float32Array.from({length: width * height * 4}, (_, k) => k % 4 === 3 ? .75 : ((k * 17) % 31 - 8) / 4)
        : Uint8Array.from({length: width * height * 4}, (_, k) => (k * 53 + 17) % 256)});
      const textures: Texture[] = [];
      for (const [width, height] of [[1, 1], [1, 4], [4, 1], [3, 2], [8, 5]]) {
        for (const wrapS of modes) for (const wrapT of modes) {
          const texture = new Texture(image(width, height));
          texture.wrapS = wrapS; texture.wrapT = wrapT;
          texture.uvScale = [2.3, -1.7]; texture.uvOffset = [-.35, .1];
          textures.push(texture);
        }
      }
      textures.push(new UdimTexture([{udim: 1001, image: image(3, 2)}, {udim: 1002, image: image(1, 4)}, {udim: 1011, image: image(2, 3)}]));
      const transformed = new UdimTexture([{udim: 1001, image: image(2, 2)}, {udim: 1003, image: image(3, 1)}]);
      transformed.uvScale = [2, 1]; transformed.uvOffset = [1, 0]; textures.push(transformed);
      const table = new MaterialTable(textures.map(map => new Material({map})), []), maps = table.texture!;
      const half = maps.storageType === constants.HALF_FLOAT;
      if (half !== floating) throw Error('Unexpected sampler fixture storage format');
      const texture = device.createTexture({format: half ? 'rgba16float' : 'rgba8unorm',
        size: [maps.width, maps.height, Math.max(2, maps.source!.length)],
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
      const buffers: GPUBuffer[] = [];
      try {
        maps.source!.forEach((source: HTMLCanvasElement, layer: number) => {
          if (isTextureDataSource(source)) device.queue.writeTexture({texture, origin: [0, 0, layer]}, source.data,
            {bytesPerRow: source.width * (half ? 8 : 4)}, [source.width, source.height]);
          else device.queue.copyExternalImageToTexture({source}, {texture, origin: [0, 0, layer]}, [maps.width, maps.height]);
        });
        const data = table.bufferData, count = Math.max(20, Math.ceil(data.mapInfo.length / 40) * 10);
        if (data.diffuseMapIndex.some(index => index < 0)) throw Error('Missing sampler test texture');
        const metadata = new Float32Array(count * 12);
        metadata.set(data.mapInfo); metadata.set(data.mapTransform, count * 4);
        for (let i = 0; i < data.mapInfo.length / 4; i++) metadata.set(
          [data.mapUvChannel[i], data.mapColorLinear[i], ...data.mapWrap.slice(i * 2, i * 2 + 2)], count * 8 + i * 4);
        const queries = new Float32Array(textures.length * coordinates.length ** 2 * 4);
        let at = 0;
        for (let i = 0; i < textures.length; i++) for (const u of coordinates) for (const v of coordinates) {
          queries.set([u, v, data.diffuseMapIndex[i], 0], at); at += 4;
        }
        const info = device.createBuffer({size: metadata.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
        const input = device.createBuffer({size: queries.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
        buffers.push(info, input); device.queue.writeBuffer(info, 0, metadata); device.queue.writeBuffer(input, 0, queries);
        const images: Float32Array[] = [];
        for (const universal of [false, true]) {
          const helpers = createMaterialBufferWgsl(universal ? {materialHooks: {graph: {declarations: '', evaluate: '', opacity: false, textureLoop: true}}} : {});
          const start = helpers.indexOf('fn ' + name('sRGBToLinear') + '('), end = helpers.indexOf('fn ' + name('getMaterialEmission') + '(');
          if (start < 0 || end <= start) throw Error('Missing texture sampler fragment');
          const code = `const ${name('NUM_MAPS')}=${count}; const ${name('USE_UDIM_MAPS')}=true;
@group(1) @binding(0) var ${name('mapSampler')}: sampler;
@group(1) @binding(1) var ${name('map')}: texture_2d_array<f32>;
@group(1) @binding(3) var<uniform> ${name('mapInfo')}: array<vec4f, ${name('NUM_MAPS')} * 3>;
${helpers.slice(start, end)}
@group(0) @binding(0) var<storage,read> fixtureQueries:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> fixtureOutput:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&fixtureQueries)){return;}
 let q=fixtureQueries[id.x];fixtureOutput[id.x]=${name('sampleMap')}(i32(q.z),q.xy);
}`;
          const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code})}});
          const output = device.createBuffer({size: queries.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
          const read = device.createBuffer({size: queries.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}); buffers.push(output, read);
          const inputs = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: input}}, {binding: 1, resource: {buffer: output}}]});
          const atlas = device.createBindGroup({layout: pipeline.getBindGroupLayout(1), entries: [{binding: 0, resource: device.createSampler({minFilter: 'linear', magFilter: 'linear'})}, {binding: 1, resource: texture.createView()}, {binding: 3, resource: {buffer: info}}]});
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
          pass.setBindGroup(0, inputs); pass.setBindGroup(1, atlas); pass.dispatchWorkgroups(Math.ceil(queries.length / 4 / 64)); pass.end();
          encoder.copyBufferToBuffer(output, 0, read, 0, queries.byteLength); device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ); images.push(new Float32Array(read.getMappedRange()).slice()); read.unmap();
        }
        const a = new Uint32Array(images[0].buffer), b = new Uint32Array(images[1].buffer);
        for (let textureIndex = 0; textureIndex < textures.length; textureIndex++) {
          const begin = textureIndex * coordinates.length ** 2 * 4;
          const values = images[0].subarray(begin, begin + coordinates.length ** 2 * 4);
          if (!values.some((value, i) => i % 4 !== 3 && Math.abs(value) > 1e-6)) throw Error('Sampler fixture produced no color: ' + textureIndex);
        }
        const bitDifferent = a.reduce((n, value, i) => n + Number(value !== b[i]), 0);
        const nonfinite = images.some(image => image.some(value => !Number.isFinite(value)));
        const row = {format: half ? 'rgba16float' : 'rgba8unorm', samples: queries.length / 4, bitDifferent, nonfinite}; rows.push(row);
        if (bitDifferent || nonfinite) throw Error(JSON.stringify(row));
      } finally { texture.destroy(); buffers.forEach(buffer => buffer.destroy()); }
    }
    return {kind: 'texture-sampler', rows};
  } finally { device.destroy(); }
}
