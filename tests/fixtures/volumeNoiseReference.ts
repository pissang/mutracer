// Independent CPU reference used only by tests and external integration evidence.
export function volumeHash(cell: readonly number[]) {
  const v = cell.map(x => (Math.imul(x | 0,1664525)+1013904223)>>>0);
  const mix=()=>{v[0]=(v[0]+Math.imul(v[1],v[2]))>>>0;v[1]=(v[1]+Math.imul(v[2],v[0]))>>>0;v[2]=(v[2]+Math.imul(v[0],v[1]))>>>0;};
  mix();for(let i=0;i<3;i++)v[i]=(v[i]^(v[i]>>>16))>>>0;mix();return v[0];
}
export function gradientNoise(p: readonly number[]) {
  const cell=p.map(Math.floor),f=p.map((x,i)=>x-cell[i]),w=f.map(x=>x*x*x*(x*(x*6-15)+10));
  let sum=0;
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){
    const c=[x,y,z],d=f.map((a,i)=>a-c[i]),h=volumeHash(cell.map((a,i)=>a+c[i]))&15;
    const a=h<8?d[0]:d[1],b=h<4?d[1]:h===12||h===14?d[0]:d[2];
    sum+=c.reduce((v,n,i)=>v*(n?w[i]:1-w[i]),1)*((h&1?-a:a)+(h&2?-b:b));
  }
  return sum;
}
export function volumeFbm(p: readonly number[],octaves=4) {
  let sum=0,weight=0,amplitude=1;
  for(let i=0;i<octaves;i++){sum+=amplitude*gradientNoise(p.map(x=>x*2**i));weight+=amplitude;amplitude*=.5;}
  return Math.max(0,Math.min(1,.5+.5*sum/weight));
}
export function noiseMask(p: readonly number[],size: readonly number[],offset: readonly number[]=[0,0,0],coverage=.5,softness=.3,octaves=4,warp=0){
  const original=p.map((x,i)=>(x+offset[i])/size[i]);
  const q=warp>0?warpPosition(original,warp):original;
  return volumeNoiseThreshold(volumeFbm(q,octaves),coverage,softness);
}
export function volumeNoiseThreshold(f: number, coverage: number, softness: number) {
  const center=Math.fround(1-Math.fround(coverage)),half=Math.fround(Math.fround(softness)*.5);
  const low=Math.fround(center-half),high=Math.fround(center+half);
  if(low>=high)return +(f>=center);
  const t=Math.max(0,Math.min(1,(f-low)/(high-low)));return t*t*(3-2*t);
}
export const noiseVectors = [[0,0,0],[.25,.5,.75],[-.25,-2.5,3.75],[1.125,-.875,.0625],[31.5,16.25,-63.75],[1000.125,-200.5,.25]];

// Coordinates are rounded at the same world-to-noise and domain-offset steps as the GPU.
export function warpPosition(position: readonly number[], warp: number, layers=2) {
  const q=position.map(Math.fround);
  const shifts=[[17.25,3.5,29.75],[41.5,59.25,7.125],[73.75,11.125,97.5]];
  return q.map((v,i)=>Math.fround(v+warp*Math.fround(2*volumeFbm(q.map((x,j)=>Math.fround(x+shifts[i][j])),layers)-1)));
}
