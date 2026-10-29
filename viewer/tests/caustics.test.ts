import {expect,it} from 'vitest';
import {causticOptions,presetCaustics} from '../src/caustics';
import {readURLSettings} from '../src/urlSettings';
it('preserves independent estimator choices in rendering and shared URLs',()=>{
 for(const causticLightTracing of [false,true])for(const causticPhotonMapping of [false,true]){
  const s={caustics:true,causticLightTracing,causticPhotonMapping};
  expect(readURLSettings('', '#'+new URLSearchParams(Object.entries(s).map(([k,v])=>[k,String(v)])))).toMatchObject(s);
  expect(causticOptions(s)).toEqual({lightTracing:causticLightTracing,photonMapping:causticPhotonMapping});
  expect(causticOptions({...s,caustics:false})).toBeUndefined();
 }
});
it('limits Cornell photon mapping to that built-in scene',()=>{
 const cornell={caustics:true,causticLightTracing:false,causticPhotonMapping:true};
 const defaults={caustics:false,causticLightTracing:true,causticPhotonMapping:false};
 expect(presetCaustics('research-cornell-caustic',false,defaults)).toEqual(cornell);
 expect(presetCaustics('research-cornell-caustic',true,defaults)).toEqual(cornell);
 expect(presetCaustics('spheres',false,defaults)).toEqual(defaults);
 expect(presetCaustics('spheres',true,defaults)).toBeUndefined();
 expect(presetCaustics(null,false,defaults)).toBeUndefined();
});
