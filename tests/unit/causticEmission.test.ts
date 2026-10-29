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
  const finiteSpot=new SpotLight({intensity:2,radius:.25,innerAngle:30,outerAngle:30});
  expect(causticEmissionPower(finiteSpot)).toBeCloseTo(causticEmissionPower(spot),5);
  const sphere=new SphereLight({intensity:1,radius:0});
  const table=causticEmissionTable([wide,narrow,sphere],[]);
  expect(table.count).toBe(3);expect(table.data[4]+table.data[12]+table.data[20]).toBeCloseTo(1);
  expect(table.data[4]/table.data[12]).toBeCloseTo(2);
 });
});

it('preserves a ten-to-one point-light power ratio and the weak emitter support',()=>{
 const strong=new SphereLight({intensity:120,radius:0}),weak=new SphereLight({intensity:12,radius:0});
 const table=causticEmissionTable([strong,weak],[]);
 expect(table.count).toBe(2);
 expect(table.data[4]).toBeCloseTo(10/11);expect(table.data[12]).toBeCloseTo(1/11);
 const samples=[0,0],words=new Uint32Array(table.data.buffer),n=110000;
 for(let i=0;i<n;i++){
  const scaled=(i+.5)/n*2,column=Math.floor(scaled);
  const selected=scaled-column<table.data[column*8]?column:words[column*8+1];samples[selected]++;
 }
 expect(samples[0]/samples[1]).toBeCloseTo(10,2);
});

it('includes the collimated rectangle in the photon source distribution',()=>{
 const beam=new RectLight({size:[2,3],intensity:4,spread:0});
 expect(causticEmissionPower(beam)).toBeCloseTo(24);
 const table=causticEmissionTable([beam,new SphereLight({radius:0,intensity:1})],[]);
 expect(table.count).toBe(2);expect(table.data[4]).toBeGreaterThan(0);expect(table.data[12]).toBeGreaterThan(0);
});
