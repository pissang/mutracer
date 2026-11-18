import * as THREE from 'three';
import { expect, it } from 'vitest';
import { Texture, type GroundedSkyboxBackground } from '../../src/main';
import { fromTHREEScene } from '../../src/three';
import { backgroundMapTransform, generateBackgroundMapFromSceneBackground } from '../../src/renderer/envMapCreation';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';

const background = (): GroundedSkyboxBackground => ({type:'GroundedSkybox',map:new Texture({width:1,height:1,data:new Float32Array([2,1,.5,.75])}),height:1.6,radius:30});

it('uses identity defaults and packs yaw and intensity independently of pixels', () => {
  expect(backgroundMapTransform()).toEqual(new Float32Array([1,0,1,0]));
  const bg=background(), image=generateBackgroundMapFromSceneBackground(bg);
  bg.rotation=Math.PI/2; bg.intensity=2;
  const transform=backgroundMapTransform(bg);
  expect(transform[0]).toBeCloseTo(0); expect(transform[1]).toBe(1); expect(transform[2]).toBe(2);
  expect(generateBackgroundMapFromSceneBackground(bg)).toBe(image);
  if (!image || 'sky' in image) throw new Error('Expected CPU pixels');
  expect(Array.from(image.data)).toEqual([2,1,.5,.75]);
  bg.map.markUpdated(); expect(generateBackgroundMapFromSceneBackground(bg)).not.toBe(image);
});

it('detects background orientation and intensity edits without dirtying lights', () => {
  const bg=background(), scene={meshes:[],lights:[],background:bg}, detector=new SceneChangeDetector();
  detector.detect(scene); detector.commit(); bg.rotation=.5;
  expect(detector.detect(scene).background).toBe(true); expect(detector.detect(scene).lights).toBe(false);
  detector.commit(); bg.intensity=0; expect(detector.detect(scene).background).toBe(true);
});

it('converts grounded metadata while preserving source lighting settings', () => {
  const scene=new THREE.Scene(), map=new THREE.DataTexture(new Float32Array([1,2,3,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
  scene.environment=map; scene.environmentIntensity=.5;
  scene.userData.mutracerGroundedSkybox={texture:map,height:1.6,radius:30,intensity:2,rotation:.75};
  const converted=fromTHREEScene(scene);
  expect(converted.background).toMatchObject({type:'GroundedSkybox',intensity:2,rotation:.75});
  expect(converted.lights[0]).toMatchObject({type:'EnvironmentLight',intensity:.5});
});
