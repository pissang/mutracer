import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { ViewerOrbitControls } from '../src/engine/orbitControls';
import { describe, expect, it } from 'vitest';

function fixture(mirrored: boolean, orthographic: boolean) {
  const camera = orthographic ? new OrthographicCamera(-2, 2, 2, -2) : new PerspectiveCamera(45, 1);
  camera.position.z = 4;
  camera.scale.x = mirrored ? -1 : 1;
  const document = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: document, style: {}, clientWidth: 600, clientHeight: 600,
    getRootNode: () => document, setPointerCapture() {}, releasePointerCapture() {}
  });
  const controls = new ViewerOrbitControls(camera, canvas as unknown as HTMLElement);
  const point = new Vector3(0, 0, 1);
  function screen() {
    camera.updateMatrixWorld(true);
    const p = point.clone().applyMatrix4(camera.matrixWorld.clone().invert()).applyMatrix4(camera.projectionMatrix);
    return [p.x, -p.y];
  }
  function drag(dx: number, dy: number) {
    for (const [type, x, y] of [['pointerdown', 100, 100], ['pointermove', 100 + dx, 100 + dy], ['pointerup', 100 + dx, 100 + dy]] as const) {
      const event = Object.assign(new Event(type), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y,
        ctrlKey: false, metaKey: false, shiftKey: false });
      (type === 'pointerdown' ? canvas : document).dispatchEvent(event);
    }
  }
  return { camera, controls, screen, drag };
}

describe('viewer orbit direction', () => {
  for (const mirrored of [false, true]) for (const orthographic of [false, true]) {
    it.each([[12, 0], [-12, 0], [0, 12], [0, -12]])(`moves near-side landmarks with the pointer (mirrored=${mirrored}, orthographic=${orthographic}, delta=%j)`, (dx, dy) => {
      const f = fixture(mirrored, orthographic);
      const before = f.screen();
      f.drag(dx, dy);
      const after = f.screen();
      expect((after[0] - before[0]) * dx + (after[1] - before[1]) * dy).toBeGreaterThan(0);
      expect(f.camera.matrixWorld.determinant() < 0).toBe(mirrored);
      f.controls.dispose();
    });
    it(`keeps auto-rotation direction consistent (mirrored=${mirrored}, orthographic=${orthographic})`, () => {
      const f = fixture(mirrored, orthographic);
      const before = f.screen();
      f.controls.autoRotate = true;
      f.controls.update(1 / 60);
      expect(f.screen()[0]).toBeGreaterThan(before[0]);
      f.controls.dispose();
    });
  }
});
