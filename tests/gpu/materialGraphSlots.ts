import {Engine,Render,Camera,Mesh,OpenPBRMaterial,MaterialGraph,Texture,DirectionalLight,createPlaneGeometry} from '../../src/main.js';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function run() {
    const rows=[];
    const cases=[...(['raw','float','dom','wide','alpha'] as const).map(kind=>({kind,terminal:'specularRoughness'})),...['specularWeight','coatWeight','fuzzRoughness','specularColor','fuzzColor'].map(terminal=>({kind:'dom' as const,terminal}))];
    for(const {kind,terminal} of cases) {
        const color=terminal.endsWith('Color'),type=color?'color3':'float';
        const pixels=new Uint8Array(Array.from({length:16},(_,i)=>[32+i*8,180-i*5,50+i*11,kind==='alpha'&&i===0?128:255]).flat());
        let image:Texture['image']={width:4,height:4,data:kind==='float'?new Float32Array(pixels).map(v=>v/255):pixels};
        if(kind==='dom'||kind==='wide'||kind==='alpha') {
            const canvas=new OffscreenCanvas(4,4);canvas.getContext('2d',{colorSpace:kind==='wide'?'display-p3':'srgb'})!.putImageData(new ImageData(new Uint8ClampedArray(pixels),4,4,{colorSpace:kind==='wide'?'display-p3':'srgb'}),0,0);image=await createImageBitmap(canvas,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
        }
        const texture=new Texture(image);texture.colorSpace='linear';texture.flipY=true;
        const graph=new MaterialGraph({nodes:[
            {id:'i',category:'image',type:'vector3',inputs:{file:{type:'filename',value:texture}}},
            {id:'channel',category:'extract',type:'float',inputs:{in:{type:'vector3',connection:{node:'i'}},index:{type:'integer',value:2}}},
            {id:'gain',category:'multiply',type:'float',inputs:{in1:{type:'float',connection:{node:'channel'}},in2:{type:'float',value:.7}}}
        ],terminal:{[terminal]:{node:'gain'}}});
        if(color){graph.setNode({id:'color',category:'convert',type:'color3',inputs:{in:{type:'float',connection:{node:'gain'}}}});graph.setTerminal({[terminal]:{node:'color'}});}
        const forced=new MaterialGraph({nodes:[...graph.nodes,{id:'force',category:'add',type,inputs:{in1:{type,connection:{node:color?'color':'gain'}},in2:{type,value:color?[0,0,0]:0}}}],terminal:{[terminal]:{node:'force'}}});
        const outputs:Record<string,Float32Array>={};
        for(const mode of ['graph','webgpu','webgl'] as const) {
            const engine=new Engine({canvas:document.createElement('canvas'),backend:mode==='webgl'?'webgl':'webgpu'});engine.display.setSize(32,32);
            const material=new OpenPBRMaterial({baseColor:[.6,.4,.2],coatRoughness:.2,fuzzWeight:terminal.startsWith('fuzz')?.3:0,graph:mode==='graph'?forced:graph});
            const camera=new Camera({projection:'orthographic',left:-.3,right:.3,bottom:-.3,top:.3});camera.position=[0,0,3];camera.lookAt([0,0,0]);
            const light=new DirectionalLight({intensity:2});light.position=[1,2,4];light.lookAt([0,0,0]);
            engine.scene={meshes:[new Mesh(createPlaneGeometry(1,1,'vertical'),material)],lights:[light]};engine.camera=camera;
            const render=new Render(engine,{bounces:1,samplingPattern:'sobol',directLightCandidates:1});
            try {
                engine.update();const started=performance.now();
                for(;;) {render.refine();await pause();const diagnostic=engine.getDiagnostics()?.materialGraphs;
                    if(mode!=='webgl'&&diagnostic?.status==='failed')throw Error(JSON.stringify(diagnostic));
                    if(diagnostic?.status!=='compiling'&&render.samples>=1)break;
                    if(performance.now()-started>60000)throw Error('slot preparation timeout');
                }
                const diagnostics=engine.getDiagnostics()?.materialGraphs;
                if(kind==='alpha'&&mode==='webgl') {rows.push({kind,terminal,mode,passed:diagnostics?.diagnostics.some(d=>d.code==='unsupported-backend')===true});continue;}
                await render.converge({samples:16,sampleSequenceOffset:0,timeoutMs:60000});outputs[mode]=(await render.readPixels('hdr')).data;
                if(mode==='webgpu') {
                    const expected=kind==='alpha'?1:0;
                    rows.push({kind,terminal,mode,topologyCount:diagnostics?.topologyCount,passed:diagnostics?.topologyCount===expected});
                }
            }finally{render.dispose();engine.dispose();}
        }
        for(const mode of ['webgpu','webgl'])if(outputs[mode]) {
            let max=0;for(let i=0;i<outputs.graph.length;i++)max=Math.max(max,Math.abs(outputs.graph[i]-outputs[mode][i]));
            rows.push({kind,terminal,mode,length:outputs[mode].length,referenceLength:outputs.graph.length,nonfinite:outputs[mode].filter(x=>!Number.isFinite(x)).length,max,passed:outputs[mode].length===outputs.graph.length&&Number.isFinite(max)&&max<.002});
        }
        if(image instanceof ImageBitmap)image.close();
    }
    return {rows,passed:rows.every(row=>row.passed)};
}
Object.assign(window,{runBenchmark:run});
