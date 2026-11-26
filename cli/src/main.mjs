import {createHash} from 'node:crypto';
import {mkdir, open, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import * as THREE from 'three';
import * as mutracer from '../../src/main.ts';
import {THREESync, fromTHREECamera} from '../../src/three.ts';
import {CAMERA as C, HEADER as H, WORD_BYTES} from '../../native/src/layout.ts';
import {NativeSceneEncoder} from '../../viewer/src/engine/nativeScene.ts';
import {loaders} from './load.mjs';
import {strictConversion} from './strict.mjs';
import {NativeError, Worker, nativeCommand} from './worker.mjs';

const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const emittedWarnings = new Set();
const warn = warning => {
  const key = JSON.stringify(warning);
  if (emittedWarnings.has(key)) return;
  emittedWarnings.add(key);
  emit({event:'warning', ...warning});
  console.error(`Warning ${warning.pointer}: ${warning.message} ${warning.hint}`.trim());
};
const openWorker = async () => {
  const worker = await Worker.open();
  worker.onWarning = warning => emit({event:'warning', ...warning});
  return worker;
};
const digest = data => createHash('sha256').update(data).digest('hex');
// The [start, end) bytes of a v8 descriptor's camera record.
const cameraRange = descriptor => {
  const start = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength)
    .getUint32(H.CAMERA_OFFSET * WORD_BYTES, true) * WORD_BYTES;
  return [start, start + C.WORDS * WORD_BYTES];
};
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
      bounces: {type: 'string'}, format: {type: 'string'}, 'sample-sequence': {type: 'string'},
      'keep-frames': {type: 'string'}, 'contact-sheet': {type: 'string'},
      'seed-value': {type: 'string'}, 'sample-stride': {type: 'string'},
      'reflection-motion': {type: 'string'}, 'history-radius': {type: 'string'},
      'post-radius': {type: 'string'}, 'timing-only': {type: 'boolean'},
      'context': {type: 'string'},
    },
  });
  if (values.help) return {};
  const [command, file] = positionals;
  if (positionals.length !== 2 || !['validate','still','preview','render','capture'].includes(command)) {
    throw new Error('Usage: mutracer-js validate|still|preview|render SHOT.mjs [-o FILE]');
  }
  if (command !== 'validate' && !values.output) throw new Error('Specify -o FILE.');
  return {command, file: resolve(file), values};
}

