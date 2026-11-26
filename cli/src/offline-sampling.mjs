import {createHash} from 'node:crypto';
import {OfflineGeometryHistory, offlineSampleTileSize} from '../../src/temporal/offlineSamplePlan.ts';
import {AOV_LAYOUT} from '../../src/renderer/aov.ts';
import {CAMERA, HEADER, WORD_BYTES} from '../../native/src/layout.ts';

export function decodeOfflineGeometry(header, bytes, size, reflections) {
  const [stride, rows] = size;
  const records = stride * rows * AOV_LAYOUT.centerBytes * (reflections ? 3 : 2);
  if (header.type !== 'geometry' || header.size[0] !== stride || header.size[1] !== rows ||
      header.records !== records || bytes?.length !== records + stride * rows * 16) {
    throw new Error('Invalid offline geometry packet.');
  }
  const data = Uint8Array.from(bytes).buffer;
  return {
    words: new Uint32Array(data, 0, records / 4),
    values: new Float32Array(data, 0, records / 4),
    material: new Float32Array(data, records),
    stride, rows, left: 0, top: 0,
    eye: header.eye, direction: header.direction ?? undefined,
    focalLength: header.focalLength, apertureRadius: header.apertureRadius,
  };
}

export async function planSampling(worker, shot, settings, fps, begin, end, average, floor, save) {
  if (!worker.info.capabilities.includes('experimental-sample-tiles')) {
    throw new Error('Build the native worker with experimental sample tiles.');
  }
  const step = offlineSampleTileSize;
  const size = settings.size.map(edge => Math.ceil(edge / step));
  const history = new OfflineGeometryHistory(...size);
  const reflections = settings.temporal?.reflectionMotion === true;
  const pilot = {...settings, size, spp:1, experimentalGeometry:true};
  const geometryMs = [], sources = [];
  let lastSceneKey;
  for (let index = begin; index <= end; index++) {
    const started = performance.now();
    const t = index / fps;
    const descriptor = await shot.frame(t,index);
    const camera = descriptor.readUInt32LE(HEADER.CAMERA_OFFSET * WORD_BYTES) * WORD_BYTES;
    sources.push(createHash('sha256').update(descriptor).digest('hex'));
    await worker.scene(descriptor, [camera, camera + CAMERA.WORDS * WORD_BYTES]);
    const {header,bytes} = await worker.request('render',{frame:index,t,settings:pilot});
    const cut = shot.geometryCuts.includes(index) || settings.temporal?.cuts?.some(value => typeof value === 'number' ?
      value === index : (index - 1) / fps < value.time && value.time <= t);
    history.add(decodeOfflineGeometry(header, bytes, size, reflections), cut || lastSceneKey !== header.sceneKey);
    lastSceneKey = header.sceneKey;
    geometryMs.push(performance.now() - started);
    await save?.(index, header, bytes);
  }
  const radius = settings.temporal?.historyRadius;
  const started = performance.now();
  const plans = history.samplePlans(...settings.size, settings.spp, average,
    typeof radius === 'number' ? radius : radius?.min ?? 8, floor);
  return {plans, sources, geometryMs, allocationMs:performance.now() - started};
}
