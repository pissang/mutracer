import {expect,it} from 'vitest';
import {presetSettings} from '../src/presetSettings';
const defaults={groundShadow:true,caustics:false,causticLightTracing:true,causticPhotonMapping:false};
it('keeps research and Cornell settings to their own built-in scenes',()=>{
 const cornell={groundShadow:false,caustics:true,causticLightTracing:false,causticPhotonMapping:true};
 expect(presetSettings('research-cornell-caustic',true,false,defaults)).toEqual(cornell);
 expect(presetSettings('research-cornell-caustic',true,true,defaults)).toEqual(cornell);
 expect(presetSettings('research-cornell-box',true,false,defaults)).toEqual({...defaults,groundShadow:false});
 expect(presetSettings('research-cornell-box',true,true,defaults)).toEqual({groundShadow:false});
 expect(presetSettings('spheres',false,false,defaults)).toEqual(defaults);
 expect(presetSettings('spheres',false,true,defaults)).toBeUndefined();
 expect(presetSettings(null,false,false,defaults)).toBeUndefined();
});
