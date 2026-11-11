// Viewer-private identities; public Geometry/Texture contracts remain unchanged.
import type * as THREE from 'three';
import type Geometry from '../../../src/scene/Geometry';
import type Texture from '../../../src/scene/Texture';
import type OpenPBRMaterial from '../../../src/scene/OpenPBRMaterial';
export interface HostGeometry {
    model: number;
    id: number;
    vertices: number;
    indices: number;
    min: [
        number,
        number,
        number
    ];
    max: [
        number,
        number,
        number
    ];
    uv: boolean;
    uv1: boolean;
    tangent?: boolean;
    normal?: boolean;
    color?: boolean;
}
export interface HostTexture {
    model: number;
    id: number;
    storage: number;
    preview: {
        width: number;
        height: number;
        data: Uint8Array;
    };
}
export const hostGeometries = new WeakMap<Geometry, HostGeometry>();
export const hostThreeGeometries = new WeakMap<THREE.BufferGeometry, {
    geometry: Geometry;
    reference: HostGeometry;
}>();
export const hostMaterials = new WeakMap<THREE.Material, OpenPBRMaterial>();
export const hostTextures = new WeakMap<Texture, HostTexture>();
