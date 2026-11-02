import * as THREE from 'three';
export interface EquirectData { width: number; height: number; data: Float32Array }
/** Converts PBRT's Z-up environment directions to the viewer's Y-up lat-long. */
export function reprojectEnvironment(source: EquirectData, transform: THREE.Matrix4, equalArea = false, filter: 'linear' | 'nearest' = 'linear', minimumWidth = 4): EquirectData {
  const width = Math.min(2048, Math.max(minimumWidth, equalArea ? source.width * 2 : source.width));
  const height = Math.max(2, Math.round(width / 2));
  const data = new Float32Array(width * height * 4);
  const inverse = transform.clone().invert();
  const direction = new THREE.Vector3();
  const wrap = (x: number, size: number) => ((x % size) + size) % size;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const theta = (y + 0.5) / height * Math.PI;
    const phi = (x + 0.5) / width * 2 * Math.PI;
    direction.set(-Math.sin(theta) * Math.cos(phi), Math.cos(theta), -Math.sin(theta) * Math.sin(phi)).transformDirection(inverse);
    let u: number, v: number;
    if (equalArea) {
      // Invert the equal-area square-to-sphere geometry: r² = 1 - |z|,
      // and the first-quadrant azimuth divides r between the square axes.
      // Parameterization: https://pbr-book.org/4ed/Geometry_and_Transformations/Spherical_Geometry#Equal-AreaMapping
      const radius = Math.sqrt(Math.max(0, 1 - Math.abs(direction.z)));
      const azimuth = Math.atan2(Math.abs(direction.y), Math.abs(direction.x)) * 2 / Math.PI;
      let sx = radius * (1 - azimuth), sy = radius * azimuth;
      if (direction.z < 0) [sx, sy] = [1 - sy, 1 - sx];
      u = (Math.sign(direction.x) * sx + 1) / 2;
      v = (Math.sign(direction.y) * sy + 1) / 2;
    } else {
      u = wrap(Math.atan2(direction.y, direction.x) / (2 * Math.PI), 1);
      v = Math.acos(THREE.MathUtils.clamp(direction.z, -1, 1)) / Math.PI;
    }
    if (filter === 'nearest') {
      const xx = THREE.MathUtils.clamp(Math.floor(u * source.width), 0, source.width - 1);
      const yy = THREE.MathUtils.clamp(Math.floor(v * source.height), 0, source.height - 1);
      data.set(source.data.subarray((yy * source.width + xx) * 4, (yy * source.width + xx) * 4 + 4), (y * width + x) * 4);
      continue;
    }
    const px = u * source.width - 0.5, py = v * source.height - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const target = (y * width + x) * 4;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const xx = equalArea ? THREE.MathUtils.clamp(ix + dx, 0, source.width - 1) : wrap(ix + dx, source.width);
      const yy = THREE.MathUtils.clamp(iy + dy, 0, source.height - 1);
      const input = (yy * source.width + xx) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      for (let c = 0; c < 3; c++) data[target + c] += source.data[input + c] * weight;
    }
    data[target + 3] = 1;
  }
  return { width, height, data };
}

