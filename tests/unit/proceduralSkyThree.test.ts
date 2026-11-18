import * as THREE from 'three';
import { expect, it } from 'vitest';
import { Engine, ProceduralSky } from '../../src/main';
import { THREESync, fromTHREEScene } from '../../src/three';

it('overrides Three.js lighting without losing rotation, intensity or grounded backgrounds', () => {
  const sky = new ProceduralSky({ time: 9 });
  const scene = new THREE.Scene();
  scene.environmentIntensity = 2;
  scene.environmentRotation.y = .5;
  scene.userData.mutracerGroundedSkybox = { texture: sky, height: 2, radius: 50 };
  const converted = fromTHREEScene(scene, { environment: sky });
  expect(converted.lights[0]).toMatchObject({ map: sky, intensity: 2 });
  expect(converted.background).toMatchObject({ type: 'GroundedSkybox', map: sky });
  const convertedLight = converted.lights[0];
  if (convertedLight.type !== 'EnvironmentLight') throw new Error('Expected environment');
  expect(convertedLight.transform[0]).toBeCloseTo(Math.cos(.5));
  const engine = new Engine({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  const options = { scene, environment: sky as import('../../src/main').Texture | undefined };
  const sync = new THREESync(engine, options);
  sync.update();
  const light = sync.scene!.lights[0];
  sky.time = 12; sync.update();
  expect(sync.scene!.lights[0]).toBe(light);
  expect(sync.scene!.lights[0]).toMatchObject({ map: { time: 12 } });
  options.environment = undefined; sync.update();
  expect(sync.scene!.lights).toHaveLength(0);
  sync.dispose(); engine.dispose();
});