function canonicalDisplay(input, warnDeprecated) {
  if (!input) return input;
  const display = {...input};
  if (display.tonemap !== undefined && display.toneMapping === undefined) {
    display.toneMapping = display.tonemap === 'none' ? 'linear' : display.tonemap;
    delete display.tonemap;
    if (warnDeprecated) warn({code:'deprecated-field', pointer:'/output/display/tonemap', message:'Deprecated field.', hint:'Use toneMapping.'});
  }
  if (display.exposure !== undefined && display.toneMappingExposure === undefined) {
    if (warnDeprecated) warn({code:'deprecated-field', pointer:'/output/display/exposure', message:'Deprecated field.', hint:'Use toneMappingExposure in linear units.'});
    // A legacy track interpolates in stops. The native worker must evaluate it.
    if (typeof display.exposure === 'number') {
      const linear = Math.fround(2 ** Math.fround(display.exposure));
      if (Number.isFinite(linear) && linear > 0) {
        display.toneMappingExposure = linear;
        delete display.exposure;
      }
    }
  }
  return display;
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
  if (!['oidn','cleanAuxLarge','temporal','none'].includes(denoise)) throw new Error('Use --denoise oidn, cleanAuxLarge, temporal or none.');
  const tracer = values.tracer ?? input.tracer ?? 'hardware';
  if (!['hardware','software'].includes(tracer)) throw new Error('Use --tracer hardware or software.');
  const seedValue = number(values['seed-value'] ?? input.seedValue ?? 12345, 'seedValue', 0, 0xffffffff);
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
  const render = input.render;
  const display = input.display;
  for (const [name, group] of [['render', render], ['display', display]]) {
    if (group !== undefined && (group === null || typeof group !== 'object' || Array.isArray(group))) {
      throw new Error(`output.${name} must be an object.`);
    }
  }
  const sampleSequence = values['sample-sequence'] ?? input.sampleSequence;
  if (sampleSequence !== undefined && !['fixed','frame'].includes(sampleSequence)) {
    throw new Error('Use sampleSequence fixed or frame.');
  }
  if (denoise === 'temporal' && (preview || sampleSequence !== 'frame')) {
    throw new Error('Temporal rendering requires stride 1 and output.sampleSequence set to frame.');
  }
  const experimentalKeys = ['seed-value','sample-stride','reflection-motion','history-radius','post-radius','timing-only','context'];
  const experimental = command === 'capture';
  if (!experimental && experimentalKeys.some(key => values[key] !== undefined)) {
    throw new Error('Experimental options require the capture command.');
  }
  const temporal = denoise === 'temporal' && experimental ? {...input.temporal} : input.temporal && {...input.temporal};
  const projection = values['reflection-motion'];
  if (projection !== undefined) {
    if (!temporal || denoise !== 'temporal' || !['off','planar','curved'].includes(projection)) {
      throw new Error('Use --reflection-motion off, planar or curved with temporal denoising.');
    }
    temporal.reflectionMotion = projection !== 'off';
  }
  for (const [flag, key] of [['history-radius','historyRadius'], ['post-radius','postRadius']]) {
    if (values[flag] === undefined) continue;
    if (!temporal || denoise !== 'temporal') throw new Error(`--${flag} requires temporal denoising.`);
    temporal[key] = number(values[flag], flag, 0, key === 'postRadius' ? 3 : 32);
  }
  if (temporal?.postRadius === 0 && experimental) temporal.stabilizeSparkle = false;
  const sequenceStride = values['sample-stride'] === undefined ? undefined :
    number(values['sample-stride'], 'sample stride', spp, 0xffffffff);
  const format = values.format;
  if (format !== undefined && (command !== 'still' || !['png','exr'].includes(format))) {
    throw new Error('Use --format png or exr for a still.');
  }
  return {duration, fps, first, last, time, stride: preview ? 2 : 1,
    settings: {size:[w,h], spp, seed, denoise, seedValue, sampleSequenceOffset:offset, tracer,
      sampleSequence, ...(experimental && {experimentalCapture:true}),
      ...(sequenceStride !== undefined && {experimentalSequenceStride: sequenceStride}),
      ...(projection === 'planar' && {experimentalPlanar:true}), ...(temporal && {temporal}), display: canonicalDisplay(display, command === 'validate'), format,
      render: values.bounces === undefined ? render : {...render, bounces:number(values.bounces, 'Bounces', 1, 20)}}};
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

function applyLens(target, camera, scene) {
  const lens = camera.userData.mutracerLens;
  if (lens === undefined) return target;
  if (!lens || typeof lens !== 'object' || Array.isArray(lens)) throw new Error('camera.userData.mutracerLens must be an object.');
  for (const key of Object.keys(lens)) {
    if (!['fStop','focusDistance','sensorHeight'].includes(key)) throw new Error(`Unknown mutracerLens field ${key}.`);
  }
  const {fStop = 0, sensorHeight = 24} = lens;
  let {focusDistance = 10} = lens;
  if (typeof focusDistance === 'string') {
    if (!scene) throw new Error('A named focusDistance requires a Three.js Scene.');
    const matches = [];
    scene.traverseVisible(node => { if (node.name === focusDistance) matches.push(node); });
    if (matches.length !== 1) throw new Error(`focusDistance must name one visible object. Found ${matches.length} named "${focusDistance}".`);
    const bounds = new THREE.Box3().setFromObject(matches[0]);
    if (bounds.isEmpty()) throw new Error(`Focus object "${focusDistance}" has no bounds.`);
    const offset = bounds.getCenter(new THREE.Vector3()).sub(camera.getWorldPosition(new THREE.Vector3()));
    focusDistance = offset.dot(camera.getWorldDirection(new THREE.Vector3()));
  }
  for (const [key, value, min] of [['fStop',fStop,0], ['focusDistance',focusDistance,Number.MIN_VALUE], ['sensorHeight',sensorHeight,Number.MIN_VALUE]]) {
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)) || Math.fround(value) < min) {
      throw new Error(`mutracerLens.${key} must be a finite ${min ? 'positive' : 'nonnegative'} number.`);
    }
    target[key] = value;
  }
  return target;
}

