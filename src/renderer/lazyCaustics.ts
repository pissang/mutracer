import type * as Runtime from './WGPUCaustics.js';
let runtime: typeof Runtime | undefined;
let pending: Promise<typeof Runtime> | undefined;
export const getCausticsRuntime = () => runtime;
export function loadCausticsRuntime() {
  return pending ??= import('./WGPUCaustics.js').then(module => runtime = module).catch(cause => {
    pending = undefined;
    throw new Error('Failed to load the WebGPU caustics renderer.', {cause});
  });
}
