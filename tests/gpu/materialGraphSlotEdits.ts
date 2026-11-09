import {Engine,Render,Camera,Mesh,OpenPBRMaterial,MaterialGraph,Texture,DirectionalLight,createPlaneGeometry} from '../../src/main.js';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
const image=(rgb:number[])=>{const texture=new Texture({width:4,height:4,data:new Uint8Array(Array.from({length:16},()=>[...rgb,255]).flat())});texture.colorSpace='linear';return texture;};
async function scene(backend:'webgpu'|'webgl',material:OpenPBRMaterial) {
    const engine=new Engine({canvas:document.createElement('canvas'),backend});engine.display.setSize(32,32);
    const camera=new Camera({projection:'orthographic',left:-.3,right:.3,bottom:-.3,top:.3});camera.position=[0,0,3];camera.lookAt([0,0,0]);
    const light=new DirectionalLight({intensity:1});light.position=[1,2,4];light.lookAt([0,0,0]);
    engine.scene={meshes:[new Mesh(createPlaneGeometry(1,1,'vertical'),material)],lights:[light]};engine.camera=camera;
    const render=new Render(engine,{bounces:1,directLightCandidates:1,samplingPattern:'sobol'});
    const capture=async()=>{
        engine.update();const start=performance.now();
        for(;;){render.refine();await pause();const graph=engine.getDiagnostics()?.materialGraphs;
            if(backend==='webgpu'&&graph?.status==='failed')throw Error(JSON.stringify(graph));
            if(graph?.status!=='compiling'&&render.samples>=1)break;
            if(performance.now()-start>60000)throw Error('slot edit preparation timeout');
        }
        await render.converge({samples:16,sampleSequenceOffset:0,timeoutMs:60000});return (await render.readPixels('hdr')).data;
    };
    return {engine,render,capture,dispose(){render.dispose();engine.dispose();}};
}
function difference(a:Float32Array,b:Float32Array){if(a.length!==b.length)throw Error('Image sizes differ');let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));return max;}
async function run(){
    const rows=[];
    for(const backend of ['webgpu','webgl'] as const){
        const source=image([220,40,25]),fallback=image([25,180,60]);
        const graph=new MaterialGraph({nodes:[{id:'i',category:'image',type:'color3',inputs:{file:{type:'filename',value:source}}}],terminal:{baseColor:{node:'i'}}});
        const material=new OpenPBRMaterial({graph,baseColor:[.6,.4,.2],map:fallback,mapAlphaUsage:'opaque',specularRoughness:.4});
        const edited=await scene(backend,material);
        try{
            const before=await edited.capture();
            graph.setNode({id:'uv',category:'texcoord',type:'vector2'}).setNode({id:'roughness',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}).setTerminal({specularRoughness:{node:'roughness'}});
            const after=await edited.capture(),reference=await scene(backend,material);
            try{const expected=await reference.capture(),max=difference(after,expected),change=difference(before,after);rows.push({backend,case:'restore-disconnected-input',max,change,passed:Number.isFinite(max)&&max<.002&&change>.05});}finally{reference.dispose();}
            graph.setTerminal({baseColor:{node:'i'}});const restored=await edited.capture(),max=difference(restored,before);rows.push({backend,case:'graph-to-slot',max,passed:Number.isFinite(max)&&max<.002});
        }finally{edited.dispose();}
        const normalGraph=new MaterialGraph({nodes:[{id:'image',category:'image',type:'vector3',inputs:{file:{type:'filename',value:image([200,70,255])}}},{id:'normal',category:'normalmap',type:'vector3',inputs:{in:{type:'vector3',connection:{node:'image'}}}}],terminal:{normal:{node:'normal'}}});
        const normalMaterial=new OpenPBRMaterial({graph:normalGraph,baseColor:[.6,.4,.2],coatWeight:.3,coatRoughness:.2}),normalScene=await scene(backend,normalMaterial);
        try{
            await normalScene.capture();
            normalGraph.setNode({id:'force',category:'add',type:'vector3',inputs:{in1:{type:'vector3',connection:{node:'normal'}},in2:{type:'vector3',value:[0,0,0]}}}).setTerminal({normal:{node:'force'}});
            const actual=await normalScene.capture(),reference=await scene(backend,normalMaterial);
            try{const max=difference(actual,await reference.capture());rows.push({backend,case:'normal-frame-after-slot-retirement',max,passed:Number.isFinite(max)&&max<.002});}finally{reference.dispose();}
        }finally{normalScene.dispose();}
        const weighted=new MaterialGraph({nodes:[
            {id:'i',category:'image',type:'float',inputs:{file:{type:'filename',value:source}}},
            {id:'gain',category:'multiply',type:'float',inputs:{in1:{type:'float',connection:{node:'i'}},in2:{type:'float',value:0}}}
        ],terminal:{coatWeight:{node:'gain'}}});
        const test=await scene(backend,new OpenPBRMaterial({graph:weighted,coatRoughness:.2}));
        let compiles=0;
        const gpu=GPUDevice.prototype.createComputePipelineAsync,gl=WebGL2RenderingContext.prototype.createProgram;
        GPUDevice.prototype.createComputePipelineAsync=function(this:GPUDevice,descriptor){if(descriptor.label==='Ray Trace')compiles++;return gpu.call(this,descriptor);};
        WebGL2RenderingContext.prototype.createProgram=function(this:WebGL2RenderingContext){compiles++;return gl.call(this);};
        try{
            await test.capture();const before=compiles;weighted.setInput('gain','in2',{type:'float',value:.5});const pixels=await test.capture();
            rows.push({backend,case:'zero-gain-edit',compiles:compiles-before,passed:compiles===before&&pixels.every(Number.isFinite)});
        }finally{GPUDevice.prototype.createComputePipelineAsync=gpu;WebGL2RenderingContext.prototype.createProgram=gl;test.dispose();}
    }
    return {rows,passed:rows.every(row=>row.passed)};
}
Object.assign(window,{runBenchmark:run});
