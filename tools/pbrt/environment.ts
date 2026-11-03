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
  const integrate = equalArea && filter === 'nearest';
  const strata = integrate ? 4 : 1;
  const sampleCount = strata * strata;
  // Fixed integer hash: reproducible jitter without sharing a render RNG.
  const jitter = (seed: number) => {
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
    return ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const target = (y * width + x) * 4;
    const top = Math.cos(y * Math.PI / height), bottom = Math.cos((y + 1) * Math.PI / height);
    for (let sy = 0; sy < strata; sy++) for (let sx = 0; sx < strata; sx++) {
      const seed = ((y * width + x) * sampleCount + sy * strata + sx) * 2;
      const sampleY = integrate ? (sy + jitter(seed)) / strata : .5;
      const sampleX = integrate ? (sx + jitter(seed + 1)) / strata : .5;
      const theta = integrate ? Math.acos(top + (bottom - top) * sampleY) : (y + .5) / height * Math.PI;
      const phi = (x + sampleX) / width * 2 * Math.PI;
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
        const input = (yy * source.width + xx) * 4;
        for (let c = 0; c < 3; c++) data[target+c] += source.data[input+c] / sampleCount;
        continue;
      }
      const px = u * source.width - 0.5, py = v * source.height - 0.5;
      const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = equalArea ? THREE.MathUtils.clamp(ix + dx, 0, source.width - 1) : wrap(ix + dx, source.width);
        const yy = THREE.MathUtils.clamp(iy + dy, 0, source.height - 1);
        const input = (yy * source.width + xx) * 4;
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        for (let c = 0; c < 3; c++) data[target + c] += source.data[input + c] * weight;
      }
    }
    data[target + 3] = 1;
  }
  if (integrate) {
    // Residual quadrature error must not change a tiny sun's total radiance.
    // Equal-area source texels all subtend 4π/N; target bands have exact areas.
    const sourceSum = [0,0,0], targetSum = [0,0,0];
    for (let i = 0; i < source.data.length; i += 4) for (let c = 0; c < 3; c++) sourceSum[c] += source.data[i+c];
    for (let y = 0; y < height; y++) {
      const omega = 2 * Math.PI / width * (Math.cos(y * Math.PI / height) - Math.cos((y+1) * Math.PI / height));
      for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) targetSum[c] += data[(y*width+x)*4+c] * omega;
    }
    const factors = sourceSum.map((v,c) => targetSum[c] > 0 ? v * 4 * Math.PI / (source.width * source.height) / targetSum[c] : 1);
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i+c] *= factors[c];
  }
  return { width, height, data };
}

