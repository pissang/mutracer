// Compare native import with the browser's actual GLTFLoader -> THREESync path.
// Run the gltf_browser_reference_fixture Rust test with MUTRACER_GLTF_EVIDENCE,
// then npm run build:lib and node this-file.mjs EVIDENCE_DIRECTORY.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {Engine} from '../../lib/main.js';
import { THREESync } from '../../lib/three.js';

const dir = resolve(process.argv[2] ?? (() => {throw new Error('Expected evidence directory');})());
const bytes = await readFile(resolve(dir, 'layers.gltf'), 'utf8');
const native = JSON.parse(await readFile(resolve(dir, 'native-material.json'), 'utf8'));
globalThis.ProgressEvent ??= class ProgressEvent {constructor(type, fields) {this.type = type; Object.assign(this, fields);}};
const loader = new GLTFLoader();
// The fixture has two known 1x1 PNGs. Supply their decoded pixels in Node,
// which has no image element; GLTFLoader still loads all geometry/extensions.
loader.register(parser => ({name: 'FIXTURE_NODE_IMAGES', loadTexture(index) {
  const source = parser.json.textures[index].source;
  const pixels = [[128,64,192,255],[64,192,128,160]][source];
  assert.ok(pixels);
  const texture = new THREE.DataTexture(new Uint8Array(pixels),1,1);
  texture.flipY = false;
  texture.needsUpdate = true;
  return Promise.resolve(texture);
}}));
const gltf = await loader.parseAsync(bytes, '');
const sync = new THREESync(new Engine({canvas: {width:1,height:1}}), {scene:gltf.scene});
sync.update();
const material = sync.scene.meshes[0].materials[0];
const fields = ['baseColor','baseMetalness','specularRoughness','transmissionWeight','specularIor',
  'specularWeight','specularColor','coatWeight','coatRoughness','coatIor','coatDarkening',
  'coatNormalScale','fuzzWeight','fuzzColor','fuzzRoughness','transmissionColor','transmissionDepth',
  'transmissionDispersionScale','thinFilmWeight','thinFilmThickness','thinFilmIor','thinFilmThicknessMinimum',
  'specularAnisotropyRotation'];
function close(actual,expected,label) {
  if (Array.isArray(expected)) {assert.equal(actual.length,expected.length,label);expected.forEach((v,i)=>close(actual[i],v,`${label}[${i}]`));}
  else assert.ok(Number.isFinite(actual) && Math.abs(actual-expected)<2e-6,`${label}: ${actual} != ${expected}`);
}
for (const key of fields) close(material[key],native.values[key],key);
close(material.specularRoughnessAnisotropy,native.values.specularAnisotropy,'anisotropy');
assert.equal(material.thinFilmMapChannel,'g');
assert.equal(material.specularAnisotropyModel,'gltf');
for (const [key,expected] of Object.entries(native.maps)) {
  const map=material[key];
  assert.ok(map,`${key} missing`);
  assert.deepEqual([...map.image.data],expected.pixels,key);
  assert.equal(map.uvChannel,expected.uv,key);
  close(map.uvScale,expected.scale,`${key}.scale`);
  close(map.uvOffset,expected.offset,`${key}.offset`);
}
const report={validated:true,scalarFields:fields.length+1,textureMaps:Object.keys(native.maps).length,
  volume:'native uses thicknessFactor to choose solid geometry; browser conversion keeps its own thin-wall default'};
await writeFile(resolve(dir,'browser-material-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
