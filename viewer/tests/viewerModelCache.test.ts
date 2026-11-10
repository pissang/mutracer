/// <reference lib="dom" />
import {MaterialGraph,Texture} from '@meimu/mutracer';
import {archiveGraph,restoreGraph,rememberGraphImage} from '../src/engine/materialxGraphArchive';
import { File } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMaterialEdits, clearModelCache, readMaterialEdits, readModelCache, saveMaterialEdits, saveModelCache, type CachedModel
} from '../src/engine/modelCache';

function filesystem() {
  const files = new Map<string, Blob>();
  let fail = false;
  const abort = vi.fn(async () => {});
  const dir = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) throw new Error('Not found');
        files.set(name, new Blob());
      }
      return {
        getFile: async () => files.get(name),
        createWritable: async () => {
          let pending: Blob;
          return {
            write: async (blob: Blob) => { if (fail) throw new Error('Quota'); pending = blob; },
            close: async () => { files.set(name, pending); }, abort
          };
        }
      };
    },
    removeEntry: async (name: string) => { files.delete(name); }
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
  return { files, abort, fail: () => { fail = true; } };
}

function model(id = 'first'): CachedModel {
  return {
    id, meta: { name: `${id}.gltf`, presetId: null, credit: null, sourceUrl: null },
    source: {
      mainPath: 'folder/scene.gltf', base: '',
      files: [
        { path: 'folder/scene.gltf', file: new File(['{"asset":{"version":"2.0"}}'], 'scene.gltf', { lastModified: 42 }) as unknown as globalThis.File },
        { path: 'folder/mesh.bin', file: new File([new Uint8Array([0, 1, 255])], 'mesh.bin') as unknown as globalThis.File },
        { path: 'folder/textures/base.png', file: new File(['pixels'], 'base.png', { type: 'image/png' }) as unknown as globalThis.File }
      ]
    }
  };
}

