import type {GraphType} from './types.js';
// Versioned portable graph contract. IDs are append-only within an IR version.
// Node words: category, implementation, type, first input, input count.
// Input words: port, type, source kind, source index, output.
// Terminal words: port, source node, output. Parameters occupy four numbers.
export const GRAPH_IR_VERSION = 1;
export const GRAPH_NODE_WORDS = 5;
export const GRAPH_INPUT_WORDS = 5;
export const GRAPH_TERMINAL_WORDS = 3;
export enum GraphSource { Parameter = 0, Node = 1, Geometry = 2 }
export const graphCategories = ['abs', 'acos', 'add', 'asin', 'atan2', 'bitangent', 'burn', 'ceil', 'cellnoise2d', 'cellnoise3d', 'clamp', 'combine2', 'combine3', 'combine4', 'constant', 'contrast', 'convert', 'cos', 'crossproduct', 'difference', 'divide', 'dodge', 'dot', 'dotproduct', 'exp', 'extract', 'floor', 'fractal3d', 'gltf_colorimage', 'gltf_image', 'gltf_normalmap', 'hsvtorgb', 'ifequal', 'ifgreater', 'image', 'invert', 'ln', 'luminance', 'max', 'min', 'minus', 'mix', 'modulo', 'multiply', 'noise2d', 'noise3d', 'normal', 'normalize', 'normalmap', 'overlay', 'place2d', 'plus', 'position', 'power', 'ramp4', 'ramplr', 'ramptb', 'range', 'remap', 'rgbtohsv', 'rotate2d', 'rotate3d', 'round', 'screen', 'separate2', 'separate3', 'separate4', 'sign', 'sin', 'smoothstep', 'splitlr', 'splittb', 'sqrt', 'subtract', 'tan', 'tangent', 'texcoord', 'tiledimage', 'transformnormal', 'transformpoint', 'transformvector', 'worleynoise2d', 'worleynoise3d', 'hsvadjust'];
export const graphPorts = ['amplitude', 'amount', 'axis', 'bg', 'bitangent', 'center', 'color', 'default', 'diminish', 'doclamp', 'factor', 'fg', 'file', 'filtertype', 'fromspace', 'gamma', 'geomcolor', 'high', 'in', 'in1', 'in2', 'in3', 'in4', 'index', 'inhigh', 'inlow', 'inx', 'iny', 'jitter', 'lacunarity', 'low', 'lumacoeffs', 'mix', 'normal', 'note', 'octaves', 'offset', 'operationorder', 'outhigh', 'outlow', 'pivot', 'position', 'realworldimagesize', 'realworldtilesize', 'rotate', 'scale', 'space', 'style', 'tangent', 'texcoord', 'tospace', 'uaddressmode', 'uvoffset', 'uvtiling', 'vaddressmode', 'value', 'value1', 'value2', 'valueb', 'valuebl', 'valuebr', 'valuel', 'valuer', 'valuet', 'valuetl', 'valuetr'];
export const graphTerminals = ['baseWeight', 'baseColor', 'baseDiffuseRoughness', 'baseMetalness', 'specularWeight', 'specularColor', 'specularRoughness', 'specularIor', 'specularAnisotropy', 'transmissionWeight', 'transmissionColor', 'fuzzWeight', 'fuzzColor', 'fuzzRoughness', 'coatWeight', 'coatColor', 'coatRoughness', 'coatAnisotropy', 'coatIor', 'coatDarkening', 'thinFilmWeight', 'thinFilmThickness', 'thinFilmIor', 'opacity', 'emissionColor', 'emissionLuminance', 'normal'];
export const graphOutputs = ['out', 'outx', 'outy', 'outz', 'outw', 'outr', 'outg', 'outb', 'outa', 'outcolor'];
export const graphGeometry = ['texcoord', 'objectPosition', 'normal', 'tangent', 'bitangent'];
export const graphTypes: GraphType[] = ['float', 'integer', 'boolean', 'color3', 'color4', 'vector2', 'vector3', 'vector4', 'filename', 'string'];

export interface GraphIR {
    version: number;
    nodes: number[];
    inputs: number[];
    terminal: number[];
    parameters: number[];
}
export function emptyGraphIR(): GraphIR {
    return {version: GRAPH_IR_VERSION, nodes: [], inputs: [], terminal: [], parameters: []};
}
