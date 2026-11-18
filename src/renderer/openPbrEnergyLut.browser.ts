export * from './decodeOpenPbrEnergyLut.js';

let decoded: Float32Array | undefined;
let pending: Promise<void> | undefined;

/** Share the table across engines and load it alongside device initialization. */
export function initOpenPbrEnergyLut(): Promise<void> {
  return pending ??= import('./openPbrEnergyLut.js').then(module => {
    decoded = module.getOpenPbrEnergyLutData();
  }).catch(cause => {
    pending = undefined;
    throw new Error(`OpenPBR energy table loading failed: ${cause instanceof Error ? cause.message : String(cause)}`, {cause});
  });
}

/** Device initialization must finish before constructing either backend. */
export function getOpenPbrEnergyLutData(): Float32Array {
  if (!decoded) throw new Error('OpenPBR energy table is not initialized.');
  return decoded;
}
