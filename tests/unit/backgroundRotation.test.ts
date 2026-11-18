import * as THREE from 'three';
import { expect, it } from 'vitest';
import { Engine, Texture, type EquirectBackground } from '../../src/main';
import { THREESync, fromTHREEScene } from '../../src/three';
import { backgroundMapRotation, backgroundMapTransform, generateBackgroundMapFromSceneBackground } from '../../src/renderer/envMapCreation';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';

const map = () => new THREE.DataTexture(new Float32Array([2,1,.5,.75]),1,1,THREE.RGBAFormat,THREE.FloatType);

it('synchronizes all background Euler orders independently of environment rotation and back to zero', () => {
  const source = new THREE.Scene();
  source.background = source.environment = map();
  source.environmentRotation.set(.4,-.5,.6);
  const sync = new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene:source});
  sync.update();
  const unrotated = sync.scene!.background;
  expect(unrotated).toBeInstanceOf(Texture);
  for (const order of ['XYZ','XZY','YXZ','YZX','ZXY','ZYX'] as const) {
    source.backgroundRotation.set(.2,.7,-.3,order); sync.update();
    const bg = sync.scene!.background as EquirectBackground;
    expect(bg.type).toBe('Equirect'); expect(bg.map).toBe(unrotated);
    expect(Array.from(backgroundMapRotation(bg))).toEqual(Array.from(new Float32Array(
      new THREE.Matrix4().makeRotationFromEuler(source.backgroundRotation).elements)));
    sync.update(); expect(sync.scene!.background).toBe(bg);
    source.backgroundRotation.y += .1; sync.update(); expect(sync.scene!.background).toBe(bg);
    expect(Array.from(backgroundMapRotation(bg))).toEqual(Array.from(new Float32Array(
      new THREE.Matrix4().makeRotationFromEuler(source.backgroundRotation).elements)));
    const light = sync.scene!.lights[0];
    if (light.type !== 'EnvironmentLight') throw new Error('Expected an environment light');
    expect(light.transform).toEqual(new THREE.Matrix4().makeRotationFromEuler(source.environmentRotation).elements);
  }
  source.backgroundRotation.set(0,0,0); sync.update();
  expect(sync.scene!.background).toBe(unrotated);
  source.background = map(); source.backgroundRotation.y = .5; sync.update();
  expect((sync.scene!.background as EquirectBackground).map).not.toBe(unrotated);
  sync.dispose();
});

it('packs map-to-world rotation without translating, scaling or rebuilding background pixels', () => {
  const bg: EquirectBackground = {type:'Equirect', map:new Texture({width:1,height:1,data:new Float32Array([2,1,.5,.75])})};
  const pixels = generateBackgroundMapFromSceneBackground(bg);
  expect(backgroundMapRotation(bg)).toEqual(backgroundMapRotation());
  bg.transform = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.3,.5,-.2)).elements;
  const rotation = backgroundMapRotation(bg);
  bg.transform = new THREE.Matrix4().fromArray(bg.transform).scale(new THREE.Vector3(2,3,4)).setPosition(5,6,7).elements;
  expect(backgroundMapRotation(bg)).toEqual(rotation);
  expect(generateBackgroundMapFromSceneBackground(bg)).toBe(pixels);
  const detector = new SceneChangeDetector(), scene = {meshes:[],lights:[],background:bg};
  detector.detect(scene); detector.commit(); bg.transform[0] += .2;
  expect(detector.detect(scene).background).toBe(true);
  expect(detector.detect(scene).lights).toBe(false);
  detector.commit(); bg.map.markUpdated(); expect(detector.detect(scene).background).toBe(true);
});

