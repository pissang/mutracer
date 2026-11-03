import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { reprojectEnvironment, type EquirectData } from '../../tools/pbrt/environment';
function energy(image: EquirectData) {
  let sum = 0;
  for (let y=0;y<image.height;y++) {
    const omega = 2*Math.PI/image.width*(Math.cos(y*Math.PI/image.height)-Math.cos((y+1)*Math.PI/image.height));
    for(let x=0;x<image.width;x++) sum += image.data[(y*image.width+x)*4]*omega;
  }
  return sum;
}
describe('equal-area environment energy', () => {
  it('preserves a small sun at several latitudes, seams and rotations', () => {
    const size = 2048;
    const data = new Float32Array(size*size*4);
    for (const [x,y] of [[1024,1024],[64,700],[1400,100],[2044,2044]]) {
      for(let j=0;j<3;j++) for(let i=0;i<3;i++) data[((y+j)*size+x+i)*4] = 1000;
      const sourceEnergy = 9000*4*Math.PI/(size*size);
      const projected = reprojectEnvironment({width:size,height:size,data},new Matrix4().makeRotationY(.37),true,'nearest');
      expect(Math.abs(energy(projected)/sourceEnergy-1), `${x},${y}`).toBeLessThan(.02);
      for(let j=0;j<3;j++) for(let i=0;i<3;i++) data[((y+j)*size+x+i)*4] = 0;
    }
  }, 60000);
  it('preserves constant radiance including polar pixel areas', () => {
    const data = new Float32Array(16*16*4).fill(.3);
    const projected = reprojectEnvironment({width:16,height:16,data},new Matrix4(),true,'nearest',64);
    expect(energy(projected)/(4*Math.PI)).toBeCloseTo(.3,6);
  });
});
