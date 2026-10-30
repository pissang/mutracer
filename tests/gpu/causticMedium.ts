import {Camera, Engine, Render, Mesh, OpenPBRMaterial, DirectionalLight, createCubeGeometry, createPlaneGeometry} from '../../src/main.js';

// Closed shell: the inner box has inward normals and reversed winding. The
// index-matched interfaces isolate Beer attenuation from Fresnel/refraction.
function box(y: number, height: number, width: number, material: OpenPBRMaterial, inward = false) {
  const geometry = createCubeGeometry();
  if (inward) {
    const indices = geometry.indices!.array;
    for (let i = 0; i < indices.length; i += 3) [indices[i], indices[i + 1]] = [indices[i + 1], indices[i]];
    const normals = geometry.normal!.array;
    for (let i = 0; i < normals.length; i++) normals[i] *= -1;
  }
  const mesh = new Mesh(geometry, material);
  mesh.position = [0, y, 0];
  mesh.transform[0] = mesh.transform[10] = width;
  mesh.transform[5] = height;
  return mesh;
}

export async function captureMedium({overlap = true, absorption = true, caustics = 'lt', backend = 'webgpu', samples = 512, cameraMedium = false}:
  {overlap?: boolean; absorption?: boolean; caustics?: 'lt' | 'pm' | 'off'; backend?: 'webgpu' | 'webgl'; samples?: number; cameraMedium?: boolean} = {}) {
  const engine = new Engine({canvas: document.createElement('canvas'), backend, textureBinding: 'atlas'});
  const render = new Render(engine, {bounces: 12, bevel: false, batchSamples: false, caustics: {
    lightTracing: caustics === 'lt' ? {photonsPerSample: 32768} : false,
    photonMapping: caustics === 'pm' ? {photonsPerSample: 32768, initialRadius: .1} : false
  }});
  try {
    const info = await engine.init();
    const errors: string[] = [];
    engine.device?.addEventListener('uncapturederror', e => errors.push((e as GPUUncapturedErrorEvent).error.message));
    engine.display.setSize(48, 48);
    const camera = new Camera({projection: 'orthographic', left: -.25, right: .25, top: .25, bottom: -.25});
    camera.position = [0, .6, 3]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const glass = new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0, doubleSided: true});
    const color: [number, number, number] = absorption ? [.8, .5, .2] : [1, 1, 1];
    const liquid = new OpenPBRMaterial({transmissionWeight: 1, specularIor: 1, specularRoughness: 0, transmissionDepth: 1, transmissionColor: color, doubleSided: true});
    const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [1, 1, 1], specularWeight: 0}));
    floor.transform[0] = floor.transform[10] = 12;
    const light = new DirectionalLight({intensity: Math.PI}); light.position = [0, 4, 0]; light.lookAt([0, 0, 0]);
    if (caustics === 'off') {light.position = [10, 1, 0]; light.lookAt([0, 0, 0]);}
    const meshes = [floor, box(1.5, 1.4, 4, glass), box(1.5, 1, 3.8, glass, true), box(overlap ? 1.6 : 1.5, overlap ? 1 : .8, 3.9, liquid)];
    if (cameraMedium) {
      // Receiver and lens are inside a homogeneous liquid. A null plane above
      // it creates the caustic chain without blocking the camera connection.
      meshes.splice(1, meshes.length - 1, box(2, .1, 4, glass), box(1, 5, 10, liquid));
      camera.position = [0, .6, 0]; camera.lookAt([0, 0, 0]);
    }
    engine.scene = {meshes, lights: [light], background: [0, 0, 0, 1]}; engine.update();
    await render.converge({samples, samplesPerBatch: 1, sampleSequenceOffset: 17});
    const image = await render.readPixels('hdr');
    const rgb = [0, 0, 0];
    for (let i = 0; i < image.data.length; i += 4) for (let c = 0; c < 3; c++) rgb[c] += image.data[i + c] / (image.width * image.height);
    if (errors.length) throw Error(errors.join('\n'));
    return {hdr: Array.from(image.data), rgb, width: image.width, height: image.height, info, errors, samples};
  } finally {render.dispose(); engine.dispose();}
}

export async function causticMediumContract() {
  const rows = [];
  for (const caustics of ['lt', 'pm'] as const) {
    const a = await captureMedium({caustics, absorption: false});
    const b = await captureMedium({caustics});
    const ratio = b.rgb.map((v, c) => v / a.rgb[c]);
    const expected = [.8, .5, .2];
    // EPS offsets shorten each absorbing segment very slightly.
    if (ratio.some((v, c) => Math.abs(v / expected[c] - 1) > .01)) throw Error('Overlapping medium attenuation: ' + JSON.stringify({caustics, ratio, expected}));
    rows.push({caustics, ratio, expected});
  }
  const clear = await captureMedium({cameraMedium: true, absorption: false});
  const absorbing = await captureMedium({cameraMedium: true});
  const ratio = absorbing.rgb.map((v, c) => v / clear.rgb[c]);
  // Light enters at y=3.5; receiver y=0; orthographic lens at y=.6.
  const expected = [.8, .5, .2].map(v => v ** 4.1);
  if (ratio.some((v, c) => Math.abs(v / expected[c] - 1) > .01)) throw Error('Camera medium attenuation: ' + JSON.stringify({ratio, expected}));
  rows.push({caustics: 'lt-camera', ratio, expected});
  return rows;
}
