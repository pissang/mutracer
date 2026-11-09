import {Engine,Render,Camera,Mesh,OpenPBRMaterial,MaterialGraph,Texture,DirectionalLight,GeometryAttribute,createPlaneGeometry} from '../../src/main.js';
const pause=()=>new Promise(r=>setTimeout(r,5));
async function run(){
    const results=[];
    for(const black of [false,true])for(const provided of [false,true])for(const mirror of [false,true]){
        const label=`${black?'black':'tilted'}-${provided?'tangent':'derivative'}-${mirror?'mirror':'scale'}`;
        const image={width:4,height:4,data:new Float32Array(Array.from({length:16},()=>black?[0,0,0,1]:[.8,.3,1,1]).flat())};
        const texture=new Texture(image);texture.colorSpace='linear';texture.uvChannel=1;texture.normalMapFrame='materialx';
        const geometry=createPlaneGeometry(1,1,'vertical');geometry.uv1=new GeometryAttribute(geometry.uv!.array.slice() as Float32Array,2);
        if(provided)geometry.tangent=new GeometryAttribute(new Float32Array(Array.from({length:geometry.position.array.length/3},()=>[1,0,0,1]).flat()),4);
        const graph=new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2',inputs:{index:{type:'integer',value:1}}},{id:'i',category:'image',type:'vector3',inputs:{file:{type:'filename',value:texture},texcoord:{type:'vector2',connection:{node:'uv'}}}},{id:'n',category:'normalmap',type:'vector3',inputs:{in:{type:'vector3',connection:{node:'i'}},scale:{type:'vector2',value:[.6,.8]}}}],terminal:{normal:{node:'n'}}});
        const outputs:Record<string,{hdr:Float32Array;normal:Float32Array}>={};
        for(const mode of ['graph','webgpu','webgl'] as const){
            const engine=new Engine({canvas:document.createElement('canvas'),backend:mode==='webgl'?'webgl':'webgpu'});engine.display.setSize(16,16);
            const material=new OpenPBRMaterial({baseColor:[.7,.4,.2],specularRoughness:.4,coatWeight:.3,coatRoughness:.2,normalScale:[.6,.8],...(mode==='graph'?{graph}:{normalMap:texture})});
            const mesh=new Mesh(geometry,material);mesh.transform[0]=mirror?-1.2:1.2;mesh.transform[5]=.8;mesh.transform[10]=.7;mesh.transform[4]=.2;
            const light=new DirectionalLight({intensity:1});light.position=[1,2,4];light.lookAt([0,0,0]);
            const camera=new Camera({projection:'orthographic',left:-.25,right:.25,bottom:-.25,top:.25});camera.position=[0,0,3];camera.lookAt([0,0,0]);
            engine.scene={meshes:[mesh],lights:[light]};engine.camera=camera;
            const render=new Render(engine,{bounces:1,directLightCandidates:1,samplingPattern:'sobol'});
            try{
                engine.update();const started=performance.now();for(;;){render.refine();await pause();const status=engine.getDiagnostics()?.materialGraphs?.status;if(status==='failed')throw Error(JSON.stringify(engine.getDiagnostics()));if(status!=='compiling'&&render.samples>=1)break;if(performance.now()-started>60000)throw Error('slot setup timeout');}
                render.restart();await render.converge({samples:16,sampleSequenceOffset:0,timeoutMs:60000});
                outputs[mode]={hdr:(await render.readPixels('hdr')).data,normal:(await render.readPixels('normal')).data};
                if(mode==='webgpu'){
                    material.coatWeight=0;texture.normalMapFrame='cotangent';engine.update();render.restart();await render.converge({samples:1,timeoutMs:60000});
                    if(!(await render.readPixels('hdr')).data.every(Number.isFinite))throw Error('non-finite frame edit');
                    texture.normalMapFrame='materialx';
                }
            }finally{render.dispose();engine.dispose();}
        }
        for(const backend of ['webgpu','webgl']){
            let maxHdr=0,maxNormal=0;
            for(let i=0;i<outputs.graph.hdr.length;i++){
                maxHdr=Math.max(maxHdr,Math.abs(outputs.graph.hdr[i]-outputs[backend].hdr[i]));maxNormal=Math.max(maxNormal,Math.abs(outputs.graph.normal[i]-outputs[backend].normal[i]));
            }
            results.push({label,backend,maxHdr,maxNormal,passed:Number.isFinite(maxHdr)&&Number.isFinite(maxNormal)&&maxHdr<.002&&maxNormal<.002});
        }
    }
    return {results,passed:results.every(r=>r.passed)};
}
Object.assign(window,{runBenchmark:run});
