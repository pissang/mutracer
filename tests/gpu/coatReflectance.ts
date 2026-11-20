import {
  Camera, Engine, EnvironmentLight, Mesh, OpenPBRMaterial, Render, Texture,
  createPlaneGeometry
} from '../../src/main.js';

const aovs = ['diffuseAlbedo', 'specularAlbedo'] as const;
const size = 12;
const fixtureSamples = 512;
const sequenceOffset = 73;
type Result = {
  name: string;
  diffuse: number[];
  specular: number[];
  reference: number[];
  error: number;
  hdr: number[];
};

function meanRgb(data: Float32Array) {
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) sum[c] += data[i + c];
  }
  return sum.map(value => value / (data.length / 4));
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function run() {
  const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  const render = new Render(engine, {
    width: size, height: size, bounces: 2, bevel: false, aovSamples: 1,
    maxTiles: 1, samplingPattern: 'sobol'
  });
  const material = new OpenPBRMaterial({baseColor: [.65, .23, .08], specularRoughness: .35});
  const plane = new Mesh(createPlaneGeometry(1, 1, 'vertical'), material);
  const camera = new Camera({projection: 'orthographic', left: -.07, right: .07, bottom: -.07, top: .07});
  const white = new Texture({width: 16, height: 8, data: new Float32Array(16 * 8 * 4).fill(1)});
  const coatMap = new Texture({width: 1, height: 1, data: new Uint8Array([128, 64, 0, 255])});
  const neutralColor = [1, 1, 1] as const;
  const rows: Result[] = [];

  const frame = async (samples: number) => {
    render.restart();
    await render.converge({samples, sampleSequenceOffset: sequenceOffset, timeoutMs: 90_000});
    if (engine.lastError) throw engine.lastError;
    const data = (await render.readPixels('hdr')).data as Float32Array;
    check(data.length === size * size * 4 && data.every(Number.isFinite), 'Invalid HDR framebuffer');
    check(data.every((value, index) => index % 4 !== 3 || value === 1), 'White-furnace plane must cover the image');
    return data.slice();
  };

  const setAngle = (cosine: number) => {
    camera.position = [Math.sqrt(1 - cosine ** 2) * 3, 0, cosine * 3];
    camera.lookAt([0, 0, 0]);
    engine.camera = camera;
  };

  function channelError(a: readonly number[], b: readonly number[]) {
    return Math.max(...a.map((value, c) => Math.abs(value - b[c])));
  }

  try {
    const info = await engine.init();
    check(engine.backend === backend, 'Unexpected GPU backend');
    engine.scene = {meshes: [plane], lights: [new EnvironmentLight({map: white})]};
    const cosine = .2;
    const cases = [
      {name: 'uncoated', coat: 0, roughness: .1, metal: 0, cosine: 1},
      {name: 'coated wood', coat: 1, roughness: .1, metal: 0, cosine: 1},
      {name: 'grazing metal', coat: .8, roughness: .35, metal: 1, cosine},
      {name: 'zero-roughness coat', coat: 1, roughness: 0, metal: 0, cosine, coatOnly: true},
      {name: 'textured weight and roughness', coat: 1, roughness: .4, metal: 0, cosine: 1, mapped: true},
      {name: 'equivalent constant coat', coat: 128 / 255, roughness: .4 * 64 / 255, metal: 0, cosine: 1},
    ];

    for (const fixture of cases) {
      setAngle(fixture.cosine);
      material.coatWeight = fixture.coat;
      material.coatRoughness = fixture.roughness;
      material.coatIor = 1.5;
      material.coatColor = [...neutralColor];
      material.coatWeightMap = fixture.mapped ? coatMap : undefined;
      material.coatRoughnessMap = fixture.mapped ? coatMap : undefined;
      material.baseMetalness = fixture.metal;
      material.baseWeight = fixture.coatOnly ? 0 : 1;
      material.specularWeight = fixture.coatOnly ? 0 : 1;
      engine.update();
      render.aovs = [];
      const raw = fixture.name === 'coated wood' ? await frame(4) : undefined;
      render.aovs = [...aovs];
      if (raw) check((await frame(4)).every((value, i) => Object.is(value, raw[i])),
        'Enabling layered guides changed fixed-seed beauty');
      const hdr = await frame(fixtureSamples);
      const albedos = await Promise.all(aovs.map(async kind => {
        const data = (await render.readPixels(kind)).data as Float32Array;
        check(data.length === hdr.length && data.every(Number.isFinite), `${fixture.name}: invalid ${kind} framebuffer`);
        check(data.every((value, i) => i % 4 === 3 ? value === 1 : value >= 0), `${fixture.name}: invalid ${kind} coverage or energy`);
        return meanRgb(data);
      }));
      const [diffuse, specular] = albedos;
      const reference = meanRgb(hdr);
      const error = channelError(reference, diffuse.map((value, c) => value + specular[c]));
      check(error <= .03, `${fixture.name}: white-furnace error ${error} (HDR ${reference}, diffuse ${diffuse}, specular ${specular})`);
      if (fixture.metal === 1 || fixture.coatOnly) check(diffuse.every(value => value === 0), `${fixture.name}: unexpected diffuse energy`);
      if (fixture.coatOnly) {
        const eta = 1 / 1.5;
        const ct = Math.sqrt(1 - eta ** 2 * (1 - cosine ** 2));
        const fresnel = .5 * (((eta * cosine - ct) / (eta * cosine + ct)) ** 2
          + ((cosine - eta * ct) / (cosine + eta * ct)) ** 2);
        check(channelError(specular, [fresnel, fresnel, fresnel]) < .005, 'Near-delta coat does not approach analytic Fresnel');
      }
      rows.push({name: fixture.name, diffuse, specular, reference, error, hdr: Array.from(hdr)});
    }
    check(rows[1].diffuse.every((value, c) => value < rows[0].diffuse[c]), 'Coat must attenuate substrate diffuse');
    const mapped = rows[4], constant = rows[5];
    check(channelError(mapped.diffuse, constant.diffuse) < .002 && channelError(mapped.specular, constant.specular) < .002,
      'Clearcoat texture slots must resolve to the equivalent constant values');
    return {backend, adapter: info.adapterName, samples: fixtureSamples, sequenceOffset, passed: true, rows};
  } finally {
    render.dispose();
    engine.dispose();
  }
}

const completion = run();
Object.assign(window, {coatReflectanceResult: completion});
completion.then(result => {
  document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
}, error => {
  document.querySelector('#result')!.textContent = String(error?.stack ?? error);
});
