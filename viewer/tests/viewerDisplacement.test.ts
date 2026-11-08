/// <reference lib="dom" />
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPBRMaterial, Texture } from '@meimu/mutracer';

vi.hoisted(() => { vi.stubGlobal('location', { hash: '', href: 'https://viewer.example.com/' }); });
vi.mock('../src/engine/modelCache', () => ({ readMaterialEdits: vi.fn(), saveMaterialEdits: vi.fn() }));
import { MaterialEditor, readPendingEdits } from '../src/engine/materialEditor';
import { readMaterialEdits, saveMaterialEdits } from '../src/engine/modelCache';
import { discardHistory, redo, undo } from '../src/history';

class Bitmap {}
let editor: MaterialEditor;

function setup(hasUVs = true) {
  const source = new THREE.MeshStandardMaterial();
  source.name = 'Surface';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  const material = new OpenPBRMaterial();
  editor = new MaterialEditor(() => {});
  editor.setModel(mesh, null);
  editor.onConverted(source, material, mesh.uuid, hasUVs);
  return { source, mesh, material };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ImageBitmap', Bitmap);
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => new Bitmap()));
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,thumb' }) });
});
afterEach(() => {
  editor?.setModel(null, null);
  discardHistory('material');
  vi.unstubAllGlobals();
});

