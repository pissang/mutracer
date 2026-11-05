import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class ViewerOrbitControls extends OrbitControls {
  // Three.js routes horizontal mouse/touch/key input and auto-rotation through
  // this hook. rotateSpeed would also invert vertical input. MuTracer retains
  // reflected camera bases, so compensate only horizontal orbit here.
  _rotateLeft(angle: number) {
    const base = OrbitControls.prototype as OrbitControls & { _rotateLeft(angle: number): void };
    base._rotateLeft.call(this, this.object.scale.x < 0 ? -angle : angle);
  }
}
