import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import Mesh from '../../src/scene/Mesh.js';
import {createSphereGeometry} from '../../src/util/commonGeometry.js';
import {causticCasterSpheres, graphAffectsCausticCaster, hasStochasticCausticCaster, isCausticCaster, isCausticSpecular, packCausticGraphFlags, type CausticCasterTest} from '../../src/renderer/caustics.js';
import Texture from '../../src/scene/Texture.js';
import {MATERIAL_FLOAT_COUNT, materialBufferWgsl, materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';
import {MaterialGraphState, setMaterialGraphPlanner} from '../../src/renderer/materialGraph/state.js';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader.js';
import {terminalTypes} from '../../src/renderer/materialGraph/nodes.js';
import {causticLightCompute} from '../../src/renderer/wgsl/causticLight.compute.js';
import {wgpuShaderSource} from '../../src/renderer/wgpuShaderSource.js';
import WGPURayTracePass, {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass.js';

const address = materialLayoutFields().find(f => f.name === '_padding2')!.offset / 4;
function graph(port = 'baseColor') {
  const type = terminalTypes[port] ?? 'float';
  return new MaterialGraph({nodes: [{id: 'value', category: 'noise2d', type: type === 'vector3' ? 'color3' : type},
    ...(type === 'vector3' ? [{id: 'normal', category: 'convert', type, inputs: {in: {connection: {node: 'value'}}}}] : [])],
    terminal: {[port]: {node: type === 'vector3' ? 'normal' : 'value'}}});
}
function install(materials: OpenPBRMaterial[], tier: 'specialized' | 'interpreter') {
  setMaterialGraphPlanner({tier, interim: false});
  const state = new MaterialGraphState(); state.interpreterAvailable = true;
  state.request(materials); state.install(state.requested, state.revision);
  expect(state.diagnostics).toEqual([]);
  return state;
}
beforeEach(() => {vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});});
afterEach(() => {setMaterialGraphPlanner(); vi.unstubAllGlobals();});

