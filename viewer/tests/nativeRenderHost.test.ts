import { Matrix4, Vector3, Quaternion, Scene as ThreeScene } from 'three';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Camera, Mesh, Geometry, OpenPBRMaterial, fromTHREEScene } from '../../src/main';
import { Attribute } from '../../src/scene/Geometry';
import {hostMaterials,hostThreeGeometries} from '../src/engine/nativeResources';
import {HEADER as H} from '../../native/src/layout';
import { cameraWords,NativeSceneEncoder } from '../src/engine/nativeScene';
import { NativeRenderHost, NativeRender } from '../src/engine/NativeRenderHost';
import { changeNativeDevice } from '../src/engine/nativeCapabilities';
vi.mock('../src/store', () => ({ useViewer: { subscribe: () => () => { }, setState: () => { }, getState: () => ({ nativeRayReconstruction: false }) } }));
const hosts: NativeRenderHost[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.dispose()); vi.unstubAllGlobals(); });
function setup(responses:Record<string,unknown>={}) {
    const commands: {
        command: string;
        args: Record<string, unknown>;
    }[] = [];
    let failCommit = false;
    vi.stubGlobal('ResizeObserver', class {
        observe() { }
        disconnect() { }
    });
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('document', { baseURI: 'http://mutracer.localhost/index.html', documentElement: { dataset: {} } });
    const gpu = vi.fn(() => { throw Error('Browser GPU must not be initialized'); });
    vi.stubGlobal('navigator', { gpu: { requestAdapter: gpu } });
    const window = { ipc: { postMessage: (message: string) => { if (message.startsWith('~'))
                return; const request = JSON.parse(message); commands.push(request); queueMicrotask(() => window.mutracerNativeReceive?.(request.command === 'commit' && failCommit ? { id: request.id, error: 'rejected descriptor' } : { id: request.id, result: request.command === 'ready' ? { adapterName: 'Test native GPU', maxImageDimension: 8192, layout: 'overlay', hwrt: true, dlssRR: false, gpuSelection: false, hdrWindow: false, adapters: [], backend: 'hardware' } : responses[request.command]??null })); } }, mutracerNativeReceive: undefined as ((value: unknown) => void) | undefined };
    vi.stubGlobal('window', window);
    const canvas = { width: 96, height: 64, getBoundingClientRect: () => ({ x: 0, y: 0, width: 96, height: 64 }), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLCanvasElement;
    const uploads: Uint8Array[] = [];
    const host = new NativeRenderHost(canvas);
    hosts.push(host);
    host.upload = async (bytes) => { const parts = bytes instanceof Uint8Array ? [bytes] : bytes; const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const part of parts) { joined.set(part, at); at += part.length; } uploads.push(joined); return String(uploads.length); };
    host.camera = new Camera({ projection: 'perspective' });
    host.scene = { meshes: [new Mesh(new Geometry({ position: new Attribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]), 3) }), new OpenPBRMaterial())], lights: [] };
    return { host, commands, uploads, gpu, setFailure: (fail: boolean) => { failCommit = fail; } };
}
describe('native Engine boundary', () => {
    it('keeps context failure, sample counters and restart available through the native bridge', async () => {
        const {host, commands} = setup();
        const render = new NativeRender(host, {maxSamples: 256});
        await host.init();
        const errors = vi.fn();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        host.on('error', errors);
        const message = 'GPU execution failed: MTLCommandBufferErrorDomain code 2';
        window.mutracerNativeReceive?.({event:'state', value:{phase:'error', targets:{[render.id]:{samples:32,aovSamples:0,width:724,height:744,status:'error',denoising:false}},diagnostics:{backend:'webgpu',adapterName:'Test native GPU',width:724,height:744,lastError:message}}});
        window.mutracerNativeReceive?.({event:'error', value:message});
        expect(host.phase).toBe('error');
        expect(render.status).toBe('error');
        expect(render.samples).toBe(32);
        expect(host.getDiagnostics()?.lastError).toBe(message);
        expect(errors).toHaveBeenCalledWith(expect.objectContaining({message}));
        await changeNativeDevice({});
        expect(commands.at(-1)).toMatchObject({command:'device',args:{}});
        logged.mockRestore();
    });
    it('commits a full scene once and sends camera-only edits without geometry or browser GPU work', async () => {
        const { host, commands, uploads, gpu } = setup();
        const render = new NativeRender(host, { maxSamples: 16 });
        host.finalId = render.id;
        await host.flush();
        expect(uploads).toHaveLength(1);
        expect(new Uint32Array(uploads[0].buffer)[1]).toBe(1);
        await host.flush();
        expect(uploads).toHaveLength(1);
        expect(commands.filter(c => c.command === 'commit')).toHaveLength(1);
        host.camera!.position = [1, 2, 3];
        await host.flush();
        expect(uploads).toHaveLength(1);
        expect(commands.filter(c => c.command === 'commit')).toHaveLength(2);
        expect(gpu).not.toHaveBeenCalled();
    });
    it('waits for the imported model geometry before replacing the previous scene',async()=>{
        const replies:Record<string,unknown>={};
        const {host,commands}=setup(replies);
        const descriptor=await new NativeSceneEncoder(async()=>{throw Error('Unexpected sky');}).encode(host.scene!,host.camera!,[96,64]);
        descriptor[H.TEXTURE_COUNT]=0;
        const manifest={id:7,document:{nodes:[{mesh:0}],scenes:[{nodes:[0]}]},descriptor:'compact',groundOffset:[0,0,0],warnings:[],materialNames:['Paint'],textures:[],
            geometries:[{min:[-1,0,0],max:[1,1,0],vertices:3,indices:0,uv:false,uv1:false}],meshes:[{node:0,name:'Triangle',geometry:0,material:0,first:0,count:1}]};
        replies.importGltf={id:7,manifest:'manifest',descriptor:'compact'};
        host.download=async key=>key==='manifest'?new TextEncoder().encode(JSON.stringify(manifest)).buffer:descriptor.buffer;
        const model=await host.loadHostModel({mainPath:'scene.glb',hostPath:'/scene.glb',files:[],base:''},()=>{},new AbortController().signal);
        await host.flush();
        expect(commands.filter(c=>c.command==='commit')).toHaveLength(0);
        const root=new ThreeScene();root.add(model.root);
        host.scene=fromTHREEScene(root,{convertMaterial:source=>hostMaterials.get(source),onMeshConverted:(mesh,source)=>{mesh.geometry=hostThreeGeometries.get(source.geometry)!.geometry;}});
        await host.flush();
        const commits=commands.filter(c=>c.command==='commit');
        expect(commits).toHaveLength(1);
        expect(commits[0].args.refs).toMatchObject({geometries:[{model:7,id:0,index:0}]});
        model.revoke();
    });
    it('acknowledges native camera updates without echoing them and sends inspector edits with their revision', async () => {
        const { host, commands } = setup();
        await host.flush();
        host.camera!.position = [2,3,4];
        host.camera!.lookAt([0,0,0]);
        const words = Array.from(cameraWords(host.camera!));
        window.mutracerNativeReceive?.({event:'camera',value:{matrix:host.camera!.transform,target:[0,0,0],zoom:1,words,revision:2}});
        await host.flush();
        expect(commands.filter(c=>c.command==='commit')).toHaveLength(1);
        // This is the same matrix -> inspector values -> matrix round trip as WebEngine.
        const matrix=new Matrix4().fromArray(host.camera!.transform),position=new Vector3(),rotation=new Quaternion(),scale=new Vector3();
        matrix.decompose(position,rotation,scale);
        host.camera!.transform=Float32Array.from(matrix.compose(position,rotation,scale).elements) as NonNullable<typeof host.camera>['transform'];
        await host.flush();
        expect(commands.filter(c=>c.command==='commit')).toHaveLength(1);
        host.camera!.fov += 1;
        await host.flush();
        const edits = commands.filter(c=>c.command==='commit');
        expect(edits).toHaveLength(2);
        expect(edits[1].args.cameraRevision).toBe(2);
        host.camera!.position = [5,6,7];
        await host.flush();
        expect(commands.filter(c=>c.command==='commit')).toHaveLength(3);
    });
    it('sends retained material deltas and retries a rejected scene with a complete descriptor', async () => {
        const { host, uploads, setFailure } = setup();
        await host.flush();
        host.scene!.meshes[0].materials[0].specularRoughness = .8;
        await host.flush();
        expect(new Uint32Array(uploads[1].buffer)[1]).toBe(0);
        expect(uploads[1].byteLength).toBeLessThan(uploads[0].byteLength);
        setFailure(true);
        host.scene!.meshes[0].materials[0].baseMetalness = 1;
        await expect(host.flush()).rejects.toThrow('rejected descriptor');
        setFailure(false);
        await host.flush();
        expect(new Uint32Array(uploads[3].buffer)[1]).toBe(1);
    });
    it('bounds binary requests and discards an interrupted upload', async () => {
        const { host } = setup();
        const requests: RequestInit[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
            requests.push(init); return { ok: true };
        }));
        const data = new Uint8Array(17 * 1024 * 1024);
        data[0] = 7; data[data.length - 1] = 9;
        await NativeRenderHost.prototype.upload.call(host, [data.subarray(0, 4), data.subarray(4)]);
        const bodies = requests.map(r => r.body as Uint8Array);
        expect(bodies.every(b => b.byteLength <= 8 * 1024 * 1024)).toBe(true);
        expect(bodies.reduce((n, b) => n + b.byteLength, 0)).toBe(data.length);
        expect(bodies[0][0]).toBe(7);
        expect(bodies.at(-1)!.at(-1)).toBe(9);
        expect(requests).toHaveLength(3);
        expect((requests[1].headers as Record<string, string>)['X-Mutracer-Offset']).toBe(String(8 * 1024 * 1024));
        vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
            requests.push(init); return { ok: init.method === 'DELETE', status: 400 };
        }));
        await expect(NativeRenderHost.prototype.upload.call(host, data)).rejects.toThrow('400');
        expect(requests.at(-1)?.method).toBe('DELETE');
    });
    it('keeps independent targets and publishes host sample counts and sizes', () => {
        const { host } = setup();
        const preview = new NativeRender(host, { maxSamples: 1, resolutionScale: .5 }), final = new NativeRender(host, { fallback: preview, maxSamples: 16 });
        const listener = vi.fn();
        final.on('sample', listener);
        window.mutracerNativeReceive?.({ event: 'state', value: { phase: 'converging', targets: { [final.id]: { samples: 4, aovSamples: 2, width: 96, height: 64, status: 'converging', denoising: false, frameTimeMs: 3 } } } });
        window.mutracerNativeReceive?.({event:'sample',value:{target:final.id,samples:4,isFirstFrame:false,frameTimeMs:3}});
        expect(final.samples).toBe(4);
        expect(preview.samples).toBe(0);
        expect(listener).toHaveBeenCalledWith({ samples: 4, isFirstFrame: false, frameTimeMs: 3 });
        expect(final.width).toBe(96);
    });
});
