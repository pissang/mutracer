import type {CausticSettings} from '@meimu/mutracer';
import type {Settings} from './store';
type CausticFields=Pick<Settings,'caustics'|'causticLightTracing'|'causticPhotonMapping'>;
/** The same estimator choices drive preview, export and generated code. */
export function causticOptions(s:CausticFields):CausticSettings|undefined {
 return s.caustics?{lightTracing:s.causticLightTracing,photonMapping:s.causticPhotonMapping}:undefined;
}
/**
 * Caustic settings applied when a built-in scene loads. Cornell Caustic turns on photon mapping;
 * other fresh preset loads restore the defaults so the scene-specific choice does not carry over.
 * Restored loads keep stored and URL settings.
 */
export function presetCaustics(presetId:string|null,restored:boolean,defaults:CausticFields):CausticFields|undefined {
 if(presetId==='research-cornell-caustic')return {caustics:true,causticLightTracing:false,causticPhotonMapping:true};
 if(presetId===null||restored)return undefined;
 const {caustics,causticLightTracing,causticPhotonMapping}=defaults;
 return {caustics,causticLightTracing,causticPhotonMapping};
}
