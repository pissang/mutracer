import {describe,it,expect} from 'vitest';
import * as THREE from 'three';
import {buildProfile,createShaderBall} from '../src/engine/shaderBall';

const meshes=()=>{
  const list:THREE.Mesh[]=[];
  createShaderBall().root.traverse(o=>{if((o as THREE.Mesh).isMesh)list.push(o as THREE.Mesh);});
  return list;
};
const attribute=(mesh:THREE.Mesh,name:string)=>mesh.geometry.getAttribute(name) as THREE.BufferAttribute;

describe('shader ball',()=>{
  it('rounds corners with tangent arcs and exact normals',()=>{
    const profile=buildProfile([{r:0,y:0},{r:1,y:0,fillet:0.1},{r:1,y:1,fillet:0.1},{r:0,y:1}]);
    expect(profile[0]).toMatchObject({r:0,y:0,nr:0,ny:-1});
    expect(profile.at(-1)).toMatchObject({r:0,y:1,nr:0,ny:1});
    for(const p of profile){
      expect(Math.hypot(p.nr,p.ny)).toBeCloseTo(1,12);
      // Inside the corner arcs every point is one fillet radius from the arc's centre.
      if(p.r>0.9&&p.y<0.1)expect(Math.hypot(p.r-0.9,p.y-0.1)).toBeCloseTo(0.1,12);
      if(p.r>0.9&&p.y>0.1&&p.y<0.9)expect([p.r,p.nr,p.ny]).toEqual([1,1,0].map(v=>expect.closeTo(v,12)));
    }
    expect(()=>buildProfile([{r:0,y:0},{r:0.1,y:0,fillet:0.2},{r:0.1,y:1}])).toThrow('Fillet');
  });

  it('assigns the test material to the shell and cradle only',()=>{
    const byName=Object.fromEntries(meshes().map(m=>[m.name,m]));
    expect(Object.keys(byName).sort()).toEqual(['Base','Core','Cradle','Shell']);
    expect(byName.Shell.material).toBe(byName.Cradle.material);
    expect(new Set(Object.values(byName).map(m=>(m.material as THREE.Material).name))).toEqual(new Set(['Material','Core','Base']));
    // Position-based graphs need one object space across the parts.
    for(const mesh of Object.values(byName))expect(mesh.matrix.equals(new THREE.Matrix4())).toBe(true);
  });

  it('stands centred on the ground',()=>{
    const box=new THREE.Box3().setFromObject(createShaderBall().root,true);
    expect(box.min.y).toBe(0);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(0,6);
    expect(box.getCenter(new THREE.Vector3()).z).toBeCloseTo(0,6);
  });

  it('builds closed solids whose faces agree with their smooth normals',()=>{
    for(const mesh of meshes()){
      const position=attribute(mesh,'position'),normal=attribute(mesh,'normal'),uv=attribute(mesh,'uv'),index=mesh.geometry.index!;
      for(const value of [...position.array,...normal.array,...uv.array])expect(Number.isFinite(value)).toBe(true);
      const key=(i:number)=>`${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
      const edges=new Map<string,number>();
      const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),face=new THREE.Vector3(),n=new THREE.Vector3();
      let flipped=0;
      for(let t=0;t<index.count;t+=3){
        const corners=[index.getX(t),index.getX(t+1),index.getX(t+2)];
        a.fromBufferAttribute(position,corners[0]);b.fromBufferAttribute(position,corners[1]);c.fromBufferAttribute(position,corners[2]);
        face.crossVectors(b.sub(a),c.sub(a));
        if(face.length()<1e-14)continue;
        for(const corner of corners)if(face.dot(n.fromBufferAttribute(normal,corner))<=0)flipped++;
        // A closed, consistently wound surface uses every edge once in each direction.
        for(let e=0;e<3;e++){
          const from=key(corners[e]),to=key(corners[(e+1)%3]);
          if(from===to)continue;
          edges.set(`${from}>${to}`,(edges.get(`${from}>${to}`)??0)+1);
          edges.set(`${to}>${from}`,(edges.get(`${to}>${from}`)??0)-1);
        }
      }
      expect(flipped,`${mesh.name} flipped`).toBe(0);
      expect([...edges.values()].filter(v=>v!==0).length,`${mesh.name} open edges`).toBe(0);
    }
  });

  it('keeps the displaced parts dense and the model light',()=>{
    let triangles=0;
    for(const mesh of meshes()){
      triangles+=mesh.geometry.index!.count/3;
      if(mesh.name==='Base')continue;
      const position=attribute(mesh,'position'),normal=attribute(mesh,'normal'),index=mesh.geometry.index!;
      const a=new THREE.Vector3(),b=new THREE.Vector3(),n=new THREE.Vector3(),m=new THREE.Vector3();
      let longest=0;
      for(let t=0;t<index.count;t+=3){
        // The cut faces are flat, upright fans across the wall; every other edge stays short.
        n.fromBufferAttribute(normal,index.getX(t));
        if(n.y===0&&[1,2].every(e=>m.fromBufferAttribute(normal,index.getX(t+e)).equals(n)))continue;
        for(let e=0;e<3;e++){
          a.fromBufferAttribute(position,index.getX(t+e));b.fromBufferAttribute(position,index.getX(t+(e+1)%3));
          longest=Math.max(longest,a.distanceTo(b));
        }
      }
      expect(longest,mesh.name).toBeLessThan(0.045);
    }
    expect(triangles).toBeLessThan(450_000);
  });
});
