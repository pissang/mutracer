import {describe, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine.js';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import Mesh from '../../src/scene/Mesh.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import {renderFixture} from '../helpers/renderPipeline.js';

function fixture() {
    const result = renderFixture(), graphs = new MaterialGraphState();
    vi.mocked(result.pipeline.getDiagnostics).mockImplementation(() => ({materialGraphs: graphs.diagnosticsState}));
    vi.mocked(result.pipeline.setMeshes).mockImplementation(meshes => {graphs.request(meshes.flatMap(mesh => mesh.materials)); return true;});
    const graph = new MaterialGraph({nodes: [{id: 'c', category: 'constant', type: 'color3', inputs: {value: {type: 'color3', value: [.2,.2,.2]}}}], terminal: {emissionColor: {node: 'c'}}});
    const material = new OpenPBRMaterial({graph, unlit: true, emissionLuminance: 1});
    result.scene.meshes.push(new Mesh(createPlaneGeometry(), material));
    result.engine.update();
    return {...result, graph, material, graphs};
}

describe('Engine.waitForMaterialGraphs', () => {
    it('settles immediately without graphs and does not initialize or create a render', async () => {
        const engine = new Engine({canvas: {} as HTMLCanvasElement});
        const init = vi.spyOn(engine, 'init');
        expect(await engine.waitForMaterialGraphs()).toEqual({outcome: 'settled', state: {revision: 0, installedRevision: 0, status: 'idle', topologyCount: 0, diagnostics: []}});
        expect(init).not.toHaveBeenCalled();
        engine.dispose();
    });
    it('waits for installation without driving rendering and returns a detached snapshot', async () => {
        const {engine, graphs, targets} = fixture();
        let complete = false;
        const waiting = engine.waitForMaterialGraphs().then(result => {complete = true; return result;});
        await Promise.resolve();
        expect(complete).toBe(false);
        expect(targets).toHaveLength(0);
        graphs.install(graphs.requested, graphs.revision);
        engine._reportShaderProgress();
        const result = await waiting;
        expect(result.outcome).toBe('settled');
        expect(result.state.status).toBe('ready');
        expect(result.state.installedRevision).toBe(graphs.revision);
        graphs.fail(graphs.revision, 'later failure');
        expect(result.state.status).toBe('ready');
        expect(result.state.diagnostics).toEqual([]);
        engine.dispose();
    });
    it('supersedes an old scene request, but ignores camera-only and uncommitted edits', async () => {
        const {engine, graphs, graph, camera} = fixture();
        const first = engine.waitForMaterialGraphs();
        graph.setNode({id: 'c', category: 'add', type: 'color3'});
        camera.position = [1, 2, 3];
        // Do not commit the authored graph edit yet.
        engine._reportShaderProgress();
        engine.update();
        expect((await first).outcome).toBe('superseded');
        const second = engine.waitForMaterialGraphs();
        camera.position = [3, 2, 1]; engine.update();
        graphs.install(graphs.requested, graphs.revision); engine._reportShaderProgress();
        expect((await second).outcome).toBe('settled');
        engine.dispose();
    });
    it('cancels one waiter, including a pre-aborted signal, without cancelling compilation', async () => {
        const {engine, graphs} = fixture(), controller = new AbortController();
        const cancelled = engine.waitForMaterialGraphs({signal: controller.signal});
        const remaining = engine.waitForMaterialGraphs();
        controller.abort();
        expect((await cancelled).outcome).toBe('aborted');
        expect((await engine.waitForMaterialGraphs({signal: controller.signal})).outcome).toBe('aborted');
        expect(graphs.status).toBe('compiling');
        graphs.install(graphs.requested, graphs.revision); engine._reportShaderProgress();
        expect((await remaining).state.status).toBe('ready');
        engine.dispose();
    });
    it('resolves validation and driver failures through diagnostics and allows recovery', async () => {
        const {engine, graphs, graph} = fixture();
        const waiting = engine.waitForMaterialGraphs();
        graphs.fail(graphs.revision, new Error('driver failure')); engine._reportShaderProgress();
        expect(await waiting).toMatchObject({outcome: 'settled', state: {status: 'failed', diagnostics: [{code: 'shader-compilation', message: 'driver failure'}]}});
        graph.setNode({id: 'c', category: 'unknown', type: 'color3'}); engine.update();
        expect(await engine.waitForMaterialGraphs()).toMatchObject({outcome: 'settled', state: {status: 'failed', diagnostics: [expect.objectContaining({code: 'unsupported-node'})]}});
        graph.setNode({id: 'c', category: 'constant', type: 'color3'}); engine.update();
        const recovery = engine.waitForMaterialGraphs();
        graphs.install(graphs.requested, graphs.revision); engine._reportShaderProgress();
        expect((await recovery).state.status).toBe('ready');
        engine.dispose();
    });
    it('waits across deferred scene uploads rather than returning the previous idle state', async () => {
        const {engine, pipeline, graphs} = fixture();
        // Model CPU preparation holding the new graph request before its upload.
        const internals = engine as unknown as {_uploadedRevision: number};
        internals._uploadedRevision = -1;
        vi.mocked(pipeline.getDiagnostics).mockReturnValue({materialGraphs: {revision: 0, installedRevision: 0, status: 'idle', diagnostics: [], topologyCount: 0}});
        let complete = false;
        const waiting = engine.waitForMaterialGraphs().then(result => {complete = true; return result;});
        await Promise.resolve(); expect(complete).toBe(false);
        graphs.install(graphs.requested, graphs.revision);
        vi.mocked(pipeline.getDiagnostics).mockImplementation(() => ({materialGraphs: graphs.diagnosticsState}));
        engine.update();
        expect((await waiting).state.status).toBe('ready');
        engine.dispose();
    });
    it('settles device loss independently of driver completion', async () => {
        const {engine} = fixture();
        const waiting = engine.waitForMaterialGraphs();
        (engine as unknown as {_invalidateDevice(error: Error, recovering: boolean): void})._invalidateDevice(new Error('device lost'), false);
        expect(await waiting).toMatchObject({outcome: 'unavailable', state: {status: 'failed', diagnostics: [{code: 'engine-unavailable', message: 'device lost'}]}});
        engine.dispose();
    });
    it('settles disposal and initialization failures without rejection', async () => {
        const {engine} = fixture();
        const waiting = engine.waitForMaterialGraphs(); engine.dispose();
        expect(await waiting).toMatchObject({outcome: 'unavailable', state: {status: 'failed', diagnostics: [{code: 'engine-unavailable', message: 'Engine is disposed.'}]}});
        const other = new Engine({canvas: {} as HTMLCanvasElement});
        vi.spyOn(other, 'init').mockRejectedValue(new Error('no device'));
        other.scene = {meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial({graph: new MaterialGraph()}))], lights: []};
        other.update();
        expect(await other.waitForMaterialGraphs()).toMatchObject({outcome: 'unavailable', state: {diagnostics: [{code: 'engine-unavailable', message: 'no device'}]}});
        other.dispose();
    });
});
