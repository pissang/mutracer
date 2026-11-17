import type { Mat4, Vec3 } from '../types.js';
import { read, write } from '../math/access.js';
import * as mat4 from '../math/sceneMat4.js';

/** Base class of objects positioned by a local-to-world transform. */
export default abstract class SceneNode {
  /** Optional object name. Default empty string. */
  name = '';
  /**
   * Local-to-world transform: column-major 4×4 (gl-matrix layout). Default identity.
   * Edits, including in-place element edits, are detected on the next render.
   */
  transform: Mat4 = mat4.create();

  /** Reads a copy of the translation, or writes it into transform. Default `[0, 0, 0]`. */
  get position(): Vec3 {
    return [read(this.transform, 12), read(this.transform, 13), read(this.transform, 14)];
  }
  set position(value: Vec3) {
    write(this.transform, 12, read(value, 0));
    write(this.transform, 13, read(value, 1));
    write(this.transform, 14, read(value, 2));
  }

  /** Points local -Z at target, preserving position and scale. Default up `[0, 1, 0]`. */
  lookAt(target: Vec3, up: Vec3 = [0, 1, 0]): this {
    const scale = mat4.getScaling(new Float32Array(3), this.transform);
    const position = this.position;
    const direction = [read(target, 0) - read(position, 0), read(target, 1) - read(position, 1), read(target, 2) - read(position, 2)];
    const cross = [direction[1]*read(up, 2)-direction[2]*read(up, 1), direction[2]*read(up, 0)-direction[0]*read(up, 2), direction[0]*read(up, 1)-direction[1]*read(up, 0)];
    const effectiveUp: Vec3 = Math.hypot(...cross) > 1e-8 ? up
      : Math.abs(direction[2]) < Math.hypot(...direction) * .99 ? [0, 0, -1] : [1, 0, 0];
    mat4.targetTo(this.transform, position, target, effectiveUp);
    mat4.scale(this.transform, this.transform, scale);
    return this;
  }
}
