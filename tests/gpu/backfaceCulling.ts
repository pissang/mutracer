// Open backfaceCulling.html on a real GPU, with ?webgl for WebGL 2.
import {
  Camera, DirectionalLight, Engine, Geometry, GeometryAttribute as Attribute, Mesh, OpenPBRMaterial, Render
} from '../../src/main.js';

function quad(corners: number[][], normal: number[]) {
  return new Geometry({
    position: new Attribute(new Float32Array(corners.flat()), 3),
    normal: new Attribute(new Float32Array(Array(4).fill(normal).flat()), 3),
    indices: new Attribute(new Uint32Array([0, 1, 2, 2, 1, 3]), 1)
  });
}
function merged(a: Geometry, b: Geometry) {
  const count = a.position.array.length / 3;
  return new Geometry({
    position: new Attribute(new Float32Array([...a.position.array, ...b.position.array]), 3),
    normal: new Attribute(new Float32Array([...a.normal.array, ...b.normal.array]), 3),
    indices: new Attribute(new Uint32Array([...a.indices.array, ...[...b.indices.array].map(i => i + count)]), 1)
  });
}

// Each case puts a single-sided backface between the camera and a front-facing
// quad. Culled backfaces must neither stop the ray nor alter the accepted hit.
// A flat front quad is usually reached after the backface; a tilted one, whose
// bounds start nearer the camera, is usually reached before it.
const tilt = Math.SQRT1_2;
const fronts = {
  flat: quad([[-1, 0, -1], [-1, 0, 1], [1, 0, -1], [1, 0, 1]], [0, 1, 0]),
  tilted: quad([[-1, 2.5, -1], [-1, 0, 1], [1, 2.5, -1], [1, 0, 1]], [0, tilt, tilt])
};
const back = quad([[-.6, 2, -.6], [.6, 2, -.6], [-.6, 2, .6], [.6, 2, .6]], [0, -1, 0]);
// Outside the view, this wall shadows the front quads from the light.
const wall = quad([[-3, -1, 1.5], [3, -1, 1.5], [-3, 4, 1.5], [3, 4, 1.5]], [0, 0, 1]);

export async function capture() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: 16, height: 16, bounces: 1, bevel: false});
  render.aovs = ['depth'];
  const camera = new Camera({projection: 'orthographic', left: -.5, right: .5, bottom: -.5, top: .5});
  camera.position = [0, 3, 0]; camera.lookAt([0, 0, 0], [0, 0, -1]);
  engine.camera = camera;
  const material = new OpenPBRMaterial({baseColor: [.5, .4, .3]});
  const blocker = new Mesh(wall, new OpenPBRMaterial({baseColor: [0, 0, 0], doubleSided: true}));
  // Light travels along -Z, parallel to the backface, so only the wall blocks
  // it. A corrupted hit normal used to offset shadow rays leaks light past it.
  const light = new DirectionalLight({intensity: 2});
  light.position = [0, 0, 5]; light.lookAt([0, 0, 0]);
  const frame = async (meshes: Mesh[]) => {
    engine.scene = {meshes: [blocker, ...meshes], lights: [light], background: [0, 0, 0, 1]};
    engine.update();
    await render.converge({samples: 2, sampleSequenceOffset: 0});
    return {
      hdr: (await render.readPixels('hdr')).data,
      normal: (await render.readPixels('normal')).data,
      albedo: (await render.readPixels('albedo')).data,
      depth: (await render.readPixels('depth')).data as Float32Array
    };
  };
  const failures: string[] = [];
  try {
    const info = await engine.init();
    for (const [name, front] of Object.entries(fronts)) {
      const reference = await frame([new Mesh(front, material)]);
      const layouts = {
        meshes: [new Mesh(front, material), new Mesh(back, material)],
        'front-back': [new Mesh(merged(front, back), material)],
        'back-front': [new Mesh(merged(back, front), material)]
      };
      for (const [layout, meshes] of Object.entries(layouts)) {
        const actual = await frame(meshes);
        for (const kind of ['hdr', 'normal', 'albedo', 'depth'] as const) {
          const bad = actual[kind].findIndex((v, i) => !(Math.abs(v - reference[kind][i]) <= 1e-6));
          if (bad >= 0) failures.push(`${name} ${layout} ${kind}[${bad}] = ${actual[kind][bad]}, expected ${reference[kind][bad]}`);
        }
      }
    }
    return {backend: engine.backend, adapter: info.adapterName, failures};
  } finally {
    render.dispose(); engine.dispose(); canvas.remove();
  }
}

const result = document.getElementById('result');
capture().then(
  value => { result!.textContent = JSON.stringify(value, null, 2); (window as unknown as {backfaceResult: unknown}).backfaceResult = value; },
  error => { result!.textContent = String(error?.stack ?? error); (window as unknown as {backfaceResult: unknown}).backfaceResult = {error: String(error)}; }
);
