import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// OpenPBR material gallery on a shadow catcher with a transparent background,
// OIDN denoising and deterministic offline rendering to a PNG.
import { mat4 } from 'gl-matrix';
import {
  EnvironmentLight,
  Mesh,
  OpenPBRMaterial, type OpenPBRMaterialParams,
  Engine, RenderLoop, Sync,
  SphereLight,
  type OIDNModel,
  type SamplingPattern,
  type Scene,
  createPlaneGeometry,
  createSphereGeometry
} from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';
import { createSkyTexture } from './shared/sky';
import { showStatus } from './shared/status';
import { copyDenoiser } from './shared/copyDenoiser';

const canvas = document.getElementById('main') as HTMLCanvasElement;
const statusElement = document.getElementById('status')!;
const denoiserSelect = document.getElementById('denoiser') as HTMLSelectElement;
const samplingSelect = document.getElementById('sampling') as HTMLSelectElement;
const samplesInput = document.getElementById('samples') as HTMLInputElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;

// One sphere per OpenPBR layer.
const gallery: OpenPBRMaterialParams[] = [
  // Copper.
  { baseColor: [0.95, 0.64, 0.54], baseMetalness: 1, specularRoughness: 0.3 },
  // Car paint: diffuse base under a clear coat.
  { baseColor: [0.6, 0.02, 0.04], coatWeight: 1, coatRoughness: 0.02 },
  // Dispersive glass.
  { transmissionWeight: 1, specularRoughness: 0, specularIor: 1.6,
    transmissionDispersionScale: 1, transmissionDispersionAbbeNumber: 25 },
  // Jade: subsurface scattering.
  { subsurfaceWeight: 1, subsurfaceColor: [0.35, 0.8, 0.5], subsurfaceRadius: 0.3,
    baseColor: [0.35, 0.8, 0.5], specularRoughness: 0.15 },
  // Velvet: fuzz layer.
  { baseColor: [0.15, 0.05, 0.3], fuzzWeight: 1, fuzzColor: [0.7, 0.5, 1], fuzzRoughness: 0.6 },
  // Soap-bubble iridescence: thin film over a dark base.
  { baseColor: [0.02, 0.02, 0.02], specularRoughness: 0.1, thinFilmWeight: 1,
    thinFilmThickness: 0.45, thinFilmIor: 1.33 }
];
const sphere = createSphereGeometry(64, 32);
const meshes = gallery.map((props, index) => {
  const mesh = new Mesh(sphere, new OpenPBRMaterial(props));
  const x = (index % 3 - 1) * 1.15;
  const z = Math.floor(index / 3) * -1.15 + 0.5;
  mat4.fromTranslation(mesh.transform, [x, 0.45, z]);
  mat4.scale(mesh.transform, mesh.transform, [0.45, 0.45, 0.45]);
  return mesh;
});

// The shadow catcher is invisible but keeps the shadows, so the render can be
// composited over any page or photo.
const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({ shadowCatcher: true }));
mat4.fromScaling(floor.transform, [8, 1, 8]);

const keyLight = new SphereLight({ color: [1, 0.85, 0.7], intensity: 30, radius: 0.3 });
keyLight.position = [-2, 3, 2];

const scene: Scene = {
  meshes: [floor, ...meshes],
  lights: [
    new EnvironmentLight({map: createSkyTexture({ sunIntensity: 800 })}),
    keyLight
  ],
  // Fully transparent background.
  background: [0, 0, 0, 0]
};

const camera = new THREE.PerspectiveCamera(35, 1, .1, 100);
camera.position.set(0, 2.6, 5.2); camera.lookAt(0, 0.3, -0.3);
// Treat the scene as a tabletop: one unit is 10 cm.


camera.focus = 5.4;
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, .3, -.3); controls.update();

const engine = new Engine({canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto'});
const sync = new THREESync(engine, {camera, controls});
class LensSync extends Sync { update() { if (this.engine.camera) { this.engine.camera.sensorHeight = 24; this.engine.camera.fStop = 5.6; this.engine.camera.metersPerUnit = .1; this.engine.camera.focusDistance = 5.4; } } }
const loop = new RenderLoop(engine, {sync: [sync, new LensSync(engine)], final: {bounces: 8, maxSamples: 256}});
const final = loop.final;
engine.scene = scene;
engine.on('error', error => {statusElement.textContent = error.message;});

// The dev server serves the repository root, so the packaged OIDN weights
// are available locally. Applications can omit weightsBaseUrl to use the
// CDN copy. Custom networks use { type: 'oidn', weightsUrl: '/assets/custom.tza' }
// on the same Render. The built-in JNLM filter needs no weights.
function updateDenoiser() {
  const model = denoiserSelect.value;
  final.setDenoiser(
    model === 'off'
      ? null
      : model === 'custom-copy'
      ? {type: 'custom', denoiser: copyDenoiser}
      : model === 'jnlm'
      ? { type: 'jnlm' }
      : { type: 'oidn', model: model as OIDNModel, weightsBaseUrl: '/oidn/weights/' }
  ).catch(error => console.error('Denoiser failed to load.', error));
}
denoiserSelect.addEventListener('change', () => {
  updateDenoiser();
});
updateDenoiser();

// Sobol suits OIDN; ZSobol gives blue-noise error for undenoised previews.
samplingSelect.addEventListener('change', () => {
  final.samplingPattern = samplingSelect.value as SamplingPattern;
});

function resize() {
  const ratio = Math.min(window.devicePixelRatio, 2);
  engine.display.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let exporting = false;
exportButton.addEventListener('click', async () => {
  exporting = true;
  exportButton.disabled = true;
  try {
    // Deterministic: the same scene and sample count give the same image.
    await loop.converge({
      samples: Number(samplesInput.value) || 256,
      onProgress({ stage, samples, targetSamples }) {
        statusElement.textContent = stage === 'denoising'
          ? 'Denoising'
          : `Offline ${samples} / ${targetSamples} spp`;
      }
    });
    const blob = await engine.display.toBlob(final);
    if (blob) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'mutracer.png';
      link.click();
      URL.revokeObjectURL(link.href);
    }
  } finally {
    exporting = false;
    exportButton.disabled = false;
  }
});

function frame() {
  if (!exporting) {
    showStatus(statusElement, engine, final, loop.tick());
  }
  requestAnimationFrame(frame);
}
frame();

window.addEventListener('pagehide', () => {loop.dispose(); sync.dispose(); controls.dispose(); engine.dispose();});
