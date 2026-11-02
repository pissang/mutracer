// Mirror the production AgX display transform, including its column-major matrices.
export function displayLinear(image) {
 const matrix=(columns,v)=>[0,1,2].map(i=>columns[0][i]*v[0]+columns[1][i]*v[1]+columns[2][i]*v[2]);
 const data=new Float32Array(image.data);
 const rec=[[.6274,.0691,.0164],[.3293,.9195,.088],[.0433,.0113,.8956]];
 const inset=[[.856627153315983,.137318972929847,.11189821299995],[.0951212405381588,.761241990602591,.0767994186031903],[.0482516061458583,.101439036467562,.811302368396859]];
 const outset=[[1.1271005818144368,-.1413297634984383,-.14132976349843826],[-.11060664309660323,1.157823702216272,-.11060664309660294],[-.016493938717834573,-.016493938717834257,1.2519364065950405]];
 const srgb=[[1.6605,-.1246,-.0182],[-.5876,1.1329,-.1006],[-.0728,-.0083,1.1187]];
 for(let i=0;i<data.length;i+=4){
  let v=matrix(inset,matrix(rec,Array.from(data.subarray(i,i+3),x=>Math.max(0,x))));
  v=v.map(x=>Math.min(1,Math.max(0,(Math.log2(Math.max(x,1e-10))+12.47393)/16.5)));
  v=v.map(x=>15.5*x**6-40.14*x**5+31.96*x**4-6.868*x**3+.4298*x*x+.1191*x-.00232);
  v=matrix(srgb,matrix(outset,v).map(x=>Math.max(0,x)**2.2));
  data.set(v.map(x=>Math.min(1,Math.max(0,x))),i);
 }
 return {...image,data};
}

