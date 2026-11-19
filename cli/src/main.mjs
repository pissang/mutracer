import {createHash} from 'node:crypto';
import {mkdir, open, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import * as THREE from 'three';
import * as mutracer from '../../src/main.ts';
import {THREESync, fromTHREECamera} from '../../src/three.ts';
import {HEADER as H} from '../../native/src/layout.ts';
import {NativeSceneEncoder} from '../../viewer/src/engine/nativeScene.ts';
import {loaders} from './load.mjs';
import {strictConversion} from './strict.mjs';
import {NativeError, Worker, nativeCommand} from './worker.mjs';

const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const digest = data => createHash('sha256').update(data).digest('hex');
const hashJson = object => digest(JSON.stringify(object));
const number = (value, label, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer in [${min}, ${max}].`);
  return n;
};

function args() {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      output: {type: 'string', short: 'o'}, help: {type: 'boolean', short: 'h'},
      size: {type: 'string'}, spp: {type: 'string'}, fps: {type: 'string'}, frames: {type: 'string'},
      t: {type: 'string'}, seed: {type: 'string'}, denoise: {type: 'string'}, tracer: {type: 'string'},
      'keep-frames': {type: 'string'}, 'contact-sheet': {type: 'string'},
    },
  });
  if (values.help) return {};
  const [command, file] = positionals;
  if (positionals.length !== 2 || !['validate','still','preview','render'].includes(command)) {
    throw new Error('Usage: mutracer-js validate|still|preview|render SHOT.mjs [-o FILE]');
  }
  if (command !== 'validate' && !values.output) throw new Error('Specify -o FILE.');
  return {command, file: resolve(file), values};
}

function options(input, command, values) {
  if (!input || !Number.isFinite(input.duration) || input.duration <= 0) throw new Error('Export output.duration as a positive number of seconds.');
  const preview = command === 'preview';
  const fps = number(values.fps ?? input.fps ?? 24, 'fps', 1, 240);
  const duration = input.duration;
  const count = Math.ceil(fps * duration);
  if (count > 100000) throw new Error('A shot can contain at most 100000 frames.');
  const size = values.size ? values.size.split(/[xX]/) : preview ? [384,216] : input.size ?? [1280,720];
  if (!Array.isArray(size) || size.length !== 2) throw new Error('Expected a frame size WxH.');
  const [w,h] = size.map(edge => number(edge, 'Frame edge', 1, 8192));
  if (w * h > 16777216 || (command === 'render' || preview) && (w % 2 || h % 2)) {
    throw new Error('Use at most 16777216 pixels and even edges for MP4.');
  }
  const spp = number(values.spp ?? (preview ? 8 : input.spp ?? 32), 'spp', 1, 16384);
  const seed = values.seed ?? input.seed ?? 'fixed';
  if (!['fixed','frame'].includes(seed)) throw new Error('Use --seed fixed or frame.');
  const denoise = values.denoise ?? (preview ? 'none' : input.denoise ?? 'oidn');
  if (!['oidn','none'].includes(denoise)) throw new Error('Use --denoise oidn or none.');
  const tracer = values.tracer ?? input.tracer ?? 'hardware';
  if (!['hardware','software'].includes(tracer)) throw new Error('Use --tracer hardware or software.');
  const seedValue = number(input.seedValue ?? 12345, 'seedValue', 0, 0xffffffff);
  const offset = number(input.sampleSequenceOffset ?? 0, 'sampleSequenceOffset', 0, 0xffffffff);
  if (offset + spp > 0x100000000) throw new Error('Sequence range exceeds 32-bit sample indices.');
  if (values.frames !== undefined && !/^\d+(?:-\d+)?$/.test(values.frames)) {
    throw new Error('Expected --frames N or A-B (inclusive).');
  }
  const range = values.frames?.split('-') ?? [0,count-1];
  const first = number(range[0],'Frame',0,count-1);
  const last = number(range[1] ?? first,'Frame',0,count-1);
  if (first > last) throw new Error('Frame range starts after it ends.');
  const time = Number(values.t ?? 0);
  if (command === 'still' && (!Number.isFinite(time) || time < 0 || time > duration)) throw new Error('Still time must be within the shot.');
  return {duration, fps, first, last, time, stride: preview ? 2 : 1,
    settings: {size:[w,h], spp, seed, denoise, seedValue, sampleSequenceOffset:offset, tracer}};
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state,1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function approximateLegacy(material) {
  if (!material.isMeshLambertMaterial && !material.isMeshPhongMaterial) return;
  if (Object.keys(material).some(key => /map$/i.test(key) && material[key]?.isTexture)) return;
  return new mutracer.OpenPBRMaterial({
    baseColor: material.color.toArray(),
    specularRoughness: material.isMeshPhongMaterial ? Math.sqrt(2 / (Math.max(0, material.shininess) + 2)) : 1,
    specularColor: material.isMeshPhongMaterial ? material.specular.toArray() : [1,1,1],
    specularWeight: material.isMeshLambertMaterial ? 0 : 1,
    geometryOpacity: material.opacity,
    alphaMode: material.transparent ? 'blend' : 'auto',
    emissionColor: material.emissive.toArray(), emissionLuminance: material.emissiveIntensity,
  });
}

function normalizeAovIds(bytes) {
  for (const [offset,count] of [[H.MESH_AOV_IDS,H.MESH_COUNT],[H.MATERIAL_AOV_IDS,H.MATERIAL_COUNT]]) {
    if (bytes[offset]) {
      for (let i = 0; i < bytes[count]; i++) bytes[bytes[offset] + i] = i + 1;
    }
  }
  return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
}

async function prepare(module, url, worker, settings) {
  if (typeof module.setup !== 'function' || typeof module.frame !== 'function') {
    throw new Error('Export setup(context) and frame(context) from the shot module.');
  }
  const dependencies = new Map();
  const setup = await module.setup({THREE, load:loaders(worker,url,dependencies), mutracer, rng:rng(settings.seedValue)});
  const {scene,camera} = setup ?? {};
  if (!scene?.isScene || !camera?.isPerspectiveCamera && !camera?.isOrthographicCamera) throw new Error('setup must return a Three.js Scene and a perspective or orthographic camera.');
  const sink = {};
  const legacy = new WeakMap();
  const sync = new THREESync(sink,{scene,camera,convertMaterial:approximateLegacy});
  const encoder = new NativeSceneEncoder(async () => {throw new Error('Use a loaded HDR texture for the environment.');});
  return {
    assets: [...dependencies.entries()].sort(([a],[b]) => a.localeCompare(b)),
    async frame(t, index) {
      await module.frame({t,frame:index,scene,camera});
      camera.aspect = settings.size[0] / settings.size[1];
      camera.updateProjectionMatrix();
      scene.traverseVisible(node => {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!material?.isMeshLambertMaterial && !material?.isMeshPhongMaterial) continue;
          const snapshot = JSON.stringify([material.color,material.specular,material.shininess,material.opacity,material.transparent,material.emissive,material.emissiveIntensity, Object.keys(material).filter(key => /map$/i.test(key) && material[key]?.isTexture)]);
          const previous = legacy.get(material);
          if (previous && previous !== snapshot) material.needsUpdate = true;
          legacy.set(material,snapshot);
        }
      });
      strictConversion(scene,()=>sync.update());
      return normalizeAovIds(await encoder.encode(sink.scene, sink.camera ?? fromTHREECamera(camera),settings.size));
    },
    dispose() {sync.dispose();},
  };
}

async function atomic(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  try { await writeFile(temporary,data); await rename(temporary,file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function lock(directory) {
  const path = resolve(directory,'node.lock');
  for (;;) {
    try {
      const file = await open(path,'wx');
      await file.writeFile(String(process.pid));
      return async () => { await file.close(); await unlink(path); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path,'utf8'));
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Render directory is locked: ${directory}`);
      try {
        process.kill(pid,0);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        await unlink(path);
        continue;
      }
      throw new Error(`Render directory is locked by process ${pid}.`);
    }
  }
}

