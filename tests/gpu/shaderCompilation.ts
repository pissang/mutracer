// Fixed-seed real-GPU comparisons; compile timings require a fresh browser cache.
import {
  Camera, DirectionalLight, Engine, EnvironmentLight, Mesh, OpenPBRMaterial,
  RectLight, Render, SphereLight, SpotLight, Texture, createPlaneGeometry, createSphereGeometry
} from '../../src/main.js';
import type {OpenPBRMaterialParams} from '../../src/scene/OpenPBRMaterial.js';
import type {SceneLight} from '../../src/scene/Scene.js';
import {generateVertexTangents} from '../../src/util/geometry.js';

type Quality = Partial<Pick<Render, 'samplingPattern' | 'bounces' | 'dispersionWavelengths' |
  'alphaBlendStrategy' | 'directLightCandidates' | 'transmissiveOutputAlphaMin'>>;

export async function capture(layout: Engine['bvhLayout'] = 'bvh2', names?: readonly string[], samples = 8, sampleSequenceOffset = 17) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  engine.bvhLayout = layout;
  engine.bvhBuilder = layout === 'bvh2' ? 'builtin' : 'tinybvh';
  engine.display.setSize(32, 24);
  const render = new Render(engine, {width: 32, height: 24, bounces: 4, batchSamples: true});
  try {
    const info = await engine.init();
    const camera = new Camera({projection: 'perspective', aspect: 4 / 3});
    camera.position = [0, 1.4, 5]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const geometry = createSphereGeometry(16, 8); generateVertexTangents(geometry);
    const sphere = new Mesh(geometry, new OpenPBRMaterial());
    const ground = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [.4, .4, .4]}));
    ground.position = [0, -1.05, 0]; ground.transform[0] = 4; ground.transform[10] = 4;
    const emitter = new Mesh(createSphereGeometry(8, 4), new OpenPBRMaterial());
    emitter.position = [2, 2, -1];
    const map = new Texture({width: 2, height: 2, data: new Uint8Array([
      180, 120, 60, 180, 100, 210, 90, 220, 40, 100, 220, 120, 220, 80, 160, 240
    ])});
    const normal = new Texture({width: 1, height: 1, data: new Uint8Array([150, 180, 240, 255])});
    const envMap = new Texture({width: 4, height: 2, data: new Float32Array([
      1, .2, .1, 1, .2, 1, .1, 1, .1, .2, 1, 1, .5, .5, .5, 1,
      .3, .1, .1, 1, .1, .3, .1, 1, .1, .1, .3, 1, .2, .2, .2, 1
    ])});
    const sphereLight = new SphereLight({intensity: 30}); sphereLight.position = [0, 3, 3];
    const rect = new RectLight({intensity: 8, size: [2, 2], texture: map});
    rect.position = [0, 3, 2]; rect.lookAt([0, 0, 0]);
    const spot = new SpotLight({intensity: 40, radius: .2});
    spot.position = [2, 3, 3]; spot.lookAt([0, 0, 0]);
    const sun = new DirectionalLight({intensity: 1}); sun.position = [-2, 3, 2]; sun.lookAt([0, 0, 0]);
    const environment = new EnvironmentLight({map: envMap});
    const cases: {name: string; params?: OpenPBRMaterialParams; quality?: Quality;
      lights?: SceneLight[]; emission?: boolean; catcher?: boolean; dispersiveEmitter?: boolean}[] = [
      {name: 'plain'},
      {name: 'layers', params: {coatWeight: .7, thinFilmWeight: 1, thinFilmThickness: .4, fuzzWeight: .3, subsurfaceWeight: .4}},
      {name: 'map-alpha-transmission', params: {map, mapAlphaUsage: 'transmission'}},
      {name: 'metal', params: {baseMetalness: 1, specularRoughness: .2, specularColor: [.5, .8, 1]}},
      {name: 'metal-subsurface', params: {baseMetalness: .4, subsurfaceWeight: .6, thinWalled: true}},
      {name: 'solid-glass', params: {transmissionWeight: 1, specularRoughness: .1}, quality: {bounces: 8, transmissiveOutputAlphaMin: .2}},
      {name: 'thin-glass', params: {transmissionWeight: 1, thinWalled: true, transmissionColor: [.7, .9, 1]}},
      {name: 'dispersion', params: {transmissionWeight: 1, transmissionDispersionScale: 1, coatWeight: .5}},
      {name: 'hero-wavelength', params: {transmissionWeight: 1, transmissionDispersionScale: 1}, quality: {dispersionWavelengths: 1}},
      {name: 'textures', params: {map, normalMap: normal, coatWeight: .5, coatWeightMap: map,
        coatRoughnessMap: map, fuzzWeight: .4, fuzzColorMap: map, specularColorMap: map}},
      {name: 'direction-frames', params: {coatWeight: .8, coatNormalMap: normal, anisotropyMap: map,
        specularAnisotropy: .8, specularAnisotropyModel: 'gltf', coatAnisotropy: .6, coatAnisotropyRotation: .4}},
      {name: 'stochastic-alpha-random', params: {alphaMode: 'blend', opacity: .4, map}, quality: {samplingPattern: 'random', directLightCandidates: 1}},
      {name: 'alpha-mask', params: {alphaMode: 'mask', map, alphaCutoff: .7}},
      {name: 'source-over-random', params: {alphaMode: 'blend', opacity: .4, coatWeight: .5},
        quality: {samplingPattern: 'random', alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-zero', params: {alphaMode: 'blend', opacity: 0},
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-one', params: {alphaMode: 'blend', opacity: 1},
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-unlit', params: {alphaMode: 'blend', opacity: .3, unlit: true},
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-dispersion', params: {alphaMode: 'blend', opacity: .4,
        transmissionWeight: .8, transmissionDispersionScale: 1},
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-dispersion-random', params: {alphaMode: 'blend', opacity: .4,
        transmissionWeight: .8, transmissionDispersionScale: 1, coatWeight: .5},
        quality: {alphaBlendStrategy: 'deterministic-source-over', samplingPattern: 'random', directLightCandidates: 2}},
      {name: 'source-over-dispersion-hero', params: {alphaMode: 'blend', opacity: .4,
        transmissionWeight: .8, transmissionDispersionScale: 1},
        quality: {alphaBlendStrategy: 'deterministic-source-over', dispersionWavelengths: 1}},
      {name: 'source-over-dispersion-zero', params: {alphaMode: 'blend', opacity: 0,
        transmissionWeight: .8, transmissionDispersionScale: 1},
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-dispersion-zero-bounces', params: {alphaMode: 'blend', opacity: .4,
        transmissionWeight: .8, transmissionDispersionScale: 1},
        quality: {alphaBlendStrategy: 'deterministic-source-over', bounces: 0}},
      {name: 'source-over-dispersion-one', params: {alphaMode: 'blend', opacity: 1,
        transmissionWeight: .8, transmissionDispersionScale: 1},
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-dispersion-depth', params: {alphaMode: 'blend', opacity: .4,
        transmissionWeight: .8, transmissionDispersionScale: 1, specularRoughness: .3},
        quality: {alphaBlendStrategy: 'deterministic-source-over', bounces: 20, transmissiveOutputAlphaMin: .2}},
      {name: 'source-over-spectral-back', params: {alphaMode: 'blend', opacity: .4}, dispersiveEmitter: true,
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'source-over-spectral-back-hero', params: {alphaMode: 'blend', opacity: .4}, dispersiveEmitter: true,
        quality: {alphaBlendStrategy: 'deterministic-source-over', dispersionWavelengths: 1}},
      {name: 'source-over-spectral-unlit', params: {alphaMode: 'blend', opacity: .3, unlit: true}, dispersiveEmitter: true,
        quality: {alphaBlendStrategy: 'deterministic-source-over'}},
      {name: 'maximum-depth-glass', params: {transmissionWeight: 1, specularRoughness: .3},
        quality: {bounces: 20, transmissiveOutputAlphaMin: .2}},
      {name: 'index-matched-glass', params: {transmissionWeight: 1, specularIor: 1}},
      {name: 'rect-zsobol', lights: [rect], quality: {samplingPattern: 'zsobol', directLightCandidates: 2}},
      {name: 'spot-and-sun', lights: [spot, sun]},
      {name: 'emissive', lights: [], emission: true},
      {name: 'emissive-sphere', lights: [sphereLight], emission: true, quality: {directLightCandidates: 1}},
      {name: 'emissive-rect', lights: [rect], emission: true, quality: {directLightCandidates: 1}},
      {name: 'emissive-spot', lights: [spot], emission: true, quality: {directLightCandidates: 1}},
      {name: 'emissive-directional', lights: [sun], emission: true, quality: {directLightCandidates: 1}},
      {name: 'environment', lights: [environment]},
      {name: 'catcher', catcher: true},
      {name: 'bevel', params: {bevelSize: .08}, quality: {bounces: 1}},
      {name: 'displacement', params: {displacementMap: map, displacementScale: .15}},
      {name: 'return-to-plain'}
    ];
    const captures = [];
    for (const test of cases) {
      if (names && !names.includes(test.name)) continue;
      sphere.materials[0] = new OpenPBRMaterial({baseColor: [.6, .3, .15], ...test.params});
      ground.materials[0] = new OpenPBRMaterial({baseColor: [.4, .4, .4], shadowCatcher: !!test.catcher});
      emitter.materials[0] = new OpenPBRMaterial({emissionColor: [1, .7, .3], emissionLuminance: test.emission ? 4 : 0,
        ...(test.dispersiveEmitter ? {transmissionWeight: 1, transmissionDispersionScale: 1} : {})});
      Object.assign(render, {samplingPattern: 'sobol', bounces: 4, dispersionWavelengths: 3,
        alphaBlendStrategy: 'stochastic', directLightCandidates: 4, transmissiveOutputAlphaMin: 1}, test.quality);
      engine.scene = {meshes: [sphere, ground, emitter], lights: test.lights ?? [sphereLight], background: [.1, .15, .2, 1]};
      engine.update();
      await render.converge({samples, sampleSequenceOffset});
      const pixels = await render.readPixels('hdr');
      if (test.emission) {
        if (!pixels.data.every(Number.isFinite)) throw new Error(`${test.name}: non-finite HDR`);
        if (!pixels.data.some((value, index) => index % 4 !== 3 && value > 0)) {
          throw new Error(`${test.name}: black HDR`);
        }
      }
      const albedo = await render.readPixels('albedo');
      const normals = await render.readPixels('normal');
      const depth = await engine.readDepthSamples({x: .5, y: .5, size: .3});
      captures.push({name: test.name, width: pixels.width, height: pixels.height,
        data: Array.from(pixels.data), albedo: Array.from(albedo.data), normal: Array.from(normals.data),
        depth: depth && Array.from(depth),
        compilation: engine.getDiagnostics()?.shaderCompilation});
    }
    return {backend: engine.backend, adapter: info.adapterName, layout, captures};
  } finally {render.dispose(); engine.dispose(); canvas.remove();}
}

Object.assign(window, {shaderCompilationTests: {capture}});
