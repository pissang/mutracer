/** Internal shader instrumentation. A nonnegative group replaces beauty RGB with three MNEE counters. */
const diagnosticsKey=Symbol.for('mutracer.internal.causticDiagnostics');
interface CausticDiagnostics {
 /** Paused manifold estimators. Internal probes only; restart after changes. */
 mnee?: boolean | {method?: 'newton' | 'sms'};
 mneeDebugGroup:number;
 /** Internal A/B controls; set before rendering and restart accumulation. */
 mneeSeeds?:number;
 mneeDamping?:boolean;
 smsRoulette?:boolean;
 mneeMaxDepth?:number;
 captureRoots?:boolean;
 rootPass?:unknown;
 photonAlpha?:number;
 /** Fixed progressive batch for isolated query counters. */
 photonDebugBatch?:number;
 photonBudgetBytes?:number;
 photonScreenRadius?:boolean;
 photonScreenPixels?:number;
 photonSkipQuery?:boolean;
 photonSkipVisible?:boolean;
 photonMaxDepth?:number;
 fullEmissionRandom?:boolean;
 aggregateCasters?:boolean;
 capturePhotons?:boolean;
 photonBatch?:{device:GPUDevice;data:GPUTexture;emitted:number;packed?:boolean};
}
const diagnosticsScope=globalThis as typeof globalThis & Record<symbol,CausticDiagnostics|undefined>;
export const causticDiagnostics=diagnosticsScope[diagnosticsKey]??=( {mneeDebugGroup:-1} );
