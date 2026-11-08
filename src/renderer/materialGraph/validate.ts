import {nodeInputs, outputType, terminalTypes, validNodeType, width} from './nodes.js';
import {GRAPH_IR_VERSION, GraphSource, graphCategories, graphGeometry, graphOutputs, graphPorts, graphTerminals, graphTypes, type GraphIR} from './ir.js';
import type {GraphType} from './types.js';

export interface IRDiagnostic {
    code: string;
    message: string;
    /** Canonical node index, or -1 for a graph-wide error. */
    node: number;
    /** Input port ID, or -1 for a graph-wide or terminal error. */
    port: number;
}
const index = (n: number, count: number) => Number.isInteger(n) && n >= 0 && n < count;
/** Check the portable boundary before interpreting indices or generating source. */
export function validateGraphIR(graph: GraphIR): IRDiagnostic[] {
    const diagnostics: IRDiagnostic[] = [];
    const report = (code: string, message: string, node: number, port: number) => {diagnostics.push({code,message,node,port});};
    if(graph.version !== GRAPH_IR_VERSION) report('unsupported-ir-version','Unsupported material graph IR version',-1,-1);
    if(graph.nodes.length%5 || graph.inputs.length%5 || graph.terminal.length%3 || graph.parameters.length%4) report('invalid-ir-layout','Incomplete material graph record',-1,-1);
    if(diagnostics.length) return diagnostics;
    const count=graph.nodes.length/5;
    for(const value of [...graph.nodes,...graph.inputs,...graph.terminal]) if(!Number.isInteger(value)) {
        report('invalid-ir-layout','Graph indices must be integers',-1,-1); return diagnostics;
    }
    for(const value of graph.parameters) if(!Number.isFinite(value)) {
        report('parameter-value','Expected finite graph parameters',-1,-1); return diagnostics;
    }
    let nextInput=0;
    for(let i=0;i<count;i++) {
        const at=i*5, category=graphCategories[graph.nodes[at]], type=graphTypes[graph.nodes[at+2]], first=graph.nodes[at+3], length=graph.nodes[at+4];
        if(!index(graph.nodes[at],graphCategories.length)) {report('unsupported-node','Unknown MaterialX category',i,-1);continue;}
        if(graph.nodes[at+1]!==1) {report('unsupported-node-implementation','Unsupported node implementation version',i,-1);continue;}
        if(!index(graph.nodes[at+2],graphTypes.length)) {report('unsupported-type','Unknown graph port type',i,-1);continue;}
        if(first!==nextInput || length<0 || first+length>graph.inputs.length/5) {report('invalid-ir-layout','Invalid node input range',i,-1);continue;}
        nextInput=first+length;
        const inputs: Record<string,{type: GraphType}> = {};
        for(let j=first;j<first+length;j++) {
            const k=j*5, port=graph.inputs[k], inputType=graph.inputs[k+1];
            if(!index(port,graphPorts.length) || !index(inputType,graphTypes.length)) {report('unsupported-input','Unknown graph input or type',i,port);continue;}
            const name=graphPorts[port];
            if(inputs[name]) report('unsupported-input','Duplicate graph input',i,port);
            inputs[name]={type:graphTypes[inputType]};
        }
        const node={category,type,inputs}, defaults=nodeInputs(node)!;
        if(category==='convert' && (width(inputs.in?.type ?? 'float')>1 && width(type)===1 || ['filename','string'].includes(inputs.in?.type ?? 'float'))) report('unsupported-conversion','Unsupported graph conversion',i,graphPorts.indexOf('in'));
        if(category==='dotproduct' && !['vector2','vector3','vector4'].includes(inputs.in1?.type ?? 'vector3')) report('unsupported-type','dotproduct requires vector inputs',i,graphPorts.indexOf('in1'));
        if(category==='extract' && !['color3','color4','vector2','vector3','vector4'].includes(inputs.in?.type ?? 'color3')) report('unsupported-type','extract requires a color or vector',i,graphPorts.indexOf('in'));
        if(!validNodeType(node)) report('unsupported-type',`Unsupported ${category}/${type}`,i,-1);
        for(const name of Object.keys(defaults)) if(!inputs[name]) report('missing-input',`Missing normalized input ${name}`,i,graphPorts.indexOf(name));
        for(let j=first;j<first+length;j++) {
            const k=j*5, port=graph.inputs[k], inputType=graphTypes[graph.inputs[k+1]], kind=graph.inputs[k+2], source=graph.inputs[k+3], output=graph.inputs[k+4], name=graphPorts[port];
            if(!defaults[name]) {report('unsupported-input',`Unsupported input ${name}`,i,port);continue;}
            if(inputType!==defaults[name].type) report('input-type',`Expected ${defaults[name].type}, got ${inputType}`,i,port);
            if(kind===GraphSource.Node) {
                if(!index(source,i) || !index(output,graphOutputs.length)) {report('connection-type','Connections must reference an earlier node and a known output',i,port);continue;}
                const parent={category:graphCategories[graph.nodes[source*5]],type:graphTypes[graph.nodes[source*5+2]]};
                if(!parent.category || !parent.type || outputType(parent,graphOutputs[output])!==inputType) report('connection-type',`Expected ${inputType} connection`,i,port);
            } else if(kind===GraphSource.Geometry) {
                const geometry=graphGeometry[source], expected=name==='position'?'objectPosition':name;
                if(!index(source,graphGeometry.length) || geometry!==expected || defaults[name].value!==undefined || inputType==='filename' || output!==0) report('unsupported-input','Invalid implicit geometry input',i,port);
            } else if(kind===GraphSource.Parameter) {
                if(!index(source,graph.parameters.length/4) || output!==0) {report('parameter-value','Invalid parameter slot',i,port);continue;}
                const value=graph.parameters[source*4];
                for(let c=width(inputType);c<4;c++) if(graph.parameters[source*4+c]!==0) report('parameter-value','Unused parameter components must be zero',i,port);
                if(inputType==='boolean' && value!==0 && value!==1) report('parameter-value','Expected boolean parameter',i,port);
                if(inputType==='integer' && (!Number.isInteger(value)||Math.abs(value)>16777216)) report('unsupported-integer-range','Integer parameters must be exactly representable in Float32',i,port);
                if(inputType==='filename' && (!Number.isInteger(value)||value< -1||value>16777216)) report('parameter-type','Expected a texture slot or -1',i,port);
                if(category==='extract' && name==='index' && (value<0||value>=width(inputs.in?.type ?? 'color3'))) report('parameter-value','extract index is outside the input vector',i,port);
                if((category==='tangent'||category==='bitangent') && name==='index' && value!==0) report('unsupported-frame','Only the primary tangent frame is supported',i,port);
                if(category==='texcoord' && value!==0 && value!==1) report('unsupported-uv','Only UV0 and UV1 are supported',i,port);
                if(category==='place2d' && name==='operationorder' && value!==0 && value!==1) report('parameter-value','operationorder must be 0 or 1',i,port);
                if(inputType==='string' && (name==='space' ? value!==0&&value!==1 : name==='fromspace'||name==='tospace' ? value!== -1&&value!==0&&value!==1 : name!=='note'&&value!==0)) report('unsupported-space','Invalid encoded string parameter',i,port);
            } else report('invalid-ir-layout','Unknown graph input source kind',i,port);
        }
    }
    if(nextInput!==graph.inputs.length/5) report('invalid-ir-layout','Unowned material graph inputs',-1,-1);
    const terminals: number[]=[];
    for(let j=0;j<graph.terminal.length;j+=3) {
        const port=graph.terminal[j], source=graph.terminal[j+1], output=graph.terminal[j+2];
        if(!index(port,graphTerminals.length)||!index(source,count)||!index(output,graphOutputs.length)) {report('unsupported-terminal','Invalid terminal reference',source,-1);continue;}
        if(terminals.includes(port)) report('duplicate-terminal','Duplicate OpenPBR terminal',source,-1);
        terminals.push(port);
        const node={category:graphCategories[graph.nodes[source*5]],type:graphTypes[graph.nodes[source*5+2]]};
        if(!node.category || !node.type || outputType(node,graphOutputs[output])!==terminalTypes[graphTerminals[port]]) report('terminal-type',`Expected ${terminalTypes[graphTerminals[port]]} terminal`,source,-1);
    }
    return diagnostics;
}