async function prepare(module, url, worker, settings) {
  if (typeof module.setup !== 'function' || typeof module.frame !== 'function') {
    throw new Error('Export setup(context) and frame(context) from the shot module.');
  }
  const dependencies = new Map();
  const setup = await module.setup({THREE, load:loaders(worker,url,dependencies), mutracer, rng:rng(settings.seedValue)});
  const {scene,camera} = setup ?? {};
  const threeScene = scene?.isScene;
  const threeCamera = camera?.isPerspectiveCamera || camera?.isOrthographicCamera;
  const nativeScene = !threeScene && Array.isArray(scene?.meshes) && Array.isArray(scene?.lights);
  if (!(threeScene && threeCamera || nativeScene && (threeCamera || camera instanceof mutracer.Camera))) {
    throw new Error('setup must return a Three.js Scene and camera, or a MuTracer scene with a Three.js or MuTracer camera.');
  }
  const sink = {};
  const legacy = new WeakMap();
  const graphMaterials = new WeakMap();
  const sync = threeScene ? new THREESync(sink, {
    scene, camera, convertMaterial:approximateLegacy,
    onMeshConverted(mesh, source, group) {
      const original = Array.isArray(source.material) ? source.material[group.materialIndex ?? 0] : source.material;
      const materialX = original?.userData.mutracerMaterialX;
      if (materialX === undefined) return;
      if (!materialX || typeof materialX !== 'object' || !materialX.values) {
        throw new Error(`Material "${original.name}": assign the result of await load.materialX() to mutracerMaterialX.`);
      }
      const base = mesh.materials[0];
      let variants = graphMaterials.get(materialX);
      if (!variants) graphMaterials.set(materialX, variants = new WeakMap());
      let converted = variants.get(base);
      if (!converted) variants.set(base, converted = new mutracer.OpenPBRMaterial());
      Object.assign(converted, base, materialX.values);
      converted.graph = materialX.graph;
      mesh.materials = [converted];
    },
  }) : undefined;
  const encoder = new NativeSceneEncoder(async () => {throw new Error('Use a loaded HDR texture for the environment.');});
  return {
    get materialsByMeshName() {
      const meshes = (sync ? sink.scene : scene).meshes;
      const materials = [...new Set(meshes.flatMap(mesh => mesh.materials))];
      return Object.fromEntries(meshes.filter(mesh => mesh.name)
        .map(mesh => [mesh.name, mesh.materials.map(material => materials.indexOf(material) + 1)]));
    },
    get assets() { return [...dependencies.entries()].sort(([a],[b]) => a.localeCompare(b)); },
    async frame(t, index) {
      await module.frame({t,frame:index,scene,camera});
      if (threeCamera) {
        camera.aspect = settings.size[0] / settings.size[1];
        camera.updateProjectionMatrix();
      }
      if (!sync) {
        const lens = threeCamera ? applyLens(fromTHREECamera(camera),camera,undefined) : camera;
        return normalizeAovIds(await encoder.encode(scene,lens,settings.size));
      }
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
      const nativeCamera = sink.camera ?? fromTHREECamera(camera);
      nativeCamera.fStop = 0;
      nativeCamera.focusDistance = 10;
      nativeCamera.sensorHeight = 24;
      return normalizeAovIds(await encoder.encode(sink.scene, applyLens(nativeCamera,camera,scene),settings.size));
    },
    dispose() {sync?.dispose();},
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

async function captureShot(worker, shot, opts, values, directory) {
  if (!worker.info.capabilities.includes('experimental-capture')) {
    throw new Error('Build the native worker with experimental capture support.');
  }
  const {settings, fps, duration, first, last} = opts;
  const radius = settings.temporal?.historyRadius;
  const latency = settings.denoise === 'temporal' ?
    (typeof radius === 'number' ? radius : radius?.max ?? 16) + (settings.temporal?.postRadius ?? 3) : 0;
  const context = values.context?.split('-');
  if (context && !/^\d+-\d+$/.test(values.context)) throw new Error('Use --context FIRST-LAST.');
  const maxFrame = Math.ceil(duration * fps) - 1;
  const begin = context ? number(context[0], 'Context start', 0, first) :
    latency ? Math.max(0, first - latency - 1) : first;
  const end = context ? number(context[1], 'Context end', last, maxFrame) :
    Math.min(maxFrame, last + latency);
  const save = index => index >= first && index <= last;
  const prefix = index => resolve(directory, `frame-${String(index).padStart(4,'0')}`);
  const started = performance.now();
  const timing = {renderMs: [], workerMs: [], outputMs: {}};
  const materials = {}, cameras = {};
  async function saveInput(index) {
    if (!save(index) || values['timing-only']) return;
    const {header,bytes} = await worker.request('capture', {});
    const length = settings.size[0] * settings.size[1] * 16;
    if (header.type !== 'capture' || bytes?.length !== length * 2) throw new NativeError('Invalid capture readback.');
    materials[index] = shot.materialsByMeshName;
    await Promise.all([
      atomic(prefix(index) + '.hdr.f32', bytes.subarray(0,length)),
      atomic(prefix(index) + '.id.u32', bytes.subarray(length)),
    ]);
  }
  async function saveOutput(index, bytes) {
    if (!save(index)) return;
    await atomic(prefix(index) + '.png', bytes);
    timing.outputMs[index] = performance.now() - started;
    emit({event:'frame',frame:index,path:prefix(index) + '.png'});
  }
  let tick;
  async function* inputs() {
    for (let index = begin; index <= end; index++) {
      tick = performance.now();
      const t = index / fps;
      const descriptor = await shot.frame(t,index);
      const camera = cameraRange(descriptor);
      const words = new Float32Array(descriptor.buffer, descriptor.byteOffset + camera[0], C.WORDS);
      cameras[index] = {transform: [...words.slice(C.TRANSFORM)], fov: words[C.FOV], zoom: words[C.ZOOM]};
      yield {frame:index,t,descriptor,camera};
    }
  }
  async function submitted(index, header) {
    timing.renderMs.push(performance.now() - tick);
    timing.workerMs.push(header.elapsedMs);
    await saveInput(index);
  }
  if (settings.denoise === 'temporal') {
    let expected = begin;
    for await (const {frame,bytes} of worker.temporalFrames(inputs(),settings,submitted)) {
      if (frame !== expected++) throw new NativeError(`Unexpected capture frame ${frame}.`);
      await saveOutput(frame,bytes);
    }
    if (expected !== end + 1) throw new NativeError('Incomplete capture sequence.');
  } else {
    for await (const {frame,t,descriptor,camera} of inputs()) {
      await worker.scene(descriptor,camera);
      const {header,bytes} = await worker.request('render',{frame,t,settings});
      await submitted(frame,header);
      await saveOutput(frame,bytes);
    }
  }
  await atomic(resolve(directory,'capture.json'),JSON.stringify({
    backend:settings.tracer, build:worker.info.build, first:begin, last:end, saved:[[first,last]],
    fps, settings, materials, cameras, seconds:(performance.now()-started)/1000, timing,
  },null,2) + '\n');
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
  const extension = command === 'still' ? (opts.settings.format ?? 'png') : 'mp4';
  if (command !== 'capture' && values.output && !values.output.toLowerCase().endsWith('.' + extension)) {
    throw new Error(`Output must end in .${extension}.`);
  }
  let worker = await openWorker();
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
    const canCheck = worker.info.capabilities.includes('check-settings');
    let denoiserWeights, directLightCandidates;
    if (canCheck || command === 'validate') {
      const descriptor = await frame(timeA,indexA);
      await worker.scene(descriptor,cameraRange(descriptor));
      if (canCheck) {
        const index = command === 'still' ? indexA : first + Math.floor((last-first)/stride)*stride;
        const {header} = await worker.request('check',{t:command === 'still' ? time : index/fps,frame:index,settings});
        denoiserWeights = header.denoiserWeights ?? undefined;
        directLightCandidates = header.directLightCandidates;
      } else if (settings.render || settings.display || settings.sampleSequence || settings.denoise === 'cleanAuxLarge') {
        throw new Error('Update the native CLI to validate the requested render settings.');
      }
    }
    if (command === 'validate') {
      emit({event:'validated',module:file,directLightCandidates,pixelSamples:settings.size[0]*settings.size[1]*settings.spp*(last-first+1)});
      return;
    }
    const retryGpu = async (nextFrame, operation) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await operation();
        } catch (error) {
          if (!(error instanceof NativeError) || error.code !== 5 || attempt >= 2) throw error;
          emit({event:'retry',frame:nextFrame(),attempt:attempt+1});
          await worker.close();
          worker = await openWorker();
        }
      }
    };
    const render = (descriptor, index, t) => retryGpu(() => index, async () => {
      await worker.scene(descriptor,cameraRange(descriptor));
      return worker.request('render',{t,frame:index,settings});
    });
    const output = resolve(values.output);
    if (command === 'capture') {
      await mkdir(output,{recursive:true});
      release = await lock(output);
      if ((await readdir(output)).some(name => name.startsWith('frame-') || name === 'capture.json')) {
        throw new Error('Use an empty capture directory.');
      }
      if (denoiserWeights) emit({event:'denoiser',weights:denoiserWeights});
      await captureShot(worker, shot, opts, values, output);
      return;
    }
    if (command === 'still' && settings.denoise === 'temporal') {
      const descriptor = await frame(time,indexA);
      const inputs = [{frame:indexA,t:time,descriptor,camera:cameraRange(descriptor)}];
      const bytes = await retryGpu(() => indexA, async () => {
        let image;
        for await (const result of worker.temporalFrames(inputs,settings)) {
          if (result.frame !== indexA || image) throw new NativeError('Unexpected temporal still frame.');
          image = result.bytes;
        }
        if (!image) throw new NativeError('Missing temporal still frame.');
        return image;
      });
      await atomic(output,bytes);
      emit({event:'frame',frame:indexA,path:output});
      return;
    }
    if (command === 'still') {
      const {header,bytes} = await render(await frame(time,indexA), indexA,time);
      await atomic(output,bytes);
      emit({event:'frame',frame:indexA,path:output,elapsedMs:header.elapsedMs});
      return;
    }

    const directory = resolve(values['keep-frames'] ?? `${output}.frames`);
    await mkdir(directory,{recursive:true});
    release = await lock(directory);
    const key = hashJson({version:1,build:worker.info.build,settings,denoiserWeights,fps,stride,first,last,early,assets:shot.assets,module:digest(await readFile(file))});
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
    if (settings.denoise === 'temporal') {
      // Submit the surrounding shot context even when only a subrange is exported.
      const radius = settings.temporal?.historyRadius;
      const latency = (typeof radius === 'number' ? radius : radius?.max ?? 16) + (settings.temporal?.postRadius ?? 3);
      const begin = Math.max(0,first-latency-1), end = Math.min(Math.ceil(duration*fps)-1,last+latency);
      let next = first;
      await retryGpu(() => Math.min(next,last), async () => {
        // Replay the same shot prefix to reconstruct motion, cuts and both history windows.
        const sources = new Map();
        async function* inputs() {
          for (let index=begin; index<=end; index++) {
            const descriptor = await frame(index/fps,index);
            if (index>=next && index<=last) sources.set(index,digest(descriptor));
            yield {frame:index,t:index/fps,descriptor,camera:cameraRange(descriptor)};
          }
        }
        let expected = begin;
        for await (const {frame:index,bytes} of worker.temporalFrames(inputs(),settings)) {
          if (index !== expected++) throw new NativeError(`Unexpected temporal frame ${index}.`);
          if (index<next || index>last) continue;
          const path = resolve(directory,`frame_${String(index).padStart(6,'0')}.png`);
          await atomic(path,bytes);
          await atomic(path+'.json',JSON.stringify({source:sources.get(index),png:digest(bytes)}));
          sources.delete(index);
          emit({event:'frame',frame:index,t:index/fps,path,samples:settings.spp});
          next++;
        }
        if (expected !== end+1) throw new NativeError('Incomplete temporal sequence.');
      });
    } else for (let index=first;index<=last;index+=stride) {
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
