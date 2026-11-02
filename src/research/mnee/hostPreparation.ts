import {CausticSeedCache} from './seeds.js';
import {EmissiveTriangleCache} from '../../renderer/lightSampling.js';
import {prepareSceneLightSampling} from '../../renderer/sceneAssembly.js';
import {Texture2D as WebGLTexture2D} from '../../renderer/webgl.js';
import {commonNearestFloatProps, setDataTexture} from '../../renderer/dataTextureUtil.js';
// Adapters live with the experiment so production hosts allocate no seed caches or textures.
export function prepareResearch(pass: any, state: any, backend: 'webgpu' | 'webgl', lighting?: any) {
  state.seeds ??= new CausticSeedCache();
  if (backend === 'webgpu') {
    if (state.enabled && pass._preparedMeshData) {
      const seed = state.seeds.collect(
        pass._preparedMeshData.instanceBindings,
        pass._preparedMeshData.materials
      );
      const offset = lighting.lightData.length / 4;
      pass._constants.CAUSTIC_SEED_OFFSET = offset;
      pass._constants.CAUSTIC_SEED_COUNT = seed.count;
      const texels = offset + seed.data.length / 4,
        width = Math.min(Math.max(1, texels), pass._device.limits.maxTextureDimension2D),
        height = Math.ceil(texels / width);
      const data = new Float32Array(width * height * 4);
      data.set(lighting.lightData);
      data.set(seed.data, offset * 4);
      lighting.lightData = data;
      lighting.lightWidth = width;
      lighting.lightHeight = height;
    } else {
      delete pass._constants.CAUSTIC_SEED_OFFSET;
      delete pass._constants.CAUSTIC_SEED_COUNT;
    }

  } else {
    state.cache ??= new EmissiveTriangleCache();
    state.texture ??= new WebGLTexture2D(commonNearestFloatProps);
    if (state.enabled && pass._preparedMeshData) {
      const res = pass._preparedMeshData;
      const triangles = state.cache.collect(res.emissiveBindings, res.materials);
      const lighting = prepareSceneLightSampling(pass._analyticLights, triangles, 0, 4096);
      const pmfOffset = lighting.emissiveTexels + lighting.choiceCount;
      const seed=state.seeds.collect(res.instanceBindings,res.materials);
      const seedOffset=pmfOffset+lighting.choiceCount;
      const data = new Float32Array(Math.max(1, seedOffset+seed.data.length/4) * 4);
      data.set(seed.data,seedOffset*4);
      data.set(lighting.lightData.subarray(0, pmfOffset * 4));
      const choices = new Int32Array(data.buffer);
      for (let i=0; i<lighting.choiceCount; i++) {
        const type = choices[(lighting.emissiveTexels+i)*4+2], source = choices[(lighting.emissiveTexels+i)*4+3];
        data[(pmfOffset+i)*4] = type===2 ? lighting.analyticPmfs[source] : triangles[source].selectionPmf;
      }
      const columns = setDataTexture(state.texture, data, 4).columnsLog;
      pass._mainPass.setUniforms({mneeLightData:state.texture,mneeLightColumns:columns,
        mneeSeedOffset:seedOffset,mneeSeedCount:seed.count,mneeChoiceOffset:lighting.emissiveTexels,mneeChoiceCount:lighting.choiceCount,mneePmfOffset:pmfOffset});
    }

  }
}
