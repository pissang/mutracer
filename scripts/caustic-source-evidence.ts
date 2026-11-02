import {registerMnee} from '../src/research/mnee/index.js';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import rayTrace from '../src/renderer/wgsl/rayTrace.compute.js';
import fragment from '../src/renderer/glsl/rayTrace.frag.js';
import {causticLightCompute} from '../src/renderer/wgsl/causticLight.compute.js';
// Run with node_modules/.bin/vite-node; evidence belongs outside the checkout.
const output = process.env.MUTRACER_SOURCE_EVIDENCE ?? process.argv[2];
if (!output) throw Error('Provide an output directory or set MUTRACER_SOURCE_EVIDENCE.');
const out = resolve(output); mkdirSync(out, {recursive: true});
const constants = {NUM_MAPS:1, NUM_UNIFORM_LIGHTS:1, TLAS_STACK_SIZE:8, BLAS_STACK_SIZE:32};
for (const mode of ['lightTracing', 'photonMapping'] as const) writeFileSync(resolve(out, `${mode}.wgsl`), causticLightCompute(constants,1,false,mode));
for (const [name, options] of Object.entries({off:{}, light:{lightTracing:true}, photon:{photonMapping:true}, combined:{lightTracing:true,photonMapping:true}, newton:{mnee:true}, sms:{mnee:true,mneeMethod:'sms' as const}})) {
  if(name==='newton')registerMnee();
  writeFileSync(resolve(out, `${name}.wgsl`), rayTrace({hasDisplacement:false,...options}));
}
writeFileSync(resolve(out, 'off.glsl'), fragment().main);
writeFileSync(resolve(out, 'newton.glsl'), fragment(true).main);
writeFileSync(resolve(out, 'sms.glsl'), fragment(true,-1,'sms').main);