async function main() {
  const {command,file,values} = args();
  if (!command) {
    console.log('Usage: mutracer-js validate|still|preview|render SHOT.mjs [-o FILE] [--size WxH] [--spp N] [--frames N|A-B]\n' +
      'Frame indices are zero-based. Ranges are inclusive. By default, use the whole shot.');
    return;
  }
  const url = pathToFileURL(file);
  // Keep authored diagnostics away from the CLI's JSON lines.
  console.log = console.error.bind(console);
  console.info = console.log;
  const module = await import(url.href);
  const opts = options(module.output,command,values);
  if (values.output && !values.output.toLowerCase().endsWith(command === 'still' ? '.png' : '.mp4')) {
    throw new Error(command === 'still' ? 'Still output must be a PNG.' : 'Video output must be an MP4.');
  }
  let worker = await Worker.open();
  let release;
  let shot;
  try {
    shot = await prepare(module,url,worker,opts.settings);
    const {settings,fps,duration,first,last,time,stride} = opts;
    const frame = (t,index) => shot.frame(t,index);
    const timeA = command === 'still' ? time : first / fps;
    const indexA = command === 'still' ? Math.floor(time * fps) : first;
    const early = digest(await frame(timeA,indexA));
    const other = Math.min(duration,timeA + 1 / fps);
    await frame(other,Math.floor(other * fps));
    if (digest(await frame(timeA,indexA)) !== early) throw new Error(`frame(t=${timeA}) is not deterministic. Assign an absolute pose from t and frame.`);
    if (command === 'validate') {
      // Ask the authoritative descriptor parser to check the converted scene.
      await worker.request('scene',{format:'descriptor-v8'},await frame(timeA,indexA));
      emit({event:'validated',module:file,pixelSamples:settings.size[0]*settings.size[1]*settings.spp*(last-first+1)});
      return;
    }
    const render = async (descriptor, index, t) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await worker.request('scene',{format:'descriptor-v8'},descriptor);
          return await worker.request('render',{t,frame:index,settings});
        } catch (error) {
          if (!(error instanceof NativeError) || error.code !== 5 || attempt >= 2) throw error;
          emit({event:'retry',frame:index,attempt:attempt+1});
          await worker.close();
          worker = await Worker.open();
        }
      }
    };
    const output = resolve(values.output);
    if (command === 'still') {
      const {header,bytes} = await render(await frame(time,indexA), indexA,time);
      await atomic(output,bytes);
      emit({event:'frame',frame:indexA,path:output,elapsedMs:header.elapsedMs});
      return;
    }

    const directory = resolve(values['keep-frames'] ?? `${output}.frames`);
    await mkdir(directory,{recursive:true});
    release = await lock(directory);
    const key = hashJson({version:1,build:worker.info.build,settings,fps,stride,first,last,early,assets:shot.assets,module:digest(await readFile(file))});
    const manifest = resolve(directory,'node-manifest.json');
    try {
      if ((await readFile(manifest,'utf8')).trim() !== key) throw new Error('Render settings changed. Use a new frame directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await readdir(directory)).some(name => name.toLowerCase().endsWith('.png'))) {
        throw new Error('Frame directory contains PNGs without a manifest.');
      }
      await atomic(manifest,key + '\n');
    }
    for (let index=first;index<=last;index+=stride) {
      const t = index / fps;
      const descriptor = await frame(t,index);
      const source = digest(descriptor);
      const path = resolve(directory,`frame_${String(index).padStart(6,'0')}.png`);
      const sidecar = path + '.json';
      try {
        const cache = JSON.parse(await readFile(sidecar,'utf8'));
        if (cache.source !== source) throw new Error(`Frame ${index} changed. Use a new frame directory.`);
        if (digest(await readFile(path)) === cache.png) {
          emit({event:'reused',frame:index,path});
          continue;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const {header,bytes} = await render(descriptor,index,t);
      await atomic(path,bytes);
      await atomic(sidecar,JSON.stringify({source,png:digest(bytes)}));
      emit({event:'frame',frame:index,t,path,elapsedMs:header.elapsedMs,samples:settings.spp});
    }
    const encode = ['encode',directory,'--fps',String(fps),'-o',output];
    if (stride !== 1) encode.push('--stride',String(stride));
    if (values['contact-sheet']) encode.push('--contact-sheet',resolve(values['contact-sheet']));
    await nativeCommand(encode);
  } finally {
    shot?.dispose();
    if (release) await release();
    await worker.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = error instanceof NativeError ? error.code : 2;
});
