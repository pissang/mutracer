import {expect,it} from 'vitest';
import {causticOptions} from '../src/caustics';
import {readURLSettings} from '../src/urlSettings';
it('preserves independent estimator choices in rendering and shared URLs',()=>{
 for(const causticLightTracing of [false,true])for(const causticPhotonMapping of [false,true]){
  const s={caustics:true,causticLightTracing,causticPhotonMapping};
  expect(readURLSettings('', '#'+new URLSearchParams(Object.entries(s).map(([k,v])=>[k,String(v)])))).toMatchObject(s);
  expect(causticOptions(s)).toEqual({lightTracing:causticLightTracing,photonMapping:causticPhotonMapping});
  expect(causticOptions({...s,caustics:false})).toBeUndefined();
 }
});
