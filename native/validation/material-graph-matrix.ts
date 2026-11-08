import {materialGraphCases} from '../../tests/gpu/materialGraphs.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate.js';
import {Texture} from '../../src/main.js';
import {readFileSync,writeFileSync} from 'node:fs';
const rows=materialGraphCases().map(test=>{
const terminal=test.graph.terminal.emissionColor!;
test.graph.setNode({id:'positive-output',category:'add',type:'color3',inputs:{in1:{type:'color3',connection:terminal},in2:{type:'color3',value:[2,2,2]}}});
test.graph.setTerminal({emissionColor:{node:'positive-output'}});
const g=normalizeGraph(test.graph,'webgpu');if(g.diagnostics.length)throw Error(JSON.stringify(g.diagnostics));
const ir=flattenGraph(g),textures:any[]=[];
for(let i=0;i<g.parameters.length;i++){const t=g.parameters[i];if(t instanceof Texture){ir.parameters[i*4]=textures.length;textures.push({width:t.image.width,height:t.image.height,data:Array.from((t.image as any).data),scale:t.uvScale,offset:t.uvOffset,wrap:[t.wrapS,t.wrapT].map(x=>['repeat','clamp-to-edge','mirrored-repeat'].indexOf(x)),flipY:t.flipY,udim:!!t.udim});}}
return {name:test.name,ir,authorIds:g.nodes.map(n=>n.id),textures,expected:evaluateGraph(g,{uv:[.37,.61],uv1:[0,0],normal:[0,0,1],tangent:[1,0,0],bitangent:[0,1,0],position:[0,0,0],sample:test.sample}).emissionColor};
});
const path='native/tests/fixtures/material-graph-matrix.json',text=JSON.stringify(rows);
if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==text)throw Error('Regenerate '+path);}
else writeFileSync(path,text);
console.log(rows.length+' material graph GPU fixtures');
