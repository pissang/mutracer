import type {Settings} from './store';
type PresetFields=Pick<Settings,'groundShadow'|'caustics'|'causticLightTracing'|'causticPhotonMapping'>;
/**
 * Settings applied when a built-in scene loads. Research scenes turn off the ground shadow and
 * Cornell Caustic turns on photon mapping. Other fresh preset loads restore the defaults so a
 * scene-specific choice does not carry over; restored loads keep stored and URL settings.
 */
export function presetSettings(presetId:string|null,research:boolean,restored:boolean,defaults:PresetFields):Partial<PresetFields>|undefined {
 const fresh=presetId!==null&&!restored;
 const patch:Partial<PresetFields>={
  ...(research?{groundShadow:false}:fresh?{groundShadow:defaults.groundShadow}:{}),
  ...(presetId==='research-cornell-caustic'?{caustics:true,causticLightTracing:false,causticPhotonMapping:true}
   :fresh?{caustics:defaults.caustics,causticLightTracing:defaults.causticLightTracing,causticPhotonMapping:defaults.causticPhotonMapping}:{})
 };
 return Object.keys(patch).length?patch:undefined;
}
