import {computeGeometryBounds} from './geometryBvhBounds.js';
import type Geometry from '../scene/Geometry.js';
import {matrixStorage} from '../math/storage.js';
import {read,write} from '../math/access.js';
import type Mesh from '../scene/MeshState.js';
import {meshInstanceCount,meshInstanceTransform} from './meshInstances.js';
import {mat4,vec3} from '../math.js';
import type OpenPBRMaterial from '../scene/MaterialState.js';
import {resolveMaterialAlphaMode} from '../scene/MaterialState.js';

export const CAUSTIC_ROUGHNESS_MAX = 0.1;
/** Material-only classification, shared by caster collection and GPU estimators. */
export function isCausticSpecular(m: Pick<OpenPBRMaterial, 'baseWeight' | 'baseMetalness' | 'transmissionWeight' | 'subsurfaceWeight' | 'fuzzWeight' | 'coatWeight' | 'specularRoughness'>) {
  return m.baseWeight * (1 - m.baseMetalness) * (1 - m.transmissionWeight) <= 1e-6 &&
    m.subsurfaceWeight <= 0 && m.fuzzWeight <= 0 && m.coatWeight <= 0 && m.specularRoughness <= CAUSTIC_ROUGHNESS_MAX;
}

export type CasterSphere = [number,number,number,number];
const casterBounds=new WeakMap<Geometry,{version:number;positions:Float32Array;bounds:[Float64Array,Float64Array]}>();
function localCasterBounds(geometry:Geometry){
 const cached=casterBounds.get(geometry),positions=geometry.position.array;
 if(cached&&cached.version===geometry.version&&cached.positions===positions)return cached.bounds;
 const value=computeGeometryBounds(geometry),bounds:[Float64Array,Float64Array]=[matrixStorage(value[0]),matrixStorage(value[1])];
 casterBounds.set(geometry,{version:geometry.version,positions,bounds});return bounds;
}
/** One conservative world-space sphere per smooth mesh instance. */
export function causticCasterSpheres(meshes: readonly Mesh[]): CasterSphere[] {
  const spheres:CasterSphere[]=[];
  const matrix=mat4.create(),point=vec3.create();
  for(const mesh of meshes) {
    if(!mesh.materials.some(isCausticSpecular))continue;
    // Geometry.boundingBox is optional caller metadata and starts at zero.
    // Caster collection must also work for a raw public Geometry descriptor.
    const bounds=localCasterBounds(mesh.geometry),minCorner=bounds[0],maxCorner=bounds[1];
    if(!Number.isFinite(minCorner[0])||!Number.isFinite(maxCorner[0]))continue;
    let expansion=0;
    for(const material of mesh.materials)if(isCausticSpecular(material))expansion=Math.max(expansion,
      Math.abs(material.displacementBias)+(material.displacementMap?Math.abs(material.displacementScale):0));
    for(let instance=0;instance<meshInstanceCount(mesh);instance++) {
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      meshInstanceTransform(mesh,instance,matrix);
      for(let corner=0;corner<8;corner++) {
        for(let axis=0;axis<3;axis++)write(point,axis,((corner&(1<<axis))?maxCorner[axis]+expansion:minCorner[axis]-expansion));
        vec3.transformMat4(point,point,matrix);
        for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis],read(point,axis));max[axis]=Math.max(max[axis],read(point,axis));}
      }
      spheres.push([(min[0]+max[0])*.5,(min[1]+max[1])*.5,(min[2]+max[2])*.5,Math.hypot(max[0]-min[0],max[1]-min[1],max[2]-min[2])*.501]);
    }
  }
  return spheres;
}
/** Conservative sphere enclosing the caster mixture. */
export function causticCasterSphere(meshes:readonly Mesh[]):CasterSphere {
  const spheres=causticCasterSpheres(meshes);if(!spheres.length)return [0,0,0,0];
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const s of spheres){const components:number[]=[s[0],s[1],s[2]];for(let i=0;i<3;i++){min[i]=Math.min(min[i],components[i]-s[3]);max[i]=Math.max(max[i],components[i]+s[3]);}}
  const center=min.map((v,i)=>(v+max[i])*.5);
  let radius=0;for(const s of spheres)radius=Math.max(radius,Math.hypot(s[0]-center[0],s[1]-center[1],s[2]-center[2])+s[3]);
  return [center[0],center[1],center[2],radius];
}
/** CPU reference for the solid-angle mixture, including overlapping cones. */
export function casterDirectionPdf(origin:readonly number[],direction:readonly number[],spheres:readonly CasterSphere[],weights:readonly number[]=[]) {
  let total=0,overlaps=0;
  for(const [index,s] of spheres.entries()){const weight=weights[index]??1;const d=Math.hypot(s[0]-origin[0],s[1]-origin[1],s[2]-origin[2]);
    const cosine=d>s[3]?Math.sqrt(Math.max(0,1-(s[3]/d)**2)):-1;
    total+=2*Math.PI*(1-cosine)*weight;
    if(d<=s[3]||((s[0]-origin[0])*direction[0]+(s[1]-origin[1])*direction[1]+(s[2]-origin[2])*direction[2])/d>=cosine)overlaps+=weight;
  }
  return total>0?overlaps/total:0;
}

/** Stochastic smooth coverage currently disagrees with PT energy.
 * Keep those scenes on PT until transport and endpoint weights are verified.
 */
export function hasStochasticCausticCaster(meshes:readonly Mesh[]){
 return meshes.some(mesh=>mesh.materials.some(m=>isCausticSpecular(m)&&resolveMaterialAlphaMode(m)==='blend'));
}
