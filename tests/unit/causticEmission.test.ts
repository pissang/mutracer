import {describe,it,expect} from 'vitest';
import {causticEmissionPower,causticEmissionTable} from '../../src/renderer/causticEmission';
import {RectLight,SpotLight,SphereLight} from '../../src/main';
describe('photon emission power',()=>{
 it('integrates actual angular support independently of NEE',()=>{
  const wide=new RectLight({size:[2,3],intensity:4}),narrow=new RectLight({size:[2,3],intensity:4,spread:.5});
  expect(causticEmissionPower(wide)).toBeCloseTo(24*Math.PI);
  expect(causticEmissionPower(narrow)/causticEmissionPower(wide)).toBeCloseTo(.5);
  const spot=new SpotLight({intensity:2,radius:0,innerAngle:30,outerAngle:30});
  expect(causticEmissionPower(spot)).toBeCloseTo(4*Math.PI*(1-Math.cos(Math.PI/6)),5);
  const sphere=new SphereLight({intensity:1,radius:0});
  const table=causticEmissionTable([wide,narrow,sphere],[]);
  expect(table.count).toBe(3);expect(table.data[4]+table.data[12]+table.data[20]).toBeCloseTo(1);
  expect(table.data[4]/table.data[12]).toBeCloseTo(2);
 });
});
