import * as THREE from 'three';
import { expect, it } from 'vitest';
import { fromTHREEScene } from '@meimu/mutracer/three';
import { Environment } from '../src/engine/environment';

it('updates scene intensity and orientation without rewriting radiance pixels', () => {
  const source={width:2,height:1,data:new Float32Array([2,1,.5,1,.25,.5,1,1])};
  const environment=new Environment(source), scene=new THREE.Scene(), texture=environment.texture, version=texture.version;
  environment.apply(scene,2,-90);
  expect(scene.environment).toBe(texture); expect(scene.environmentIntensity).toBe(2);
  expect(scene.environmentRotation.y).toBeCloseTo(1.5*Math.PI);
  expect(texture.image.data).toBe(source.data); expect(texture.version).toBe(version);
  const converted=fromTHREEScene(scene);
  expect(converted.background).toBeUndefined(); expect(converted.lights[0]).toMatchObject({type:'EnvironmentLight',intensity:2});
  environment.apply(scene,0,360);
  expect(scene.environmentIntensity).toBe(0); expect(scene.environmentRotation.y).toBe(0);
  expect(texture.version).toBe(version); environment.dispose();
});

it('keeps source data immutable through tint edits and HDR replacements', () => {
  const source={width:1,height:1,data:new Float32Array([2,1,.5,.75])}, environment=new Environment(source), original=environment.texture;
  environment.setTint([.5,1,2]);
  expect(environment.texture.image.data).toEqual(new Float32Array([1,1,1,.75]));
  expect(source.data).toEqual(new Float32Array([2,1,.5,.75]));
  environment.setSource({width:1,height:1,data:new Float32Array([4,2,1,1])});
  expect(environment.texture).toBe(original); expect(environment.texture.image.data).toEqual(new Float32Array([2,2,2,1]));
  environment.setSource({width:2,height:1,data:new Float32Array(8).fill(1)});
  expect(environment.texture).not.toBe(original); expect(environment.texture.image.width).toBe(2); environment.dispose();
});
