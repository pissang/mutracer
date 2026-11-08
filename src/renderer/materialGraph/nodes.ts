import type { MaterialGraphInput as Input, MaterialGraphNode as Node, MaterialGraphType as Type } from '../../scene/MaterialGraph.js';
export const width = (type: Type) => type === 'vector2' ? 2 : type === 'vector3' || type === 'color3' ? 3 : type === 'vector4' || type === 'color4' ? 4 : 1;
const input = (type: Type, value?: Input['value']): Input => ({ type, value: type === 'boolean' ? Boolean(value) : type === 'filename' || type === 'string' ? value : value ?? (width(type) === 1 ? 0 : Array(width(type)).fill(0)) });
const same = (node: Node, value = 0) => input(node.type, width(node.type) === 1 ? value : Array(width(node.type)).fill(value));
export const terminalAliases: Record<string, string> = { geometryOpacity: 'opacity', geometryNormal: 'normal', specularRoughnessAnisotropy: 'specularAnisotropy', coatRoughnessAnisotropy: 'coatAnisotropy' };
export const terminalTypes: Record<string, Type> = {
    baseWeight: 'float', baseColor: 'color3', baseDiffuseRoughness: 'float', baseMetalness: 'float',
    specularWeight: 'float', specularColor: 'color3', specularRoughness: 'float', specularIor: 'float', specularAnisotropy: 'float',
    transmissionWeight: 'float', transmissionColor: 'color3',
    fuzzWeight: 'float', fuzzColor: 'color3', fuzzRoughness: 'float', coatWeight: 'float', coatColor: 'color3',
    coatRoughness: 'float', coatAnisotropy: 'float', coatIor: 'float', coatDarkening: 'float',
    thinFilmWeight: 'float', thinFilmThickness: 'float', thinFilmIor: 'float',
    opacity: 'float', emissionColor: 'color3', emissionLuminance: 'float', normal: 'vector3'
};
/** Definitions are authored against MaterialX v1.39.4 stdlib_defs.mtlx/stdlib_ng.mtlx.
 * Parameters remain runtime data even for conditional controls and UV transforms. */