describe('graph caustic ownership', () => {
  it.each([...Object.keys(terminalTypes), 'geometryNormal', 'geometryOpacity', 'specularRoughnessAnisotropy', 'coatRoughnessAnisotropy', 'unknownInput'])('classifies authored %s conservatively', port => {
    const material = new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0, graph: graph(port)});
    const unrelated = ['baseDiffuseRoughness', 'emissionColor', 'emissionLuminance'].includes(port);
    expect(graphAffectsCausticCaster(material)).toBe(!unrelated);
    expect(isCausticCaster(material)).toBe(unrelated);
    expect(isCausticSpecular(material)).toBe(true);
    const mesh = new Mesh(createSphereGeometry(8, 4), material);
    expect(causticCasterSpheres([mesh])).toHaveLength(unrelated ? 1 : 0);
    material.alphaMode = 'blend'; material.geometryOpacity = .5;
    expect(hasStochasticCausticCaster([mesh])).toBe(unrelated);
    material.graph = undefined;
    expect(isCausticCaster(material)).toBe(true);
  });

  function slotGraph() {
    const texture = new Texture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255])});
    texture.colorSpace = 'linear';
    return new MaterialGraph({nodes: [
      {id: 'image', category: 'image', type: 'vector3', inputs: {file: {type: 'filename', value: texture}}},
      {id: 'channel', category: 'extract', type: 'float', inputs: {in: {type: 'vector3', connection: {node: 'image'}}, index: {type: 'integer', value: 1}}},
      {id: 'gain', category: 'multiply', type: 'float', inputs: {in1: {type: 'float', connection: {node: 'channel'}}, in2: {type: 'float', value: .05}}}
    ], terminal: {specularRoughness: {node: 'gain'}}});
  }
  // Mirrors the WebGPU pass: exclusion follows the graph code the plan evaluates and
  // smoothness follows the rendered (slot-applied) constants.
  const casterTest = (state: MaterialGraphState): CausticCasterTest => material => {
    const m = material as OpenPBRMaterial;
    return !graphAffectsCausticCaster(m, x => state.evaluatedTerminals(x)) && isCausticSpecular(state.renderMaterials([m])[0]);
  };

  it('keeps texture-slot graphs as casters and excludes them once they need evaluation', () => {
    const material = new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0, graph: slotGraph()});
    const state = new MaterialGraphState(); state.interpreterAvailable = true;
    state.request([material]);
    expect(state.requested.structures).toHaveLength(0);
    expect(state.evaluatedTerminals(material)).toBeUndefined();
    const mesh = new Mesh(createSphereGeometry(8, 4), material);
    expect(causticCasterSpheres([mesh], casterTest(state))).toHaveLength(1);
    expect(isCausticCaster(material)).toBe(false); // Authored default stays conservative.
    const packed = packCausticGraphFlags(new Float32Array(MATERIAL_FLOAT_COUNT), [material], x => state.evaluatedTerminals(x));
    expect((Math.trunc(packed[address] * 2) & 1) !== 0).toBe(false);

    material.graph!.setNode({id: 'gain', category: 'add', type: 'float', inputs: {in1: {type: 'float', connection: {node: 'channel'}}, in2: {type: 'float', value: .01}}});
    state.request([material]);
    expect(state.evaluatedTerminals(material)).toEqual(['specularRoughness']); // Requested before install.
    expect(causticCasterSpheres([mesh], casterTest(state))).toHaveLength(0);
    packCausticGraphFlags(packed, [material], x => state.evaluatedTerminals(x));
    expect((Math.trunc(packed[address] * 2) & 1) !== 0).toBe(true);
  });

  it('classifies slot plans by their rendered constants', () => {
    const graph = slotGraph();
    graph.setInput('gain', 'in2', {type: 'float', value: .5});
    const material = new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0, graph});
    const state = new MaterialGraphState(); state.request([material]);
    expect(state.renderMaterials([material])[0].specularRoughness).toBe(.5);
    expect(casterTest(state)(material)).toBe(false);
  });

  it('keeps an installed graph excluded until its slot replacement installs', () => {
    const material = new OpenPBRMaterial({transmissionWeight: 1, specularRoughness: 0, graph: graph('specularRoughness')});
    const state = install([material], 'specialized');
    expect(state.evaluatedTerminals(material)).toEqual(['specularRoughness']);
    material.graph = slotGraph(); state.request([material]);
    expect(state.requested.key).toBe('');
    expect(state.evaluatedTerminals(material)).toEqual(['specularRoughness']); // Active plan still evaluates it.
    state.install(state.requested, state.revision);
    expect(state.evaluatedTerminals(material)).toBeUndefined();
  });

  it.each(['specialized', 'interpreter'] as const)('packs the exclusion bit without changing %s parameter/program addresses or record layout', tier => {
    const materials = [new OpenPBRMaterial({graph: graph()}), new OpenPBRMaterial({graph: graph('emissionColor')}), new OpenPBRMaterial()];
    const state = install(materials, tier);
    const packed = state.pack(new Float32Array(materials.length * MATERIAL_FLOAT_COUNT), []);
    const original = packed.slice();
    packCausticGraphFlags(packed, materials);
    const definitions = makeShaderDataDefinitions(materialBufferWgsl()).structs.MaterialBuffer;
    expect(definitions.size).toBe(416);
    expect(definitions.fields._padding2.offset).toBe(address * 4);
    for (let i = 0; i < materials.length; i++) {
      const at = i * MATERIAL_FLOAT_COUNT + address;
      expect(Math.trunc(packed[at])).toBe(original[at]);
      expect((Math.trunc(packed[at] * 2) & 1) !== 0).toBe(i === 0);
      original[at] = packed[at];
    }
    expect(packed).toEqual(original); // Includes every parameter and interpreter instruction.
    expect(packCausticGraphFlags(packed, materials)).toEqual(original);
  });

  it.each(['specialized', 'interpreter'] as const)('generates camera and both emitter storage contracts with %s graphs', tier => {
    vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
    const state = install([new OpenPBRMaterial({graph: graph()}), new OpenPBRMaterial({graph: graph('coatWeight')}), new OpenPBRMaterial({graph: graph('emissionColor')})], tier);
    const materialHooks = {...materialGraphShader(state.active, true, false), causticGraphFlags: true};
    const constants = {NUM_MAPS: 1, NUM_UNIFORM_LIGHTS: 1, TLAS_STACK_SIZE: 8, BLAS_STACK_SIZE: 32, USE_ANISOTROPY_DIRECTIONS: true};
    const camera = makeShaderDataDefinitions(wgpuShaderSource(constants, {materialHooks, lightTracing: true, photonMapping: true, hasAnisotropyDirections: true, hasDisplacement: false, hasAlpha: false, hasSceneAlpha: true, hasCoatNormals: false, blasLayoutMask: 1}, true));
    for (const mode of ['lightTracing', 'photonMapping'] as const) {
      const emitter = makeShaderDataDefinitions(causticLightCompute(constants, 1, false, mode, '', true, false, false, false, false, materialHooks));
      expect(emitter.entryPoints.main.stage).toBe(4);
      expect(emitter.storages.materialsBuffer.group).toBe(camera.storages.materialsBuffer.group);
      expect(emitter.storages.materialsBuffer.binding).toBe(camera.storages.materialsBuffer.binding);
      expect(emitter.structs.MaterialBuffer).toEqual(camera.structs.MaterialBuffer);
      expect(Object.keys(emitter.structs.MXResult.fields)).toEqual(Object.keys(camera.structs.MXResult.fields));
    }
  });

  it('reports only unsupported lit emission, locating each material and port', () => {
    const surface = new OpenPBRMaterial({graph: graph()}), lit = new OpenPBRMaterial({graph: graph('emissionColor')}), unlit = new OpenPBRMaterial({unlit: true, graph: graph('emissionColor')});
    const state = install([surface, lit, unlit], 'interpreter');
    const pass = Object.assign(Object.create(WGPURayTracePass.prototype), {_graphs: state, _lightTracing: true,
      _textureSelection: {}, _emissiveTriangles: [], _rtUniform: makeRayTraceUniform(), _constants: {}}) as WGPURayTracePass;
    const diagnostics = pass.getDiagnostics().materialGraphs;
    expect(diagnostics.status).toBe('failed');
    expect(diagnostics.diagnostics).toEqual([{code: 'unsupported-transport', materialId: lit.aovId, port: 'emissionColor', message: expect.stringContaining('not evaluated at light emission points')}]);
    expect(pass.getDiagnostics().materialGraphs.diagnostics).toEqual(diagnostics.diagnostics);
    expect(state.diagnostics).toEqual([]);
    state.status = 'compiling';
    expect(pass.getDiagnostics().materialGraphs.status).toBe('compiling');
    expect(pass.getDiagnostics().materialGraphs.diagnostics).toEqual(diagnostics.diagnostics);
  });
});
