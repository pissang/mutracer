/** Internal shader instrumentation. A nonnegative group replaces beauty RGB with three transport counters. */
const diagnosticsKey=Symbol.for('mutracer.internal.causticDiagnostics');
interface CausticDiagnostics {
 debugGroup:number;
 photonAlpha?:number;
 photonRadiusScaling?: import('./wgsl/photonMap.compute.js').PhotonRadiusScaling;
 /** Fixed progressive batch for isolated query counters. */
 photonDebugBatch?:number;
 photonBudgetBytes?:number;
 photonScreenRadius?:boolean;
 photonScreenPixels?:number;
 /** Visible-radius and density experiments are opt-in; public defaults stay fixed. */
 photonProgressiveScreenRadius?:boolean;
 photonScreenMinimum?:number;
 photonCountDivisor?:number;
 /** Scale experiments; off by default and excluded from public settings. */
 photonPerCasterRadius?:boolean;
 causticViewImportance?:boolean;
 photonDeepScreenPixels?:number;
 photonSkipQuery?:boolean;
 photonSkipVisible?:boolean;
 photonMaxDepth?:number;
 fullEmissionRandom?:boolean;
 aggregateCasters?:boolean;
 capturePhotons?:boolean;
 photonBatch?:{device:GPUDevice;data:GPUTexture;emitted:number;packed?:boolean};
}
const diagnosticsScope=globalThis as typeof globalThis & Record<symbol,CausticDiagnostics|undefined>;
export const causticDiagnostics=diagnosticsScope[diagnosticsKey]??=( {debugGroup:-1} );
