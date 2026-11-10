/**
 * Development tool: renders material preset and MaterialX sample thumbnails
 * with MuTracer. Run `await generateThumbnails()` in the console of
 * `npm run viewer`; the dev server writes them to src/assets/thumbnails/.
 */
import * as THREE from 'three';
import { getEngine } from '../engine/ViewerEngine';
import { MATERIAL_PRESETS } from '../engine/materialParams';
import { MATERIALX_SAMPLES, materialXSampleFiles } from '../engine/materialxSamples';
import type { LoadedModel } from '../engine/loadModel';
import { DEFAULT_SETTINGS, setSettings, useViewer, type TreeNode } from '../store';

const MATERIAL_SIZE = { width: 128, height: 128, samples: 256 };

async function until(test: () => boolean, timeoutMs = 120_000) {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits until the model and environment are loaded and the first sample is drawn. */
const ready = () => until(() => {
  const s = useViewer.getState();
  return !s.loading && !s.envLoading && s.stats.samples > 0;
});

const flatten = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);

/** A floor that curves up into a back wall, seen from the front. */
function cycloramaGeometry() {
  const width = 10;
  const floor = -1;
  const bendStart = -0.45;
  const bendRadius = 0.9;
  const profile: [number, number][] = [[floor, 2.5], [floor, bendStart]];
  for (let i = 1; i <= 12; i++) {
    const angle = (i / 12) * (Math.PI / 2);
    profile.push([floor + bendRadius * (1 - Math.cos(angle)), bendStart - bendRadius * Math.sin(angle)]);
  }
  profile.push([2.7, bendStart - bendRadius]);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let length = 0;
  profile.forEach(([y, z], i) => {
    if (i > 0) length += Math.hypot(y - profile[i - 1][0], z - profile[i - 1][1]);
    positions.push(-width / 2, y, z, width / 2, y, z);
    uvs.push(0, length / width, 1, length / width);
    if (i > 0) indices.push(2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i - 2, 2 * i + 1, 2 * i);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Material preview stage after DropMesh's: a sphere in front of a checker cyclorama. */
export function materialStage(): { model: LoadedModel; sphere: THREE.Mesh } {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      context.fillStyle = (x + y) % 2 ? '#20232a' : '#737984';
      context.fillRect(x * 32, y * 32, 32, 32);
    }
  }
  const checker = new THREE.CanvasTexture(canvas);
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  const root = new THREE.Group();
  const backdrop = new THREE.Mesh(cycloramaGeometry(), new THREE.MeshStandardMaterial({ map: checker, roughness: 0.82 }));
  backdrop.name = 'Backdrop';
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.94, 128, 64), new THREE.MeshPhysicalMaterial({ roughness: 0.35 }));
  sphere.name = 'Material sphere';
  sphere.position.y = -0.06;
  root.add(backdrop, sphere);
  return { model: { name: 'Material preview', root, animations: [], revoke() {} }, sphere };
}

async function saveThumbnails(shots: [string, Blob][]) {
  for (const [name, blob] of shots) {
    const response = await fetch(`/__thumbnails/${name}.webp`, { method: 'POST', body: blob });
    if (!response.ok) throw new Error(`Could not save ${name}`);
  }
}

async function generateThumbnails() {
  const engine = getEngine();
  if (!engine) throw new Error('The viewer is not running');
  const previous = useViewer.getState().settings;
  const shots: [string, Blob][] = [];
  setSettings({ ...DEFAULT_SETTINGS, denoise: previous.denoise }, { record: false });

  // Material presets: dimmed studio light, AgX at 0.85 exposure, fixed camera.
  const { model, sphere } = materialStage();
  setSettings({ lighting: 'environment', background: 'environment', groundShadow: false, envIntensity: 0.9, exposure: 0.85, toneMapping: 'agx', fov: 34 }, { record: false });
  await engine.loadModel(model);
  await ready();
  const center = sphere.getWorldPosition(new THREE.Vector3());
  engine.lookAt(center.clone().add(new THREE.Vector3(2.35, 1.61, 2.88)), center.clone().add(new THREE.Vector3(0, 0.08, 0)));
  const materialId = flatten(useViewer.getState().tree).find((n) => n.name === sphere.name)!.materials[0].id;
  for (const preset of MATERIAL_PRESETS) {
    console.log(`Rendering ${preset.label}`);
    engine.setMaterialValues(materialId, preset.values);
    shots.push([`material-${preset.id}`, await engine.renderImage({ ...MATERIAL_SIZE, transparent: false }, 'image/webp', 0.9)]);
  }
  for (const sample of MATERIALX_SAMPLES) {
    console.log(`Rendering ${sample.label}`);
    if (!await engine.importMaterialX(materialId, materialXSampleFiles(sample))) throw new Error(`Could not import ${sample.label}`);
    // Material edits commit on the next frame; then wait for the graph program.
    await new Promise(requestAnimationFrame);
    await engine.engine.waitForMaterialGraphs();
    shots.push([`materialx-${sample.id}`, await engine.renderImage({ ...MATERIAL_SIZE, transparent: false }, 'image/webp', 0.9)]);
  }

  // Save last: new files make Vite reload the page.
  await saveThumbnails(shots);
  setSettings(previous, { record: false });
  console.log(`Saved ${shots.length} thumbnails`);
}

Object.assign(window, { generateThumbnails });
