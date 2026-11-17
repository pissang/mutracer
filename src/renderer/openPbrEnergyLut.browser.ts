// Browser loader for the energy table asset. Native/AOT code keeps the synchronous
// table in openPbrEnergyLut.ts; scripts/pack-openpbr-energy-lut.mjs writes the asset.
import {decodeOpenPbrEnergyLut} from './decodeOpenPbrEnergyLut.js';
export * from './decodeOpenPbrEnergyLut.js';
const DIRECTIONAL_BYTES = 77184;
const TOTAL_BYTES = DIRECTIONAL_BYTES + 2112;
let decoded: Float32Array | undefined;
let pending: Promise<void> | undefined;

function latin1(bytes: Uint8Array) {
  let text = '';
  // Bounded chunks stay below engine argument limits.
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

/** Preload during device initialization; repeated calls share loading and decoding. */
export function initOpenPbrEnergyLut(): Promise<void> {
  return pending ??= (async () => {
    const url = new URL('./openPbrEnergyLut.bin', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== TOTAL_BYTES) throw new Error(`expected ${TOTAL_BYTES} bytes, got ${bytes.length}`);
    const text = latin1(bytes);
    decoded = decodeOpenPbrEnergyLut(text.slice(0, DIRECTIONAL_BYTES), text.slice(DIRECTIONAL_BYTES));
  })().catch(cause => {
    pending = undefined;
    throw new Error(`OpenPBR energy table loading failed: ${cause instanceof Error ? cause.message : String(cause)}`, {cause});
  });
}

/** Device initialization must finish before constructing either backend. */
export function getOpenPbrEnergyLutData(): Float32Array {
  if (!decoded) throw new Error('OpenPBR energy table is not initialized.');
  return decoded;
}