describe('viewer displacement edits', () => {
  it('keeps an imported height transform separate and persists it through reload and history',async()=>{
    const {source,mesh,material}=setup();editor.modelId='model';
    const file=new Blob(['baked PNG'],{type:'image/png'});
    await editor.setTextures(source.uuid,{map:new Blob(['base']),displacementMap:file},{displacementScale:.2,displacementBias:-.1},'MaterialX',undefined,undefined,null,{displacementMap:{uvScale:[2,3],uvOffset:[.1,-.2],flipY:true,uvChannel:1,wrapS:'mirrored-repeat',wrapT:'clamp-to-edge'}});
    expect(material.map!.uvScale).toEqual([1,1]);expect(material.displacementMap!.uvScale).toEqual([2,3]);expect(material.displacementMap!.uvOffset).toEqual([.1,-.2]);
    editor.flush();const saved=vi.mocked(saveMaterialEdits).mock.calls[0][0];
    vi.mocked(readMaterialEdits).mockResolvedValue(saved);editor.setModel(mesh,await readPendingEdits('model'));
    const restored=new OpenPBRMaterial();editor.onConverted(source,restored,mesh.uuid);
    expect(restored.displacementMap!.uvOffset).toEqual([.1,-.2]);expect(restored.displacementMap!.uvChannel).toBe(1);
    expect(restored.displacementMap!.wrapS).toBe('mirrored-repeat');expect(restored.displacementBias).toBe(-.1);
    editor.reset(source.uuid);expect(restored.displacementMap).toBeUndefined();undo();expect(restored.displacementMap).toBeDefined();redo();expect(restored.displacementMap).toBeUndefined();
  });
  it('uploads a linear height texture with the existing UV transform and supports undo, redo and reset', async () => {
    const { source, material } = setup();
    material.map = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
    material.map.uvScale = [2, 3]; material.map.uvOffset = [.1, .2]; material.map.uvChannel = 1;
    material.map.wrapS = 'clamp-to-edge'; material.map.wrapT = 'mirrored-repeat';
    const file = new Blob(['height'], { type: 'image/png' });
    await editor.setTextures(source.uuid, { displacementMap: file }, { displacementScale: .04, displacementBias: -.02, displacementStepSize: .005 }, 'Height');
    const height = material.displacementMap!;
    expect(height.uvScale).toEqual([2, 3]);
    expect(height.uvOffset).toEqual([.1, .2]);
    expect(height.uvChannel).toBe(1);
    expect(height.wrapS).toBe('clamp-to-edge'); expect(height.wrapT).toBe('mirrored-repeat');
    expect(createImageBitmap).toHaveBeenCalledWith(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    expect(editor.describe(source.uuid)?.maps.displacementMap).toContain('data:image/png');
    undo();
    expect(material.displacementMap).toBeUndefined();
    expect(material.displacementScale).toBe(.1);
    expect(material.displacementBias).toBe(0);
    redo();
    expect(material.displacementMap).toBe(height);
    expect(material.displacementBias).toBe(-.02);
    expect(material.displacementStepSize).toBe(.005);
    editor.reset(source.uuid);
    expect(material.displacementMap).toBeUndefined();
    expect(material.displacementScale).toBe(.1);
    expect(material.displacementBias).toBe(0);
  });

  it('selects triplanar coordinates for a UV-less mesh in the same undo step', async () => {
    const { source, material } = setup(false);
    await editor.setTexture(source.uuid, 'displacementMap', new Blob(['height']), 'Height');
    expect(material.displacementUvProjection).toBe('triplanar');
    undo();
    expect(material.displacementMap).toBeUndefined();
    expect(material.displacementUvProjection).toBe('none');
    redo();
    expect(material.displacementUvProjection).toBe('triplanar');
  });

  it('persists the height file and settings and restores them on reload', async () => {
    const { source, mesh, material } = setup();
    editor.modelId = 'model';
    const file = new Blob(['height'], { type: 'image/jpeg' });
    await editor.setTextures(source.uuid, { displacementMap: file }, {
      displacementScale: .025, displacementBias: -.0125, displacementStepSize: .003, displacementUvProjection: 'spherical', displacementUvProjectionScale: 2
    }, 'Height');
    editor.flush();
    const saved = vi.mocked(saveMaterialEdits).mock.calls[0][0];
    expect(saved.materials[0].textures).toEqual([{ slot: 'displacementMap', file }]);
    vi.mocked(readMaterialEdits).mockResolvedValue(saved);
    const pending = await readPendingEdits('model');
    editor.setModel(mesh, pending);
    const restored = new OpenPBRMaterial();
    editor.onConverted(source, restored, mesh.uuid);
    expect(restored.displacementMap).toBeDefined();
    expect(restored.displacementMap).not.toBe(material.displacementMap);
    expect(restored.displacementScale).toBe(.025);
    expect(restored.displacementBias).toBe(-.0125);
    expect(restored.displacementStepSize).toBe(.003);
    expect(restored.displacementUvProjection).toBe('spherical');
    expect(restored.displacementUvProjectionScale).toBe(2);
    await editor.setTexture(source.uuid, 'displacementMap', null, 'Remove height');
    expect(restored.displacementMap).toBeUndefined();
    undo();
    expect(restored.displacementMap).toBeDefined();
  });
});

describe('texture sampling edits', () => {
  function loaded() {
    const fixture=setup(), original=new Texture({width:1,height:1,data:new Uint8Array([128,64,32,255])});
    original.uvOffset=[.2,.3]; original.uvChannel=1; original.colorSpace='linear';
    fixture.material.map=original;
    editor.setModel(fixture.mesh,null); editor.onConverted(fixture.source,fixture.material,fixture.mesh.uuid);
    return {...fixture,original};
  }

  it('isolates shared textures and supports undo, redo and reset for wrap and repeat', () => {
    const {source,material,original}=loaded();
    editor.setTextureSampling(source.uuid,'map',{wrapS:'clamp-to-edge',wrapT:'mirrored-repeat',uvScale:[2,3]},'Sampling');
    const edited=material.map!;
    expect(edited).not.toBe(original); expect(edited.image).toBe(original.image);
    expect(edited.uvOffset).toEqual([.2,.3]); expect(edited.uvChannel).toBe(1); expect(edited.colorSpace).toBe('linear');
    expect(original.wrapS).toBe('repeat'); expect(original.uvScale).toEqual([1,1]);
    expect(editor.describe(source.uuid)?.sampling.map).toEqual({wrapS:'clamp-to-edge',wrapT:'mirrored-repeat',uvScale:[2,3]});
    undo(); expect(material.map).toBe(original); redo(); expect(material.map).toBe(edited);
    editor.reset(source.uuid); expect(material.map).toBe(original);
  });

  it('persists sampling-only edits of model textures without storing image files', async () => {
    const {source,mesh,material}=loaded(); editor.modelId='model';
    editor.setTextureSampling(source.uuid,'map',{wrapT:'clamp-to-edge',uvScale:[-2,0]},'Repeat'); editor.flush();
    const saved=vi.mocked(saveMaterialEdits).mock.calls.at(-1)![0];
    expect(saved.materials[0].textures).toEqual([]);
    expect(saved.materials[0].sampling?.map).toEqual({wrapS:'repeat',wrapT:'clamp-to-edge',uvScale:[-2,0]});
    vi.mocked(readMaterialEdits).mockResolvedValue(saved);
    const pending=await readPendingEdits('model'), map=new Texture(material.map!.image), restored=new OpenPBRMaterial({map});
    editor.setModel(mesh,pending); editor.onConverted(source,restored,mesh.uuid);
    expect(restored.map!.uvScale).toEqual([-2,0]); expect(restored.map!.wrapT).toBe('clamp-to-edge');
    expect(map.wrapT).toBe('repeat');
  });

  it('keeps uploaded texture files when sampling is edited and skips no-op edits',async () => {
    const {source,material}=loaded(); editor.modelId='model'; const file=new Blob(['image'],{type:'image/png'});
    await editor.setTexture(source.uuid,'map',file,'Upload'); const uploaded=material.map;
    editor.setTextureSampling(source.uuid,'map',{uvScale:[1,1]},'Repeat'); expect(material.map).toBe(uploaded);
    editor.setTextureSampling(source.uuid,'map',{wrapS:'mirrored-repeat'},'Wrap'); editor.flush();
    const saved=vi.mocked(saveMaterialEdits).mock.calls.at(-1)![0];
    expect(saved.materials[0].textures[0].file).toBe(file); expect(saved.materials[0].sampling?.map?.wrapS).toBe('mirrored-repeat');
  });
});
