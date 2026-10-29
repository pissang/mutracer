import {registerResearchTransport, type ResearchPassState} from '../../renderer/researchTransport.js';
import {createMneeWgsl} from './mnee.wgsl.js';
import {createMneeGlsl} from './mnee.glsl.js';
import {createCausticPartitionGlsl} from './partition.glsl.js';
import {glslFragments} from './glslFragments.js';
import {prepareResearch} from './hostPreparation.js';
import {isCausticSpecular} from '../../renderer/caustics.js';
import createFragment from '../../renderer/glsl/rayTrace.frag.js';

export interface MneeOptions {
  mnee?: boolean;
  mneeDebugGroup?: number;
  mneeSeeds?: number;
  mneeDamping?: boolean;
  smsRoulette?: boolean;
  mneeMaxDepth?: number;
  mneeMethod?: 'newton' | 'sms';
  mneeHardwareIndices?: boolean;
}
declare module '../../renderer/wgpuShaderSource.js' { interface WGPUShaderFeatures extends MneeOptions {} }
declare module '../../renderer/wgsl/rayTrace.compute.js' { interface RayTraceShaderOptions extends MneeOptions {} }
declare module '../../renderer/causticUniform.js' { interface CausticLightUniformOptions {mnee?: boolean} }
export const mneeDiagnostics: Omit<MneeOptions, 'mnee'> & {
  mnee?: boolean | {method?: 'newton' | 'sms'};
  captureRoots?: boolean;
  rootPass?: unknown;
} = {mneeDebugGroup: -1};
// MNEE probe settings deliberately stay outside ordinary caustic diagnostics.
interface State extends ResearchPassState {seeds?: unknown; cache?: unknown; texture?: any}
const states = new WeakMap<object, State>();
function stateFor(pass: object): State {
  let state = states.get(pass);
  if (!state) {state = {enabled:false, key:'', workgroupSize:8, debugGroup:-1, features:{}, uniform:{}}; states.set(pass,state);}
  return state;
}
/** Register before creating renders. No published entry point imports this module. */
export function registerMnee(): void {
  registerResearchTransport({
    compute(options) {
      const o = options as MneeOptions & {debugGroup?:number};
      const enabled = !!o.mnee, debugGroup = o.mneeDebugGroup ?? o.debugGroup ?? -1, maxDepth = o.mneeMaxDepth ?? 20;
      return {enabled, debugGroup, maxDepth,
        declarations: enabled ? createMneeWgsl(debugGroup>=0,o.mneeMethod==='sms',o.mneeHardwareIndices,o.mneeSeeds??4,!!o.mneeDamping,maxDepth,!!o.smsRoulette) : '',
        contribution: enabled ? /* wgsl */ `  if (!mediumSampled) { let value=(*path).beta*mneeContribution(*si,prepared);causticEstimateRecord(value,0u);(*path).li+=value; }
` : '',
        debugOutput: debugGroup>=10 ? `vec4f(mneeTrace[${debugGroup-10}]+vec3f(10.0),1.0)` : `vec4f(f32(mneeCounters[${debugGroup*3}]),f32(mneeCounters[${debugGroup*3+1}]),f32(mneeCounters[${debugGroup*3+2}]),1.0)`};
    },
    fragment(options) {
      const enabled = !!options[0], debugGroup = Number(options[1]??-1), method=options[2]??'newton';
      const seeds=Number(options[3]??4), damping=!!options[4], maxDepth=Number(options[5]??20), roulette=!!options[6];
      const mixin=enabled?createMneeGlsl(debugGroup>=0,method==='sms',seeds,damping,maxDepth,roulette):undefined;
      return {enabled,debugGroup,maxDepth,contribution:'',mixin,
        declarations:enabled?createCausticPartitionGlsl(maxDepth,debugGroup>=30)+mixin!.main:'',
        fragments:enabled?{...glslFragments, debugInit:debugGroup>=0?'  for(int i=0;i<21;i++)mneeCounters[i]=0.0;for(int i=0;i<10;i++)mneeTrace[i]=vec3(0.0);for(int i=0;i<15;i++)causticHot[i]=vec3(0.0);\n':''}:undefined,
        debugOutput:enabled&&debugGroup>=0?(debugGroup>=30?`vec4(causticHot[${debugGroup-30}],1.0)`:debugGroup>=10?`vec4(mneeTrace[${debugGroup-10}]+vec3(10.0),1.0)`:`vec4(mneeCounters[${debugGroup*3}],mneeCounters[${debugGroup*3+1}],mneeCounters[${debugGroup*3+2}],1.0)`):''};
    },
    constants(constants,features) {return (features as MneeOptions).mnee?{CAUSTIC_SEED_COUNT:0,CAUSTIC_SEED_OFFSET:0,...constants}:constants;},
    configure(object,backend) {
      // The adapter owns all experimental fields; private renderer layouts stay unchanged.
      const pass=object as any, state=stateFor(pass), d=mneeDiagnostics;
      const enabled=!!d.mnee&&pass._meshes.some((mesh:any)=>mesh.materials.some(isCausticSpecular));
      const method=typeof d.mnee==='object'?d.mnee.method??'newton':'newton';
      const depth=d.mneeMaxDepth??(backend==='webgl'?2:20), debug=d.mneeDebugGroup??-1;
      const key=enabled?`${method}/${debug}/${d.mneeSeeds??4}/${!!d.mneeDamping}/${!!d.smsRoulette}/${depth}`:'';
      const changed=state.enabled!==enabled||state.key!==key;
      state.enabled=enabled;state.key=key;state.debugGroup=debug;state.workgroupSize=enabled?1:8;
      state.features={mnee:enabled,mneeMethod:method,mneeDebugGroup:debug>=0?debug:undefined,mneeSeeds:d.mneeSeeds??4,mneeDamping:!!d.mneeDamping,smsRoulette:!!d.smsRoulette,mneeMaxDepth:depth};
      state.uniform={mnee:enabled};
      if(backend==='webgl'&&changed){const shader=createFragment(enabled,debug,method,d.mneeSeeds??4,!!d.mneeDamping,depth,!!d.smsRoulette);shader.parallelCompile=true;pass._mainPass.setShader(shader);}
      return {...state};
    },
    prepare(pass,backend,lighting) {prepareResearch(pass,stateFor(pass),backend,lighting);},
    capture(pass) {if(mneeDiagnostics.captureRoots)mneeDiagnostics.rootPass=pass;},
    dispose(pass,backend) {const state=states.get(pass);if(backend==='webgl')state?.texture?.dispose((pass as any)._renderer.gl);states.delete(pass);},
    packUniform(data,options) {new Uint32Array(data)[22]=+!!(options as MneeOptions).mnee;},
    lightSource(source) {return source.replaceAll('reservedTransport','mnee').replaceAll('directSource','mneeSource');}
  });
}