it('keeps grounded yaw independent, including when switching between background kinds', () => {
  const source = new THREE.Scene(), texture = map();
  source.background = texture; source.backgroundRotation.set(.3,.7,-.2,'ZYX');
  const sync = new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene:source});
  sync.update(); const equirect = sync.scene!.background;
  for (const rotation of [undefined, 0, .75]) {
    source.userData.mutracerGroundedSkybox = {texture,height:1.6,radius:30,rotation}; sync.update();
    const bg = sync.scene!.background;
    expect(bg).not.toBe(equirect);
    expect(bg).toMatchObject({type:'GroundedSkybox',rotation});
    expect(backgroundMapRotation(bg)).toEqual(backgroundMapRotation());
    source.backgroundRotation.set(-.2,.5,.8,'XZY'); sync.update(); expect(sync.scene!.background).toBe(bg);
  }
  delete source.userData.mutracerGroundedSkybox; sync.update();
  expect(sync.scene!.background).toMatchObject({type:'Equirect'});
  expect(sync.scene!.background).not.toHaveProperty('height');
  sync.dispose();
});

it('ignores backgroundRotation for colors, hidden backgrounds and the implicit environment background', () => {
  const source = new THREE.Scene(); source.environment = map(); source.backgroundRotation.set(.2,.7,.3);
  expect(fromTHREEScene(source).background).toBeUndefined();
  source.background = new THREE.Color(.1,.2,.3);
  expect(fromTHREEScene(source).background).toEqual([.1,.2,.3,1]);
  source.background = source.environment; source.userData.mutracerHiddenBackground = true;
  expect(fromTHREEScene(source).background).toEqual([0,0,0,0]);
});

it('synchronizes backgroundIntensity onto texture backgrounds only', () => {
  const source = new THREE.Scene(), texture = map();
  source.background = source.environment = texture; source.backgroundIntensity = 2.5;
  const sync = new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene:source});
  sync.update();
  const bg = sync.scene!.background as EquirectBackground;
  expect(bg).toMatchObject({type:'Equirect', intensity:2.5, transform:undefined});
  expect(backgroundMapRotation(bg)).toEqual(backgroundMapRotation());
  expect(backgroundMapTransform(bg)[2]).toBe(2.5);
  const light = sync.scene!.lights[0];
  if (light.type !== 'EnvironmentLight') throw new Error('Expected an environment light');
  expect(light.intensity).toBe(1);
  source.backgroundIntensity = .5; source.backgroundRotation.y = .3; sync.update();
  expect(sync.scene!.background).toBe(bg);
  expect(backgroundMapTransform(bg)[2]).toBe(.5);
  expect(bg.transform).toBeDefined();
  source.backgroundIntensity = 1; sync.update();
  expect(sync.scene!.background).toBe(bg); expect(bg.intensity).toBeUndefined();
  source.backgroundRotation.y = 0; sync.update();
  expect(sync.scene!.background).toBe(bg.map);
  source.backgroundIntensity = 3;
  source.userData.mutracerGroundedSkybox = {texture,height:1.6,radius:30}; sync.update();
  expect(backgroundMapTransform(sync.scene!.background)[2]).toBe(1);
  delete source.userData.mutracerGroundedSkybox; source.background = new THREE.Color(.1,.2,.3); sync.update();
  expect(sync.scene!.background).toEqual([.1,.2,.3,1]);
  sync.dispose();
});

it('clamps negative equirect intensity without rebuilding background pixels', () => {
  const bg: EquirectBackground = {type:'Equirect', map:new Texture({width:1,height:1,data:new Float32Array([2,1,.5,.75])})};
  const pixels = generateBackgroundMapFromSceneBackground(bg);
  expect(Array.from(backgroundMapTransform(bg))).toEqual([1,0,1,0]);
  bg.intensity = -2;
  expect(backgroundMapTransform(bg)[2]).toBe(0);
  expect(generateBackgroundMapFromSceneBackground(bg)).toBe(pixels);
  const detector = new SceneChangeDetector(), scene = {meshes:[],lights:[],background:bg};
  detector.detect(scene); detector.commit(); bg.intensity = 4;
  expect(detector.detect(scene).background).toBe(true);
});
