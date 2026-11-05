import {expect,it} from 'vitest';
import {leavingDisplaySettings,presetSettings,presetStageSettings,STAGE_FIELDS} from '../src/presetSettings';
import {ENVIRONMENT_PRESETS} from '../src/engine/presets';
import {PUBLIC_MODEL_PRESETS} from '../src/engine/publicModelPresets';
const defaults={groundShadow:true,caustics:false,causticLightTracing:true,causticPhotonMapping:false,bounces:6};
it('keeps research and Cornell settings to their own built-in scenes',()=>{
 const cornell={groundShadow:false,caustics:true,causticLightTracing:true,causticPhotonMapping:true};
 expect(presetSettings('research-cornell-caustic',true,false,defaults)).toEqual({...cornell,bounces:6});
 expect(presetSettings('research-cornell-caustic',true,true,defaults)).toEqual(cornell);
 expect(presetSettings('research-cornell-box',true,false,defaults)).toEqual({...defaults,groundShadow:false});
 expect(presetSettings('research-cornell-box',true,true,defaults)).toEqual({groundShadow:false});
 expect(presetSettings('spheres',false,false,defaults)).toEqual(defaults);
 expect(presetSettings('spheres',false,true,defaults)).toBeUndefined();
 expect(presetSettings(null,false,false,defaults)).toBeUndefined();
});

it('gives only explicit valid link fields precedence over scene defaults',()=>{
 expect(presetSettings('research-cornell-caustic',true,false,defaults,{caustics:false,causticLightTracing:false}))
  .toEqual({groundShadow:false,caustics:false,causticLightTracing:false,causticPhotonMapping:true,bounces:6});
});

it('applies example render choices on fresh loads, preserves restored settings and lets URLs win',()=>{
 const scene={groundShadow:false,caustics:true,causticLightTracing:true,causticPhotonMapping:true,bounces:12};
 expect(presetSettings('crystal-lens',false,false,defaults,{},scene)).toEqual(scene);
 expect(presetSettings('crystal-lens',false,true,defaults,{},scene)).toBeUndefined();
 expect(presetSettings('crystal-lens',false,false,defaults,{caustics:false,bounces:8},scene)).toEqual({...scene,caustics:false,bounces:8});
 expect(presetSettings('toycar',false,false,defaults)).toEqual(defaults);
});

it('restores the display only when leaving an example that stored a look',()=>{
 const display={toneMapping:'agx',exposure:1,bloomIntensity:0,bloomThreshold:1,bloomRadius:0.6} as const;
 const look={toneMapping:'aces',exposure:1.1} as const;
 expect(leavingDisplaySettings(look,undefined,display)).toEqual({toneMapping:'agx',exposure:1});
 expect(leavingDisplaySettings(look,{toneMapping:'cineon'},display)).toEqual({exposure:1});
 expect(leavingDisplaySettings({bounces:12},undefined,display)).toEqual({});
});

const stageDefaults={lighting:'environment',envId:'sky',envRotation:0,background:'environment'} as const;
it('applies a stage, restores defaults without one and lets a link win',()=>{
 const stage={lighting:'environment',envId:'venice_sunset',envRotation:90,background:'grounded'} as const;
 expect(presetStageSettings(stage,stageDefaults)).toEqual(stage);
 expect(presetStageSettings(undefined,stageDefaults)).toEqual(stageDefaults);
 expect(presetStageSettings(stage,stageDefaults,{envId:'lebombo'}).envId).toBe('lebombo');
});

it('keeps collection stages complete, on listed HDRIs and in the minority',()=>{
 const staged=PUBLIC_MODEL_PRESETS.filter((preset)=>preset.stage);
 expect(staged.length).toBeLessThan(PUBLIC_MODEL_PRESETS.length/2);
 for(const preset of staged) {
  expect(Object.keys(preset.stage!).sort()).toEqual([...STAGE_FIELDS].sort());
  expect(ENVIRONMENT_PRESETS.find((env)=>env.id===preset.stage!.envId)?.polyHaven).toBe(true);
 }
});
