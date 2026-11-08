// Adapted from MaterialX v1.39.4 libraries/stdlib/genglsl/lib/mx_noise.glsl:
// https://github.com/AcademySoftwareFoundation/MaterialX/blob/v1.39.4/libraries/stdlib/genglsl/lib/mx_noise.glsl
// OSL noise, Copyright (c) 2009-2010 Sony Pictures Imageworks Inc., et al.
// See LICENSES/MaterialX-OSL-BSD-3-Clause.txt and THIRD_PARTY_NOTICES.md.
const rot = (x:number,k:number) => (x<<k)|(x>>>(32-k));
export function noiseHash(p:number[]) {
    const seed=(0xdeadbeef+(p.length<<2)+13)>>>0;
    let a=(seed+p[0])>>>0, b=(seed+(p[1]??0))>>>0, c=(seed+(p[2]??0))>>>0;
    if(p.length>3){
        a=(a-c)^rot(c,4);c=(c+b)>>>0;
        b=(b-a)^rot(a,6);a=(a+c)>>>0;
        c=(c-b)^rot(b,8);b=(b+a)>>>0;
        a=(a-c)^rot(c,16);c=(c+b)>>>0;
        b=(b-a)^rot(a,19);a=(a+c)>>>0;
        c=(c-b)^rot(b,4);b=(b+a)>>>0;
        a=(a+p[3])>>>0;b=(b+(p[4]??0))>>>0;
    }
    c=(c^b)-rot(b,14);a=(a^c)-rot(c,11);b=(b^a)-rot(a,25);
    c=(c^b)-rot(b,16);a=(a^c)-rot(c,4);b=(b^a)-rot(a,14);c=(c^b)-rot(b,24);
    return c>>>0;
}
const cell = (p:number[]) => noiseHash(p.map(Math.floor))/0xffffffff;
const cellVector = (p:number[]) => [0,1,2].map(i=>cell([...p,i]));
function gradient(hash:number,p:number[]) {
    const h=hash&(p.length===2?7:15),u=p[h<(p.length===2?4:8)?0:1];
    const v=p.length===2 ? 2*p[h<4?1:0] : h<4 ? p[1] : h===12||h===14 ? p[0] : p[2];
    return (h&1?-u:u)+(h&2?-v:v);
}
function perlin(p:number[],channel=-1) {
    const base=p.map(Math.floor), f=p.map((x,i)=>x-base[i]);
    const fade=f.map(t=>t*t*t*(t*(t*6-15)+10));
    const values=Array.from({length:1<<p.length},(_,corner)=>{
        const offset=p.map((_,i)=>(corner>>i)&1);
        let h=noiseHash(base.map((x,i)=>x+offset[i]));
        if(channel>=0)h=(h>>>(8*channel))&255;
        return gradient(h,f.map((x,i)=>x-offset[i]));
    });
    for(const t of fade)for(let i=0;i<values.length/2;i++)values[i]=values[i*2]*(1-t)+values[i*2+1]*t;
    return values[0]*(p.length===2?0.6616:0.982);
}
const noise = (p:number[],n:number,fractal=false) => n===1 ? [perlin(p)] : n===2 && fractal ? [perlin(p),perlin(p.map((x,i)=>Math.fround(x+[19,193,17][i])))] : [...[0,1,2].slice(0,n).map(i=>perlin(p,i)),...(n===4?[perlin(p.map((x,i)=>Math.fround(x+(fractal?[19,193,17]:[19,73,29])[i])))]:[])];
export function evaluateNoise(category:string,p:number[],n:number,a:Record<string,number[]>) {
    p=p.map(Math.fround);
    if(category.startsWith('cellnoise'))return [cell(p)];
    if(category.startsWith('worley')){
        const base=p.map(Math.floor), local=p.map((x,i)=>x-base[i]), nearest=Array(n).fill(1e6);
        let minpos=Array(p.length).fill(0);
        for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=p.length===3?-1:0;z<=(p.length===3?1:0);z++){
            const off=[x,y,z].slice(0,p.length), cp=cellVector(base.map((x,i)=>x+off[i])).slice(0,p.length).map((x,i)=>off[i]+(x-0.5)*a.jitter[0]+0.5-local[i]);
            const d=cp.reduce((s,x)=>s+x*x,0);
            if(d<nearest[0])minpos=cp;
            for(let i=0;i<n;i++)if(d<nearest[i]){nearest.splice(i,0,d);nearest.length=n;break;}
        }
        if(a.style[0]===1){const pos=p.map((x,i)=>x+minpos[i]);return n===1?[cell(pos)]:cellVector(pos).slice(0,n);}
        return nearest.map(Math.sqrt);
    }
    let result=Array(n).fill(0), amplitude=1, position=p.slice();
    const fractal=category==='fractal3d', octaves=fractal?a.octaves[0]:1;
    for(let octave=0;octave<octaves;octave++){
        const value=noise(position,n,fractal);
        if(fractal && (n===2||n===4)){const shifted=p.map((x,i)=>Math.fround(Math.fround(x+[19,193,17][i])*Math.pow(a.lacunarity[0],octave)));value[n-1]=perlin(shifted);}
        result=result.map((x,i)=>x+amplitude*value[i]);
        if(fractal){amplitude*=a.diminish[0];position=position.map(x=>Math.fround(x*a.lacunarity[0]));}
    }
    return result.map((x,i)=>x*a.amplitude[i%a.amplitude.length]+(fractal?0:a.pivot[0]));
}