describe('current model OPFS cache', () => {
  beforeEach(() => { vi.stubGlobal('File', File); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('restores original model files, paths and metadata from one archive', async () => {
    const fs = filesystem();
    const original = model();
    await saveModelCache(original);
    expect(fs.files.size).toBe(1);
    const restored = (await readModelCache())!;
    expect(restored.id).toBe(original.id);
    expect(restored.meta).toEqual(original.meta);
    expect(restored.source?.mainPath).toBe('folder/scene.gltf');
    for (let i = 0; i < original.source!.files.length; i++) {
      const before = original.source!.files[i];
      const after = restored.source!.files[i];
      expect(after.path).toBe(before.path);
      expect(after.file.name).toBe(before.file.name);
      expect(after.file.type).toBe(before.file.type);
      expect(after.file.lastModified).toBe(before.file.lastModified);
      expect(await after.file.arrayBuffer()).toEqual(await before.file.arrayBuffer());
    }
  });

  it('serializes replacements and keeps only the latest model', async () => {
    const fs = filesystem();
    await Promise.all([saveModelCache(model('old')), saveModelCache(model('current'))]);
    expect(fs.files.size).toBe(1);
    expect((await readModelCache())?.meta.name).toBe('current.gltf');
    const procedural = { id: 'preset:spheres', meta: { name: 'Spheres', presetId: 'spheres', credit: null, sourceUrl: null } };
    await saveModelCache(procedural);
    expect(await readModelCache()).toEqual({ ...procedural, source: undefined });
    expect(fs.files.size).toBe(1);
    await clearModelCache();
    expect(fs.files.size).toBe(0);
  });

  it('rejects truncated or malformed archives', async () => {
    const fs = filesystem();
    await saveModelCache(model());
    const blob = fs.files.get('current.model')!;
    fs.files.set('current.model', blob.slice(0, blob.size - 1));
    expect(await readModelCache()).toBeNull();
    fs.files.set('current.model', new Blob(['invalid']));
    expect(await readModelCache()).toBeNull();
  });

  it('drops stale data if writing a replacement fails, without rejecting the load', async () => {
    const fs = filesystem();
    await saveModelCache(model());
    fs.fail();
    await expect(saveModelCache(model('new'))).resolves.toBeUndefined();
    expect(fs.abort).toHaveBeenCalledOnce();
    expect(await readModelCache()).toBeNull();
    expect(fs.files.size).toBe(0);
  });

  it('degrades gracefully when OPFS is unavailable or denied', async () => {
    vi.stubGlobal('navigator', {});
    await expect(saveModelCache(model())).resolves.toBeUndefined();
    expect(await readModelCache()).toBeNull();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => { throw new Error('Denied'); } } });
    await expect(saveModelCache(model())).resolves.toBeUndefined();
    expect(await readModelCache()).toBeNull();
  });

  it('stores material edits with uploaded texture files beside the model', async () => {
    const fs = filesystem();
    await saveModelCache(model());
    const normal = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const base = new Blob(['jpeg'], { type: 'image/jpeg' });
    const heightValues = { displacementScale: .02, displacementStepSize: .005,
      displacementUvProjection: 'triplanar' as const, displacementUvProjectionScale: 2 };
    await saveMaterialEdits({ modelId: 'first', materials: [
      { index: 0, name: 'Paint', values: { baseColor: [0.1, 0.2, 0.3], specularRoughness: 0.4 }, textures: [{ slot: 'normalMap', file: normal }, { slot: 'map', file: null }] },
      { index: 3, name: 'Glass', values: {}, textures: [{ slot: 'map', file: base }], sampling:{map:{uvScale:[-2,0],wrapS:'clamp-to-edge',wrapT:'mirrored-repeat'}} },
      { index: 4, name: 'Height', values: heightValues, textures: [{ slot: 'displacementMap', file: base }] }
    ] });
    expect(fs.files.size).toBe(2);
    const edits = (await readMaterialEdits())!;
    expect(edits.modelId).toBe('first');
    expect(edits.materials[0].values).toEqual({ baseColor: [0.1, 0.2, 0.3], specularRoughness: 0.4 });
    expect(edits.materials[0].textures[1]).toEqual({ slot: 'map', file: null });
    expect([...new Uint8Array(await edits.materials[0].textures[0].file!.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(edits.materials[0].textures[0].file!.type).toBe('image/png');
    expect(await edits.materials[1].textures[0].file!.text()).toBe('jpeg');
    expect(edits.materials[1].sampling?.map).toEqual({uvScale:[-2,0],wrapS:'clamp-to-edge',wrapT:'mirrored-repeat'});
    expect(edits.materials[2].values).toEqual(heightValues);
    expect(edits.materials[2].textures[0].slot).toBe('displacementMap');
    expect(await edits.materials[2].textures[0].file!.text()).toBe('jpeg');
    // The model archive is untouched; clearing edits keeps the model.
    await clearMaterialEdits();
    expect(await readMaterialEdits()).toBeNull();
    expect((await readModelCache())?.id).toBe('first');
    await saveMaterialEdits({ modelId: 'first', materials: [] });
    expect(fs.files.size).toBe(1);
  });
  it('roundtrips graph parameters and image files together with fallback maps',async()=>{
    filesystem();vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1,height:1})));
    const file=new Blob(['graph pixels'],{type:'image/png'}),texture=new Texture({width:1,height:1,data:new Uint8Array([1,2,3,255])});
    texture.wrapS='clamp-to-edge';texture.uvOffset=[0.1,0.2];rememberGraphImage(texture,file);
    const graph=new MaterialGraph({nodes:[{id:'image',category:'image',type:'color3',inputs:{file:{type:'filename',value:texture}}}],terminal:{baseColor:{node:'image'}}});
    await saveMaterialEdits({modelId:'m',materials:[{index:0,name:'Graph',values:{baseWeight:0.7},graph:archiveGraph(graph),textures:[{slot:'map',file:new Blob(['fallback'])}]}]});
    const edits=(await readMaterialEdits())!,archive=edits.materials[0].graph!;
    expect(archive.nodes[0].inputs!.file.value).toBeUndefined();expect(await archive.images[0].file.text()).toBe('graph pixels');expect(await edits.materials[0].textures[0].file!.text()).toBe('fallback');
    const restored=await restoreGraph(archive),image=restored!.nodes[0].inputs!.file.value as Texture;
    expect(image.wrapS).toBe('clamp-to-edge');expect(image.uvOffset).toEqual([0.1,0.2]);expect(restored!.terminal).toEqual(graph.terminal);expect(edits.materials[0].values.baseWeight).toBe(0.7);
  });

  it('persists optional heights with original bytes and transforms beside applied textures', async () => {
    filesystem();
    const transform = {uvScale:[2,3] as [number,number],uvOffset:[.1,.2] as [number,number],uvChannel:1 as const,flipY:true,colorSpace:'linear' as const};
    await saveMaterialEdits({modelId:'m',materials:[{index:0,name:'Rock',values:{displacementScale:0},
      textures:[{slot:'map',file:new Blob(['base'])}], materialXHeights:[
        {name:'Rock_height.png',file:new Blob(['height'],{type:'image/png'}),transform},
        {name:'Rock_disp.jpg',file:new Blob(['displacement'],{type:'image/jpeg'}),transform}
      ]}]});
    const edit=(await readMaterialEdits())!.materials[0];
    expect(await edit.textures[0].file!.text()).toBe('base');
    expect(edit.materialXHeights?.map(height=>height.name)).toEqual(['Rock_height.png','Rock_disp.jpg']);
    expect(edit.materialXHeights?.[0].transform).toEqual(transform);
    expect(edit.materialXHeights?.[0].file.type).toBe('image/png');
    expect(await edit.materialXHeights?.[0].file.text()).toBe('height');
    expect(await edit.materialXHeights?.[1].file.text()).toBe('displacement');
  });

});
