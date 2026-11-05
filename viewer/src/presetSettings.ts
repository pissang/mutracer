import type {Settings} from './store';
/** Stage and lighting choices a collection example stores with its curated view. */
export const STAGE_FIELDS=['lighting','envId','envRotation','background'] as const;
export type PresetStage=Pick<Settings,typeof STAGE_FIELDS[number]>;
type PresetFields=Pick<Settings,'groundShadow'|'caustics'|'causticLightTracing'|'causticPhotonMapping'|'bounces'>;
/** Display settings stay the viewer's own unless an example stores a look. */
const DISPLAY_FIELDS=['toneMapping','exposure','bloomIntensity','bloomThreshold','bloomRadius'] as const;
export type PresetRenderSettings=PresetFields&Pick<Settings,typeof DISPLAY_FIELDS[number]>;
/**
 * Settings applied when a scene loads.
 * Research scenes turn off the ground shadow and
 * Cornell Caustic turns on light tracing and photon mapping. Other first views restore the defaults so a
 * scene-specific choice does not carry over; a reopened scene with a saved view keeps stored and URL settings.
 */
export function presetSettings(presetId:string|null,research:boolean,restored:boolean,defaults:PresetFields,url:Partial<PresetRenderSettings>={},scene:Partial<PresetRenderSettings>={}):Partial<PresetRenderSettings>|undefined {
 const fresh=presetId!==null&&!restored;
 const patch:Partial<PresetRenderSettings>={
  ...(research?{groundShadow:false}:fresh?{groundShadow:defaults.groundShadow}:{}),
  ...(presetId==='research-cornell-caustic'?{caustics:true,causticLightTracing:true,causticPhotonMapping:true}
   :fresh?{caustics:defaults.caustics,causticLightTracing:defaults.causticLightTracing,causticPhotonMapping:defaults.causticPhotonMapping}:{}),
  ...(fresh?{bounces:defaults.bounces,...scene}:{})
 };
 // Only an incoming URL may override a preset. The caller consumes it after
 // the initial load, so switching away still restores the usual scene defaults.
 for(const key of Object.keys(patch) as (keyof PresetRenderSettings)[]) {
  if(url[key]!==undefined)Object.assign(patch,{[key]:url[key]});
 }
 return Object.keys(patch).length?patch:undefined;
}

/** Default display settings when leaving an example whose stored look the next scene does not replace. */
export function leavingDisplaySettings(previous:Partial<PresetRenderSettings>|undefined,next:Partial<PresetRenderSettings>|undefined,defaults:Pick<Settings,typeof DISPLAY_FIELDS[number]>) {
 const fields=DISPLAY_FIELDS.filter((key)=>previous?.[key]!==undefined&&next?.[key]===undefined);
 return Object.fromEntries(fields.map((key)=>[key,defaults[key]])) as Partial<PresetRenderSettings>;
}

/**
 * Stage settings for a first view of a built-in scene: its own stage, or the defaults so that the
 * previous example's stage does not carry over. An incoming URL wins.
 */
export function presetStageSettings(stage:PresetStage|undefined,defaults:PresetStage,url:Partial<PresetStage>={}):PresetStage {
 return Object.fromEntries(STAGE_FIELDS.map((key)=>[key,url[key]??stage?.[key]??defaults[key]])) as PresetStage;
}
