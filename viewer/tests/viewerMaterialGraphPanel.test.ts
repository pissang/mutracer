/// <reference lib="dom" />
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialGraph, OpenPBRMaterial, Texture, type MaterialGraphNode } from '@meimu/mutracer';

vi.hoisted(() => { vi.stubGlobal('location', { hash: '', href: 'https://viewer.example.com/' }); });
vi.mock('../src/engine/modelCache', () => ({ readMaterialEdits: vi.fn(), saveMaterialEdits: vi.fn() }));
import { disconnectGraphInput, summarizeMaterialGraph } from '../src/engine/materialGraphSummary';
import { archiveGraph, graphImageName, rememberGraphImage, restoreGraph } from '../src/engine/materialxGraphArchive';
import { MaterialEditor, readPendingEdits } from '../src/engine/materialEditor';
import { readMaterialEdits, saveMaterialEdits, type MaterialXHeight } from '../src/engine/modelCache';
import { discardHistory, redo, undo } from '../src/history';

class Bitmap { close() {} }
const texture = () => new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
const image = (id: string, value?: Texture): MaterialGraphNode =>
  ({ id, category: 'image', type: 'color3', inputs: { file: { type: 'filename', ...(value ? { value } : {}) } } });

function skinGraph() {
  const color = texture(), rough = texture();
  rememberGraphImage(color, new File(['c'], 'Skin_Color.png', { type: 'image/png' }));
  rememberGraphImage(rough, new File(['r'], 'Skin_Roughness.png', { type: 'image/png' }));
  const graph = new MaterialGraph({
    nodes: [
      image('color', color),
      { ...image('rough', rough), type: 'float' },
      { id: 'tint', category: 'multiply', type: 'color3', inputs: { in1: { type: 'color3', connection: { node: 'color' } }, in2: { type: 'color3', value: [1, .8, .7] } } },
      { id: 'pass', category: 'dot', type: 'float', inputs: { in: { type: 'float', connection: { node: 'rough' } } } },
      { id: 'ior', category: 'constant', type: 'float', inputs: { value: { type: 'float', value: 1.4 } } }
    ],
    terminal: { baseColor: { node: 'tint' }, specularRoughness: { node: 'rough' }, coatRoughness: { node: 'pass' }, specularIor: { node: 'ior' }, geometryOpacity: { node: 'gone' } }
  });
  return { graph, color, rough };
}

describe('material graph summary', () => {
  it('names the direct node and upstream images of each input', () => {
    const { graph } = skinGraph();
    const { inputs } = summarizeMaterialGraph(graph, graphImageName);
    const byKey = Object.fromEntries(inputs.map(input => [input.key, input]));
    expect(byKey.baseColor.source).toBe('multiply ← Skin_Color.png');
    expect(byKey.baseColor.nodes.sort()).toEqual(['color', 'tint']);
    expect(byKey.specularRoughness.source).toBe('Skin_Roughness.png');
    expect(byKey.coatRoughness.source).toBe('Skin_Roughness.png');
    expect(byKey.specularIor.source).toBe('constant');
    expect(byKey.opacity).toMatchObject({ terminal: 'geometryOpacity', source: 'missing gone' });
  });

  it('lists images with the inputs they feed and falls back to the node id', () => {
    const { graph, rough } = skinGraph();
    graph.setNode(image('unnamed'));
    const { images } = summarizeMaterialGraph(graph, graphImageName);
    expect(images.find(i => i.node === 'rough')).toMatchObject({ port: 'file', texture: rough, name: 'Skin_Roughness.png', feeds: ['specularRoughness', 'coatRoughness'] });
    expect(images.find(i => i.node === 'color')?.feeds).toEqual(['baseColor']);
    expect(images.find(i => i.node === 'unnamed')).toMatchObject({ name: 'unnamed', texture: undefined, feeds: [] });
  });

  it('disconnects into a new pruned graph, and to null when nothing remains', () => {
    const { graph } = skinGraph();
    const next = disconnectGraphInput(graph, 'baseColor')!;
    expect(next).not.toBe(graph);
    expect(Object.keys(graph.terminal)).toContain('baseColor');
    expect(Object.keys(next.terminal)).not.toContain('baseColor');
    expect(next.nodes.map(n => n.id).sort()).toEqual(['ior', 'pass', 'rough']);
    const single = new MaterialGraph({ nodes: [image('a')], terminal: { baseColor: { node: 'a' } } });
    expect(disconnectGraphInput(single, 'baseColor')).toBeNull();
  });
});

