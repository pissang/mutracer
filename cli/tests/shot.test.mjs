import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const binary = fileURLToPath(new URL('../dist/main.mjs',import.meta.url));
const native = process.env.MUTRACER_BIN;
async function validate(file) {
  return run(process.execPath,[binary,'validate',file]);
}

test('native-backed glTF loader decodes the texture and validates a repeatable pose', {skip: !native}, async () => {
  const file = fileURLToPath(new URL('../examples/gltf-animation.js',import.meta.url));
  const {stdout} = await validate(file);
  assert.equal(JSON.parse(stdout).event,'validated');
});

test('unsupported materials report the originating object', {skip: !native}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'mutracer-node-'));
  try {
    const file = join(dir,'unsupported.mjs');
    await writeFile(file,`
      export const output={duration:1,size:[64,48],spp:1};
      export function setup({THREE}) {
        const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(30);
        camera.position.z=3;
        const mesh=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshToonMaterial());
        mesh.name='Toon panel';
        scene.add(mesh);
        return {scene,camera};
      }
      export function frame() {}
    `);
    await assert.rejects(validate(file), error => error.code === 2 && /Toon panel.*MeshToonMaterial/.test(error.stderr));
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('authored frame updates must be deterministic', {skip: !native}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'mutracer-node-'));
  try {
    const file = join(dir,'drift.mjs');
    await writeFile(file,`
      export const output={duration:1,size:[64,48],spp:1};
      export function setup({THREE}) {
        const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(30);
        camera.position.z=3;
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshPhongMaterial()));
        return {scene,camera};
      }
      export function frame({scene}) { scene.children[0].rotation.y += 0.2; }
    `);
    await assert.rejects(validate(file), error => error.code === 2 && /not deterministic/.test(error.stderr));
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
