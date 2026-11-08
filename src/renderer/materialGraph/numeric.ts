// MaterialX 1.39.4 stdlib semantics; see THIRD_PARTY_NOTICES.md and LICENSES/MaterialX-*.txt.
// This pure evaluator is also the native constant-folding contract.
import {width} from './types.js';
import type {GraphType} from './types.js';
import {evaluateNoise} from './noise.js';
export type Numeric = number[];
const zip = (a: Numeric, b: Numeric, f: (a: number, b: number) => number) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(a[i % a.length], b[i % b.length]));
const normalize = (a: Numeric) => { const length = Math.hypot(...a); return a.map(v => v / length); };
function roundEven(x: number) { const n = Math.floor(x), f = x - n; return f === 0.5 ? (n % 2 === 0 ? n : n + 1) : Math.floor(x + 0.5); }
export function evaluateNumericNode(category: string, type: GraphType, a: Record<string, Numeric>): Numeric {
    const c = category, v = a.in, first = a.in1, second = a.in2;
    switch (c) {
        case 'noise2d': case 'noise3d': case 'fractal3d': case 'cellnoise2d': case 'cellnoise3d': case 'worleynoise2d': case 'worleynoise3d':
            return evaluateNoise(c,a.texcoord??a.position,width(type),a);
        // Point-sampled limit of MaterialX's derivative-filtered aastep.
        case 'splitlr': return a.texcoord[0] >= a.center[0] ? a.valuer : a.valuel;
        case 'splittb': return a.texcoord[1] >= a.center[0] ? a.valueb : a.valuet;
        case 'ramplr': case 'ramptb': case 'ramp4': {
            const x=Math.max(0,Math.min(1,a.texcoord[0])),y=Math.max(0,Math.min(1,a.texcoord[1]));
            const mix=(b:Numeric,f:Numeric,t:number)=>zip(b,f,(b,f)=>b*(1-t)+f*t);
            return c==='ramplr'?mix(a.valuel,a.valuer,x):c==='ramptb'?mix(a.valuet,a.valueb,y):mix(mix(a.valuetl,a.valuetr,x),mix(a.valuebl,a.valuebr,x),y);
        }
        case 'burn': case 'dodge': case 'screen': case 'overlay': case 'difference': case 'plus': case 'minus':
            return zip(a.fg,a.bg,(fg,bg)=>{
                if(c==='burn'&&Math.abs(fg)<1e-8 || c==='dodge'&&Math.abs(1-fg)<1e-8)return 0;
                const blend=c==='burn'?1-(1-bg)/fg:c==='dodge'?bg/(1-fg):c==='screen'?1-(1-fg)*(1-bg):c==='overlay'?(bg>=0.5?1-2*(1-fg)*(1-bg):2*fg*bg):c==='difference'?Math.abs(bg-fg):c==='plus'?bg+fg:bg-fg;
                return blend*a.mix[0]+bg*(1-a.mix[0]);
            });
        case 'constant': return a.value;
        case 'dot': return v;
        case 'extract': return [v[Math.trunc(a.index[0])]];
        case 'invert': return zip(a.amount, v, (x, y) => x - y);
        case 'remap':
        case 'range': {
            let result = zip(zip(v, a.inlow, (x,y) => x-y), zip(a.inhigh, a.inlow, (x,y) => x-y), (x,y) => x/y);
            if (c === 'range') result = zip(result, a.gamma, (x,y) => Math.sign(x) * Math.pow(Math.abs(x), 1/y));
            result = zip(result, zip(a.outhigh, a.outlow, (x,y) => x-y), (x,y) => x*y);
            result = zip(result, a.outlow, (x,y) => x+y);
            return c === 'range' && a.doclamp[0] ? zip(zip(result, a.outlow, Math.max), a.outhigh, Math.min) : result;
        }
        case 'smoothstep': return v.map((x,i) => { const low=a.low[i%a.low.length], high=a.high[i%a.high.length]; if(x>=high)return 1; if(x<=low)return 0; const t=(x-low)/(high-low); return t*t*(3-2*t); });
        case 'contrast': return zip(zip(zip(v, a.pivot, (x,y) => x-y), a.amount, (x,y) => x*y), a.pivot, (x,y) => x+y);
        case 'luminance': { const l=v.slice(0,3).reduce((sum,x,i) => sum+x*a.lumacoeffs[i],0); return width(type) === 4 ? [l,l,l,v[3]] : [l,l,l]; }
        case 'atan2': return zip(a.iny, a.inx, Math.atan2);
        case 'rotate2d': { const t=a.amount[0]*Math.PI/180; return [Math.cos(t)*v[0]+Math.sin(t)*v[1], -Math.sin(t)*v[0]+Math.cos(t)*v[1]]; }
        case 'rotate3d': {
            const axis=normalize(a.axis), t=a.amount[0]*Math.PI/180, cs=Math.cos(t), sn=Math.sin(t), dot=v.reduce((s,x,i)=>s+x*axis[i],0);
            const cross=[axis[1]*v[2]-axis[2]*v[1],axis[2]*v[0]-axis[0]*v[2],axis[0]*v[1]-axis[1]*v[0]];
            return v.map((x,i)=>x*cs-cross[i]*sn+axis[i]*dot*(1-cs));
        }
        case 'place2d': {
            let uv = zip(a.texcoord, a.pivot, (x, y) => x - y);
            const rotate = (p: Numeric) => { const angle = a.rotate[0] * Math.PI / 180, s = Math.sin(angle), c = Math.cos(angle); return [c * p[0] - s * p[1], s * p[0] + c * p[1]]; };
            if (a.operationorder[0] === 0)
                uv = zip(rotate(zip(uv, a.scale, (x, y) => x / y)), a.offset, (x, y) => x - y);
            else
                uv = zip(rotate(zip(uv, a.offset, (x, y) => x - y)), a.scale, (x, y) => x / y);
            return zip(uv, a.pivot, (x, y) => x + y);
        }
        case 'normalmap': {
            const decoded = v.every(x => x === 0) ? [0, 0, 1] : v.map(x => x * 2 - 1);
            const scale = a.scale.length === 1 ? [a.scale[0], a.scale[0]] : a.scale;
            return normalize(a.normal.map((n, i) => a.tangent[i] * decoded[0] * scale[0] + a.bitangent[i] * decoded[1] * scale[1] + n * decoded[2]));
        }
        case 'convert': {
            const n = width(type);
            if (type === 'boolean')
                return [v[0] !== 0 ? 1 : 0];
            if (type === 'integer')
                return [Math.trunc(v[0])];
            if (v.length === 1)
                return Array(n).fill(v[0]);
            return Array.from({ length: n }, (_, i) => v[i] ?? (i === 3 ? 1 : 0));
        }
        case 'add': return zip(first, second, (x, y) => x + y);
        case 'subtract': return zip(first, second, (x, y) => x - y);
        case 'multiply': return zip(first, second, (x, y) => x * y);
        case 'divide': return zip(first, second, (x, y) => x / y);
        case 'modulo': return zip(first, second, (x, y) => x - y * Math.floor(x / y));
        case 'power': return zip(first, second, (x, y) => Math.pow(x, y));
        case 'min': return zip(first, second, Math.min);
        case 'max': return zip(first, second, Math.max);
        case 'mix': return zip(zip(a.fg, a.bg, (x, y) => x - y), a.mix, (x, y) => x * y).map((x, i) => x + a.bg[i % a.bg.length]);
        case 'clamp': return zip(zip(v, a.low, Math.max), a.high, Math.min);
        case 'ifgreater': return a.value1[0] > a.value2[0] ? a.in1 : a.in2;
        case 'ifequal': return a.value1[0] === a.value2[0] ? a.in1 : a.in2;
        case 'separate2':
        case 'separate3':
        case 'separate4': return v;
        case 'combine2':
        case 'combine3':
        case 'combine4': return Array.from({ length: width(type) }, (_, i) => a[`in${i + 1}`][0]);
        case 'dotproduct': return [zip(first, second, (x, y) => x * y).reduce((s, x) => s + x, 0)];
        case 'crossproduct': return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
        // MaterialX 1.39.4 stdlib_ng.mtlx NG_hsvadjust_color3/4:
        // add hue, scale saturation/value, and retain alpha unchanged.
        case 'hsvadjust': {
            const hsv=evaluateNumericNode('rgbtohsv',type,{in:v});
            hsv[0]+=a.amount[0];hsv[1]*=a.amount[1];hsv[2]*=a.amount[2];
            return evaluateNumericNode('hsvtorgb',type,{in:hsv});
        }
        case 'hsvtorgb': {
            const alpha=width(type)===4?[v[3]]:[];
            if (v[1] < 0.0001)
                return [v[2], v[2], v[2],...alpha];
            const hue = v[0] - Math.floor(v[0]);
            return [0, 4, 2].map(offset => {
                const wave = Math.abs(((hue * 6 + offset) % 6) - 3) - 1;
                return v[2] * (1 - v[1] + v[1] * Math.max(0, Math.min(1, wave)));
            }).concat(alpha);
        }
        case 'rgbtohsv': {
            const alpha=width(type)===4?[v[3]]:[];
            const high = Math.max(...v.slice(0,3)), low = Math.min(...v.slice(0,3)), delta = high - low, saturation = high > 0 ? delta / high : 0;
            if (saturation <= 0)
                return [0, saturation, high,...alpha];
            const index = v.indexOf(high), channels = [(v[1] - v[2]) / delta, 2 + (v[2] - v[0]) / delta, 4 + (v[0] - v[1]) / delta];
            const hue = channels[index] / 6;
            return [hue < 0 ? hue + 1 : hue, saturation, high,...alpha];
        }
        case 'normalize': return normalize(v);
        default: {
            switch(c) {
                case 'abs': return v.map(x => Math.abs(x));
                case 'floor': return v.map(x => Math.floor(x));
                case 'ceil': return v.map(x => Math.ceil(x));
                case 'round': return v.map(x => roundEven(x));
                case 'tan': return v.map(x => Math.tan(x));
                case 'asin': return v.map(x => Math.asin(x));
                case 'acos': return v.map(x => Math.acos(x));
                case 'sin': return v.map(x => Math.sin(x));
                case 'cos': return v.map(x => Math.cos(x));
                case 'sqrt': return v.map(x => Math.sqrt(x));
                case 'exp': return v.map(x => Math.exp(x));
                case 'ln': return v.map(x => Math.log(x));
                case 'sign': return v.map(x => Math.sign(x));
            }
            throw new Error(`Cannot evaluate ${c}`);
        }
    }
}