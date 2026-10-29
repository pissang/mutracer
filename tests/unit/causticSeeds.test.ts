import {expect,it} from 'vitest';
import {CausticSeedCache} from '../../src/renderer/causticSeeds';
import {Mesh,OpenPBRMaterial,createPlaneGeometry} from '../../src/main';
it('samples only caster area and refreshes transforms and material membership',()=>{
 const cache=new CausticSeedCache(),glass=new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0}),diffuse=new OpenPBRMaterial();
 const a=new Mesh(createPlaneGeometry(),glass),b=new Mesh(createPlaneGeometry(),diffuse);
 const bindings=[{mesh:a,geometry:a.geometry,materialIndices:[0]},{mesh:b,geometry:b.geometry,materialIndices:[1]}],materials=[glass,diffuse];
 const result=cache.collect(bindings,materials);expect(result.count).toBe(2);expect(result.data[3]).toBe(.5);expect(result.data[15]).toBe(1);
 expect(cache.collect(bindings,materials)).toBe(result);
 a.position=[3,0,0];const moved=cache.collect(bindings,materials);expect(moved.data[0]-result.data[0]).toBe(3);
 glass.transmissionWeight=0;expect(cache.collect(bindings,materials).count).toBe(0);
});
