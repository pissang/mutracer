import {mat4} from 'gl-matrix';
import type Geometry from '../../scene/Geometry.js';
import type MeshState from '../../scene/MeshState.js';
import type MaterialState from '../../scene/MaterialState.js';

/** Local-space triangle area per material slot, cached by geometry version. */
const slotAreas = new WeakMap<Geometry, {version: number; areas: number[]}>();
function geometrySlotAreas(geometry: Geometry) {
    const cached = slotAreas.get(geometry);
    if (cached?.version === geometry.version) return cached.areas;
    const p = geometry.position.array, index = geometry.indexArray, slot = geometry.materialIndex?.array, areas: number[] = [];
    for (let t = 0; t + 2 < index.length; t += 3) {
        const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        const s = slot ? Math.max(slot[index[t]], 0) : 0;
        areas[s] = (areas[s] ?? 0) + 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
    slotAreas.set(geometry, {version: geometry.version, areas});
    return areas;
}
const scratch = mat4.create();
/** Area scale of a transform, assuming roughly uniform scale. */
const areaScale = (m: ArrayLike<number>) => Math.cbrt(Math.abs(mat4.determinant(m as mat4))) ** 2;

/**
 * World-space surface area per material over visible meshes: the planner's
 * proxy for how often a material is hit. Instanced meshes add every instance.
 */
export function materialSurfaceAreas(meshes: readonly MeshState[]) {
    const result = new Map<MaterialState, number>();
    for (const mesh of meshes) {
        if (!mesh.visible) continue;
        const instances = mesh.instanceData;
        let scale = 0;
        if (instances) for (let i = 0; i < instances.count; i++) scale += areaScale(mat4.multiply(scratch, mesh.transform, instances.transforms.subarray(i * 16, i * 16 + 16)));
        else scale = areaScale(mesh.transform);
        geometrySlotAreas(mesh.geometry).forEach((area, s) => {
            const material = mesh.materials[Math.min(s, mesh.materials.length - 1)];
            if (material) result.set(material, (result.get(material) ?? 0) + area * scale);
        });
    }
    return result;
}
