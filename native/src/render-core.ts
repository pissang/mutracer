import { sceneParameters as prepareNativeScene } from './scene-core.js';
import { sceneCameraParameters as prepareSceneCamera } from './camera-core.js';
import { normalizeBounces } from '../../src/renderer/pathLimits.js';
import { packCameraUniform } from '../../src/renderer/cameraUniform.js';
import { buildBvh as buildBvhModule } from './bvh-core.js';
import { samplingParameters as buildSamplingParameters } from './sampling-core.js';

/** Experimental frame command: sample:f32, depth:i32, seed:u32, reserved:u32. */
export function frameParameters(sample: number, bounces: number, seed: number): Uint8Array {
  const data = new ArrayBuffer(16);
  new Float32Array(data)[0] = sample;
  new Int32Array(data)[1] = normalizeBounces(bounces);
  new Uint32Array(data)[2] = seed >>> 0;
  return new Uint8Array(data);
}

/** Translate a prepared camera in world space, preserving its lens/orientation. */
export function cameraParameters(bytes: Uint8Array, x: number, y: number, z: number): Uint8Array {
  const source = new Float32Array(bytes.buffer, bytes.byteOffset, 36);
  const inverse = new Float32Array(16);
  const world = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const i = column * 4;
    inverse[i] = source[i] + x * source[i + 3];
    inverse[i + 1] = source[i + 1] + y * source[i + 3];
    inverse[i + 2] = source[i + 2] + z * source[i + 3];
    inverse[i + 3] = source[i + 3];
    world[i] = source[16 + i];
    world[i + 1] = source[17 + i];
    world[i + 2] = source[18 + i];
    world[i + 3] = source[19 + i];
  }
  world[12] += x; world[13] += y; world[14] += z;
  return new Uint8Array(packCameraUniform(inverse, world, source[32], source[33]).buffer);
}

/** Patch values only; the prepared scene supplies authoritative material offsets. */
export function materialParameters(r: number, g: number, b: number, roughness: number): Uint8Array {
  return new Uint8Array(new Float32Array([r, g, b, roughness]).buffer);
}


export function buildBvh(bytes: Uint8Array): Uint8Array { return buildBvhModule(bytes); }
export function samplingParameters(bytes: Uint8Array): Uint8Array { return buildSamplingParameters(bytes); }

export function sceneParameters(bytes: Uint8Array): Uint8Array { return prepareNativeScene(bytes); }

export function sceneCameraParameters(bytes: Uint8Array, width: number, height: number): Uint8Array {
  return prepareSceneCamera(bytes, width, height);
}

import {retainedSceneParameters as prepareRetained, releaseSceneParameters as releaseRetained,
  sceneMaterialParameters as prepareMaterial, sceneEnvironmentParameters as prepareEnvironment, sceneLightParameters as prepareLight, acceptSceneLighting as acceptLighting} from './scene-core.js';
export function retainedSceneParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareRetained(bytes, token); }
export function releaseSceneParameters(token: number): Uint8Array { return releaseRetained(token); }
export function sceneMaterialParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareMaterial(bytes, token); }

export function sceneEnvironmentParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareEnvironment(bytes, token); }

export function sceneLightParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareLight(bytes, token); }

import {sceneTargetParameters as prepareTarget} from './scene-core.js';
export function sceneTargetParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareTarget(bytes, token); }
export function acceptSceneLighting(token: number): Uint8Array { return acceptLighting(token); }

import {sceneTransformParameters as prepareTransform, acceptSceneTransform as acceptTransform} from './scene-core.js';
export function sceneTransformParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareTransform(bytes, token); }
export function acceptSceneTransform(token: number): Uint8Array { return acceptTransform(token); }

import {sceneGeometryParameters as prepareGeometry, acceptSceneGeometry as acceptGeometry} from './scene-core.js';
export function sceneGeometryParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareGeometry(bytes, token); }
export function acceptSceneGeometry(token: number): Uint8Array { return acceptGeometry(token); }

import {nativeHardwareScene as hardwareScene, nativeSceneBegin as beginScene, nativeSceneBlas as sceneBlas, nativeSceneFinish as finishScene} from './scene-core.js';
export function nativeHardwareScene(bytes: Uint8Array, token: number): Uint8Array {return hardwareScene(bytes, token);}
export function nativeSceneBegin(bytes: Uint8Array, token: number): Uint8Array {return beginScene(bytes, token);}
export function nativeSceneBlas(bytes: Uint8Array, token: number): Uint8Array {return sceneBlas(bytes, token);}
export function nativeSceneFinish(bytes: Uint8Array, token: number): Uint8Array {return finishScene(bytes, token);}

import {nativeTransformBegin as beginTransform, nativeTransformFinish as finishTransform,
  nativeGeometryBegin as beginGeometry, nativeGeometryFinish as finishGeometry} from './scene-core.js';
