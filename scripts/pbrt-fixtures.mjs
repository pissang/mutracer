import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('tests/fixtures/pbrt', { recursive: true });
const film = 'Film "rgb" "integer xresolution" 128 "integer yresolution" 96\nSampler "sobol" "integer pixelsamples" 64\nIntegrator "path" "integer maxdepth" 5\nLookAt 0 1.2 -5 0 0.1 0 0 1 0\nCamera "perspective" "float fov" 40\nWorldBegin\n';
const floor = 'AttributeBegin Material "diffuse" "rgb reflectance" [.5 .5 .5]\nShape "trianglemesh" "point3 P" [-4 -.75 -4 -4 -.75 4 4 -.75 4 4 -.75 -4] "integer indices" [0 1 2 0 2 3]\nAttributeEnd\n';
const sphere = (material = 'Material "diffuse" "rgb reflectance" [.6 .2 .1]') => `AttributeBegin ${material}\nShape "sphere" "float radius" .75 AttributeEnd\n`;
const light = 'LightSource "point" "point3 from" [-2 3 -3] "rgb I" [30 30 30]\n';
const fixtures = {
  'back-face-surface': light + 'Material "diffuse" "rgb reflectance" [.6 .2 .1]\nShape "trianglemesh" "point3 P" [-1 -.75 0 1 -.75 0 0 1 0]\n',
  'interior-homogeneous': 'MakeNamedMedium "fog" "string type" "homogeneous" "rgb sigma_a" [.1 .1 .1] "rgb sigma_s" [.5 .5 .5]\n' + light + floor + sphere('MediumInterface "fog" "" Material "interface"'),
  handedness: light + floor + sphere() + 'AttributeBegin Translate 1.4 0 0 Material "diffuse" "rgb reflectance" [.1 .6 .2] Shape "sphere" "float radius" .3 AttributeEnd\n',
  'short-edge-fov': light + floor + sphere(),
  point: light + floor + sphere(),
  spot: 'LightSource "spot" "point3 from" [-2 3 -3] "point3 to" [0 0 0] "rgb I" [30 30 30]\n' + floor + sphere(),
  distant: 'LightSource "distant" "point3 from" [-2 3 -3] "point3 to" [0 0 0] "rgb L" [3 3 3]\n' + floor + sphere(),
  infinite: 'LightSource "infinite" "rgb L" [.6 .6 .6]\n' + floor + sphere(),
  'area-one-sided': 'AttributeBegin Translate 0 3 0 Rotate 90 1 0 0 AreaLightSource "diffuse" "rgb L" [4 4 4] Shape "disk" "float radius" 1 AttributeEnd\n' + floor + sphere(),
  'area-two-sided': 'AttributeBegin Translate 0 3 0 Rotate -90 1 0 0 AreaLightSource "diffuse" "rgb L" [4 4 4] "bool twosided" true Shape "disk" "float radius" 1 AttributeEnd\n' + floor + sphere(),
  'roughness-remap': light + floor + sphere('Material "conductor" "rgb reflectance" [.7 .7 .7] "float roughness" .0625'),
  'roughness-alpha': light + floor + sphere('Material "conductor" "rgb reflectance" [.7 .7 .7] "float roughness" .25 "bool remaproughness" false'),
  'named-metal': light + floor + sphere('Material "conductor" "spectrum eta" "metal-Au-eta" "spectrum k" "metal-Au-k" "float roughness" .01'),
  'named-glass': light + floor + sphere('Material "dielectric" "spectrum eta" "glass-BK7"'),
  'texture-direction': 'Texture "checker" "spectrum" "checkerboard" "rgb tex1" [1 .1 .1] "rgb tex2" [.1 .1 1] "float uscale" 4 "float vscale" 2\n' + light + floor + sphere('Material "diffuse" "texture reflectance" "checker"')
};
for (const [name, text] of Object.entries(fixtures)) {
  let header = film;
  if (name === 'short-edge-fov') header = header.replace('xresolution" 128', 'xresolution" 64').replace('yresolution" 96', 'yresolution" 128');
  if (name === 'interior-homogeneous') header = header.replace('Integrator "path"', 'Integrator "volpath"').replace('maxdepth" 5', 'maxdepth" 12');
  await writeFile(`tests/fixtures/pbrt/${name}.pbrt`, header + text);
}
// A small authored TGA makes the vertical orientation observable.
const tga = new Uint8Array(18 + 8 * 4 * 3); tga[2] = 2; tga[12] = 8; tga[14] = 4; tga[16] = 24; tga[17] = 0x20;
for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { const i = 18 + (y * 8 + x) * 3; tga.set(y < 2 ? [0, 0, 255] : [255, 0, 0], i); }
await writeFile('tests/fixtures/pbrt/direction.tga', tga);
await writeFile('tests/fixtures/pbrt/texture-direction.pbrt', film + 'Texture "image" "spectrum" "imagemap" "string filename" "direction.tga"\n' + light + floor + sphere('Material "diffuse" "texture reflectance" "image"'));
const { DataTexture, RGBAFormat, FloatType } = await import('three');
const { EXRExporter } = await import('three/examples/jsm/exporters/EXRExporter.js');
const pixels = new Float32Array(16 * 16 * 4);
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.set([x < 8 ? .8 : .1, y < 8 ? .6 : .05, .2, 1], (y * 16 + x) * 4);
const exr = await new EXRExporter().parse(new DataTexture(pixels, 16, 16, RGBAFormat, FloatType), { type: FloatType });
await writeFile('tests/fixtures/pbrt/equal-area.exr', exr);
await writeFile('tests/fixtures/pbrt/equal-area-environment.pbrt', film + 'LightSource "infinite" "string filename" "equal-area.exr"\n' + floor + sphere());