describe('material graph edits', () => {
  let editor: MaterialEditor;
  beforeEach(() => {
    vi.stubGlobal('ImageBitmap', Bitmap);
    vi.stubGlobal('HTMLImageElement', class {});
    vi.stubGlobal('HTMLCanvasElement', class {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new Bitmap()));
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,thumb' }) });
  });
  afterEach(() => { editor?.setModel(null, null); discardHistory('material'); vi.unstubAllGlobals(); });

  function setup() {
    const source = new THREE.MeshStandardMaterial(), mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
    const material = new OpenPBRMaterial();
    editor = new MaterialEditor(() => {});
    editor.setModel(mesh, null);
    editor.onConverted(source, material, mesh.uuid);
    return { id: source.uuid, material, source, mesh };
  }

  it('describes the graph and disconnects inputs as undoable steps', () => {
    const { id, material } = setup();
    const { graph } = skinGraph();
    editor.setGraph(id, graph, 'Import');
    expect(editor.describe(id)?.graph?.images.find(i => i.node === 'color')).toMatchObject({ name: 'Skin_Color.png', feeds: ['baseColor'] });
    for (const terminal of Object.keys(graph.terminal)) editor.setGraph(id, disconnectGraphInput(material.graph!, terminal), `Disconnect ${terminal}`);
    expect(material.graph).toBeUndefined();
    expect(editor.describe(id)?.graph).toBeNull();
    undo();
    expect(Object.keys(material.graph!.terminal)).toEqual(['geometryOpacity']);
    redo();
    expect(material.graph).toBeUndefined();
  });

  it('reports whether WebGL 2 renders the graph through texture slots', () => {
    const { id } = setup();
    editor.setGraph(id, new MaterialGraph({ nodes: [image('color', texture())], terminal: { baseColor: { node: 'color' } } }), 'Direct');
    expect(editor.describe(id)?.graph?.webgl).toBe(true);
    editor.setGraph(id, new MaterialGraph({ nodes: [{ id: 'n', category: 'noise3d', type: 'color3' }], terminal: { baseColor: { node: 'n' } } }), 'Noise');
    expect(editor.describe(id)?.graph?.webgl).toBe(false);
  });

  it('replaces a graph image keeping its texture settings and persists it', async () => {
    const { id, material } = setup();
    const { graph, color } = skinGraph();
    color.colorSpace = 'srgb'; color.flipY = true; color.uvScale = [2, 3]; color.uvOffset = [.1, .2]; color.uvChannel = 1;
    color.wrapS = 'mirrored-repeat'; color.wrapT = 'clamp-to-edge';
    editor.setGraph(id, graph, 'Import');
    const file = new File(['new'], 'Skin_New.png', { type: 'image/png' });
    expect(await editor.setGraphImage(id, 'color', 'file', file, 'Replace')).toBe(true);
    const next = material.graph!;
    expect(next).not.toBe(graph);
    expect(next.terminal).toEqual(graph.terminal);
    const replaced = next.nodes.find(n => n.id === 'color')!.inputs!.file.value as Texture;
    expect(replaced).not.toBe(color);
    expect(replaced).toMatchObject({ colorSpace: 'srgb', flipY: true, uvScale: [2, 3], uvOffset: [.1, .2], uvChannel: 1, wrapS: 'mirrored-repeat', wrapT: 'clamp-to-edge' });
    expect(graph.nodes.find(n => n.id === 'color')!.inputs!.file.value).toBe(color);
    expect(editor.describe(id)?.graph?.images.find(i => i.node === 'color')).toMatchObject({ name: 'Skin_New.png', thumb: expect.stringContaining('data:image/png') });

    const archive = archiveGraph(next)!;
    expect(archive.images.find(i => i.node === 'color')).toMatchObject({ file, options: { uvScale: [2, 3], wrapS: 'mirrored-repeat' } });
    const restored = (await restoreGraph(archive))!;
    const value = restored.nodes.find(n => n.id === 'color')!.inputs!.file.value as Texture;
    expect(value).toMatchObject({ colorSpace: 'srgb', uvOffset: [.1, .2], uvChannel: 1, wrapT: 'clamp-to-edge' });
    expect(graphImageName(value)).toBe('Skin_New.png');

    undo();
    expect(material.graph).toBe(graph);
  });

  it('keeps package heights disabled until applied and undoes choices and strength with the material', async () => {
    const { id, material, source, mesh } = setup();
    const heights: MaterialXHeight[] = [{name:'Rock_height.png',file:new Blob(['height']),
      transform:{uvScale:[2,3],uvOffset:[.1,.2],uvChannel:1,flipY:true,colorSpace:'linear'}}];
    await editor.setTextures(id, {}, {displacementScale:0,displacementBias:0}, 'Import',
      undefined,undefined,null,undefined,undefined,heights);
    expect(material.displacementMap).toBeUndefined();
    expect(editor.describe(id)?.materialXHeights).toEqual(['Rock_height.png']);
    expect(await editor.setMaterialXHeight(id, 'Rock_height.png', .02)).toBe(true);
    expect(material.displacementMap).toMatchObject({uvScale:[2,3],uvOffset:[.1,.2],uvChannel:1,flipY:true,colorSpace:'linear'});
    expect(material.displacementScale).toBe(.02);
    editor.setValues(id, {displacementScale:.04}, 'Strength');
    const variant=new OpenPBRMaterial();
    editor.onConverted(source,variant,mesh.uuid);
    expect(variant.displacementMap).toBe(material.displacementMap);
    expect(variant.displacementScale).toBe(.04);
    undo();expect(material.displacementScale).toBe(.02);
    undo();expect(material.displacementMap).toBeUndefined();expect(material.displacementScale).toBe(0);
    undo();expect(editor.describe(id)?.materialXHeights).toEqual([]);
    redo();expect(editor.describe(id)?.materialXHeights).toEqual(['Rock_height.png']);
    redo();expect(material.displacementScale).toBe(.02);
    editor.reset(id);expect(editor.describe(id)?.materialXHeights).toEqual([]);expect(material.displacementMap).toBeUndefined();
    undo();expect(material.displacementScale).toBe(.02);expect(editor.describe(id)?.materialXHeights).toEqual(['Rock_height.png']);

    editor.modelId='model';editor.setValues(id,{displacementScale:.03},'Strength');editor.flush();
    const edit=vi.mocked(saveMaterialEdits).mock.lastCall![0].materials[0];
    expect(edit.materialXHeights).toBe(heights);
    expect(edit.textures.find(texture=>texture.slot==='displacementMap')?.file).toBe(heights[0].file);
    expect(edit.values.displacementScale).toBe(.03);
  });

  it('restores optional maps without decoding them before the user applies one', async () => {
    const heights: MaterialXHeight[]=[{name:'height.png',file:new Blob(['height']),transform:{uvScale:[1,1],flipY:true}}];
    vi.mocked(readMaterialEdits).mockResolvedValueOnce({modelId:'model',materials:[{index:0,name:'',values:{displacementScale:0},textures:[],materialXHeights:heights}]});
    const pending=await readPendingEdits('model');
    expect(createImageBitmap).not.toHaveBeenCalled();
    const { id,material,mesh,source }=setup();
    editor.setModel(mesh,pending);editor.onConverted(source,material,mesh.uuid);
    expect(editor.describe(id)?.materialXHeights).toEqual(['height.png']);
    expect(material.displacementMap).toBeUndefined();
    expect(await editor.setMaterialXHeight(id,'height.png',.01)).toBe(true);
    expect(material.displacementScale).toBe(.01);
  });

  it('discards a height decoded after the imported material is reset', async () => {
    const { id,material }=setup();
    const heights: MaterialXHeight[]=[{name:'height.png',file:new Blob(['height']),transform:{uvScale:[1,1],flipY:true}}];
    await editor.setTextures(id,{}, {displacementScale:0}, 'Import',undefined,undefined,null,undefined,undefined,heights);
    let complete!: (image: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const task=editor.setMaterialXHeight(id,'height.png',.02);
    editor.reset(id);
    const bitmap={close:vi.fn()} as unknown as ImageBitmap;complete(bitmap);
    expect(await task).toBe(false);expect(bitmap.close).toHaveBeenCalledOnce();
    expect(material.displacementMap).toBeUndefined();expect(editor.describe(id)?.materialXHeights).toEqual([]);
  });
});