export function nativeTransformBegin(bytes: Uint8Array, token: number): Uint8Array {return beginTransform(bytes,token);}
export function nativeTransformFinish(bytes: Uint8Array, token: number): Uint8Array {return finishTransform(bytes,token);}
export function nativeGeometryBegin(bytes: Uint8Array, token: number): Uint8Array {return beginGeometry(bytes,token);}
export function nativeGeometryFinish(bytes: Uint8Array, token: number): Uint8Array {return finishGeometry(bytes,token);}

import {configureSceneParameters as configureScene} from './scene-core.js';
export function configureSceneParameters(bytes: Uint8Array, token: number): Uint8Array { return configureScene(bytes, token); }

import {nativeShaderVariantStats} from './shader-variants.js';
export function shaderCacheParameters(): Uint8Array {
  const stats = nativeShaderVariantStats();
  return new Uint8Array(new Uint32Array([stats.generated, stats.hits, stats.retained, 0]).buffer);
}

import {receiveGeometryKernelHints as receiveKernelHints} from './geometry-kernel-hints.js';
import {geometryKernelReference as referenceKernels} from './scene-core.js';
export function receiveGeometryKernelHints(bytes:Uint8Array,token:number):Uint8Array {return receiveKernelHints(bytes,token,true);}
export function geometryKernelReference(bytes:Uint8Array,withBounds:number):Uint8Array {return referenceKernels(bytes,withBounds);}
export function geometryKernelHypot(x: number,y: number,z: number): number {return Math.hypot(x,y,z);}

// Incremental sync (descriptor diff + shared change detection); the host wires it in a later phase.
import {syncNativeScene as syncScene, acceptNativeScene as acceptScene, releaseNativeScene as releaseScene} from './scene-sync.js';
import {sceneErrorPacket} from './scene-errors.js';
import {ERROR_CODE} from './layout.js';
// The export wrapper copies the host's input, so the sync may keep it.
export function syncNativeScene(bytes: Uint8Array, token: number): Uint8Array {
  try { return syncScene(bytes, token, true); } catch (error) { return sceneErrorPacket(ERROR_CODE.RETAINED_SCENE, error); }
}
export function acceptNativeScene(token: number): Uint8Array { return acceptScene(token); }
import {receiveNativeSyncHints as receiveSyncHints} from './scene-sync.js';
export function receiveNativeSyncHints(bytes: Uint8Array, token: number): Uint8Array { return receiveSyncHints(bytes, token); }
export function releaseNativeScene(token: number): Uint8Array { return releaseScene(token); }

import {sceneLightListParameters as prepareLightList} from './scene-core.js';
export function sceneLightListParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareLightList(bytes, token); }
import {sceneInstanceColorParameters as prepareInstanceColors} from './scene-core.js';
export function sceneInstanceColorParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareInstanceColors(bytes, token); }
import {sceneAtlasParameters as prepareAtlas} from './scene-core.js';
export function sceneAtlasParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareAtlas(bytes, token); }

import {sceneAovParameters as prepareAov} from './scene-core.js';
export function sceneAovParameters(bytes: Uint8Array, token: number): Uint8Array {return prepareAov(bytes,token);}

import {jnlmParameters as prepareJnlm} from './jnlm-core.js';
export function jnlmParameters(width: number, height: number, strength: number,
  searchRadius: number, patchRadius: number, albedoBandwidth: number,
  normalBandwidth: number, iterations: number): Uint8Array {
  return prepareJnlm(width, height, strength, searchRadius, patchRadius,
    albedoBandwidth, normalBandwidth, iterations);
}

import {postprocessParameters as preparePostprocess} from './postprocess.js';
export function postprocessParameters(): Uint8Array { return preparePostprocess(); }

import {bloomParameters as prepareBloom} from './postprocess.js';
export function bloomParameters(radius: number): Uint8Array { return prepareBloom(radius); }

import {viewerParameters as prepareViewer} from './viewer-core.js';
export function viewerParameters(kind: number, bytes: Uint8Array): Uint8Array { return prepareViewer(kind, bytes); }

import {preparationProfile as profilePreparation} from './preparation-profile.js';
export function preparationProfile(on: number): Uint8Array { return profilePreparation(on); }

import {sceneSurfaceHitParameters as surfaceHit} from './scene-core.js';
export function sceneSurfaceHitParameters(bytes: Uint8Array, token: number): Uint8Array {return surfaceHit(bytes,token);}

import {compactKernelParameters as compactCommand} from './compact-kernel.js';
export function compactKernelParameters(bytes: Uint8Array, token: number): Uint8Array { return compactCommand(bytes, token); }
import {compactKernelReference as compactReference} from './compact-kernel-reference.js';
export function compactKernelReference(bytes: Uint8Array, normalFloat: number): Uint8Array { return compactReference(bytes, normalFloat); }