export function nodeInputs(node: Node): Record<string, Input> | undefined {
    const t = node.type, a = node.inputs ?? {}, scalar = input('float');
    switch (node.category) {
        case 'noise2d':
        case 'noise3d':
        case 'fractal3d':
        case 'cellnoise2d':
        case 'cellnoise3d':
        case 'worleynoise2d':
        case 'worleynoise3d': return {
            ...(node.category.endsWith('2d') ? {texcoord:{type:'vector2' as Type}} : {position:{type:'vector3' as Type}}),
            ...(/^(noise|fractal)/.test(node.category) ? {amplitude:a.amplitude?.type === 'float' ? input('float',1) : same(node,1), ...(node.category === 'fractal3d' ? {octaves:input('integer',3),lacunarity:input('float',2),diminish:input('float',0.5)} : {pivot:scalar})} : {}),
            ...(node.category.startsWith('worley') ? {jitter:input('float',1),style:input('integer',0)} : {})
        };
        case 'splitlr': return {valuel:same(node),valuer:same(node),center:input('float',0.5),texcoord:{type:'vector2'}};
        case 'splittb': return {valuet:same(node),valueb:same(node),center:input('float',0.5),texcoord:{type:'vector2'}};
        case 'ramplr': return {valuel:same(node),valuer:same(node),texcoord:{type:'vector2'}};
        case 'ramptb': return {valuet:same(node),valueb:same(node),texcoord:{type:'vector2'}};
        case 'ramp4': return {valuetl:same(node),valuetr:same(node),valuebl:same(node),valuebr:same(node),texcoord:{type:'vector2'}};
        case 'burn':
        case 'dodge':
        case 'screen':
        case 'overlay':
        case 'difference':
        case 'plus':
        case 'minus': return {fg:same(node),bg:same(node),mix:input('float',1)};
        case 'dot': return { in: same(node), note: input('string', '') };
        case 'extract': return { in: input(a.in?.type ?? 'color3'), index: input('integer') };
        case 'invert': return { in: same(node), amount: a.amount?.type === 'float' ? input('float', 1) : same(node, 1) };
        case 'remap':
        case 'range': return { in: same(node), ...Object.fromEntries(['inlow', 'inhigh', 'outlow', 'outhigh'].map((p, i) => [p, a[p]?.type === 'float' ? input('float', i % 2) : same(node, i % 2)])), ...(node.category === 'range' ? {gamma: a.gamma?.type === 'float' ? input('float', 1) : same(node, 1), doclamp: input('boolean', false)} : {}) };
        case 'contrast': return { in: same(node), amount: a.amount?.type === 'float' ? input('float', 1) : same(node, 1), pivot: a.pivot?.type === 'float' ? input('float', 0.5) : same(node, 0.5) };
        case 'luminance': return { in: same(node), lumacoeffs: input('color3', [0.2722287, 0.6740818, 0.0536895]) };
        case 'rotate2d': return { in: input('vector2'), amount: scalar };
        case 'rotate3d': return { in: input('vector3'), amount: scalar, axis: input('vector3', [0, 1, 0]) };
        case 'atan2': return { iny: same(node), inx: same(node, 1) };
        case 'transformpoint':
        case 'transformvector':
        case 'transformnormal': return { in: input('vector3', node.category === 'transformnormal' ? [0, 0, 1] : [0, 0, 0]), fromspace: input('string', ''), tospace: input('string', '') };
        case 'constant': return { value: same(node) };
        case 'texcoord': return { index: input('integer') };
        case 'position':
        case 'normal': return { space: input('string', 'object') };
        case 'tangent':
        case 'bitangent': return { space: input('string', 'object'), index: input('integer', 0) };
        case 'gltf_image':
        case 'gltf_colorimage':
        case 'gltf_normalmap': return {
            file:input('filename'),default:node.category==='gltf_normalmap'?input('vector3',[0.5,0.5,1]):same(node),texcoord:{type:'vector2'},
            pivot:input('vector2',[0,1]),scale:input('vector2',[1,1]),rotate:scalar,offset:input('vector2'),operationorder:input('integer',t==='color4'?1:0),
            uaddressmode:input('string','periodic'),vaddressmode:input('string','periodic'),filtertype:input('string','linear'),
            ...(node.category==='gltf_colorimage'?{color:input('color4',[1,1,1,1]),geomcolor:input('color4',[1,1,1,1])}:node.category==='gltf_image'&&t!=='vector3'?{factor:same(node,1)}:{})
        };
        case 'image':
        case 'tiledimage': return {
            file: input('filename'), default: same(node), texcoord: { type: 'vector2' }, filtertype: input('string', 'linear'),
            ...(node.category === 'image' ? { uaddressmode: input('string', 'periodic'), vaddressmode: input('string', 'periodic') } : {}),
            ...(node.category === 'tiledimage' ? { uvtiling: input('vector2', [1, 1]), uvoffset: input('vector2', [0, 0]), realworldimagesize: input('vector2', [1, 1]), realworldtilesize: input('vector2', [1, 1]) } : {})
        };
        case 'place2d': return { texcoord: input('vector2'), pivot: input('vector2'), scale: input('vector2', [1, 1]), rotate: scalar, offset: input('vector2'), operationorder: input('integer') };
        case 'convert': return { in: input(a.in?.type ?? 'float') };
        case 'normalmap': return { in: input('vector3', [0.5, 0.5, 1]), scale: input(a.scale?.type === 'vector2' ? 'vector2' : 'float', a.scale?.type === 'vector2' ? [1, 1] : 1), normal: { type: 'vector3' }, tangent: { type: 'vector3' }, bitangent: { type: 'vector3' } };
        case 'add':
        case 'subtract':
        case 'multiply':
        case 'divide':
        case 'modulo':
        case 'power':
        case 'min':
        case 'max':
            return { in1: same(node), in2: a.in2?.type === 'float' && width(t) > 1 ? input('float', ['add', 'subtract', 'min', 'max'].includes(node.category) ? 0 : 1) : same(node, ['add', 'subtract', 'min', 'max'].includes(node.category) ? 0 : 1) };
        case 'mix': return { bg: same(node), fg: same(node), mix: a.mix?.type === t ? same(node, 0) : input('float', 0) };
        case 'smoothstep':
        case 'clamp': return { in: same(node), low: a.low?.type === 'float' ? scalar : same(node), high: a.high?.type === 'float' ? input('float', 1) : same(node, 1) };
        case 'ifgreater':
        case 'ifequal': return { value1: input(a.value1?.type === 'integer' ? 'integer' : 'float', node.category === 'ifgreater' ? 1 : 0), value2: input(a.value2?.type === 'integer' ? 'integer' : 'float'), in1: same(node), in2: same(node) };
        case 'separate2':
        case 'separate3':
        case 'separate4': return { in: same(node) };
        case 'combine2':
        case 'combine3':
        case 'combine4': return Object.fromEntries(Array.from({ length: width(t) }, (_, i) => [`in${i + 1}`, input('float')]));
        case 'dotproduct': return { in1: input(a.in1?.type ?? 'vector3'), in2: input(a.in1?.type ?? 'vector3') };
        case 'crossproduct': return { in1: input('vector3'), in2: input('vector3') };
        case 'rgbtohsv':
        case 'hsvtorgb': return { in: same(node) };
        case 'abs':
        case 'floor':
        case 'ceil':
        case 'round':
        case 'tan':
        case 'asin':
        case 'acos':
        case 'sin':
        case 'cos':
        case 'sqrt':
        case 'exp':
        case 'ln':
        case 'sign':
        case 'normalize': return { in: same(node) };
        default: return undefined;
    }
}
export function outputType(node: Node, port = 'out'): Type | undefined {
    if (node.category === 'gltf_colorimage') return port === 'outcolor' ? 'color3' : port === 'outa' ? 'float' : undefined;
    if (node.category.startsWith('separate'))
        return (node.type.startsWith('color') ? 'rgba' : 'xyzw').slice(0, width(node.type)).split('').some(c => port === `out${c}`) ? 'float' : undefined;
    return port === 'out' ? node.type : undefined;
}
export function validNodeType(node: Node) {
    const { category: c, type: t } = node;
    if (c === 'gltf_colorimage') return t === 'color4';
    if (c === 'gltf_normalmap') return t === 'vector3';
    if (c === 'gltf_image') return ['float','color3','color4','vector3'].includes(t);
    if (c === 'texcoord' || c === 'place2d' || c === 'rotate2d')
        return t === 'vector2';
    if (['normalmap', 'position', 'normal', 'tangent', 'bitangent', 'crossproduct', 'rotate3d', 'transformpoint', 'transformvector', 'transformnormal'].includes(c))
        return t === 'vector3';
    if (c === 'rgbtohsv' || c === 'hsvtorgb')
        return t === 'color3';
    if (c === 'normalize') return t.startsWith('vector');
    if (['tan','asin','acos','atan2'].includes(c)) return t === 'float' || t.startsWith('vector');
    if (c.startsWith('cellnoise')) return t === 'float';
    if (c.startsWith('worleynoise')) return t === 'float' || t === 'vector2' || t === 'vector3';
    if (['burn','dodge','screen','overlay','difference','plus','minus'].includes(c)) return t === 'float' || t === 'color3' || t === 'color4';
    if (c === 'luminance') return t === 'color3' || t === 'color4';
    if (c === 'dotproduct' || c === 'extract')
        return t === 'float';
    if (/^(separate|combine)[234]$/.test(c))
        return width(t) === Number(c.at(-1));
    if (c === 'constant' || c === 'convert' || c === 'dot')
        return t !== 'filename' && t !== 'string';
    return !['filename', 'string', 'boolean', 'integer'].includes(t);
}
