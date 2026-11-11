import * as THREE from 'three';
import Geometry, { Attribute } from '../../../src/scene/Geometry';
import Texture from '../../../src/scene/Texture';
import { fromTHREEScene } from '../../../src/util/fromTHREE';
import type OpenPBRMaterial from '../../../src/scene/OpenPBRMaterial';
import { decodeMaterial, decodeTexture } from '../../../native/src/scene-records';
import { HEADER as H, MATERIAL as M, TEXTURE as T, MESH } from '../../../native/src/layout';
import type { LoadedModel, ModelSource } from './loadModel';
import { loadModelLighting } from './modelLighting';
import { hostGeometries, hostThreeGeometries, hostMaterials, hostTextures, type HostGeometry } from './nativeResources';
export interface NativeGltfManifest {
    id: number;
    document: any;
    descriptor: string;
    groundOffset: [
        number,
        number,
        number
    ];
    warnings: string[];
    geometries: Omit<HostGeometry, 'id' | 'model'>[];
    textures: {
        width: number;
        height: number;
        storage: number;
        preview: {
            width: number;
            height: number;
            data: number[];
        };
    }[];
    meshes: {
        node: number;
        name: string;
        geometry: number;
        material: number;
        first: number;
        count: number;
    }[];
    materialNames: string[];
}
export async function buildNativeGltf(manifest: NativeGltfManifest, source: ModelSource, descriptor: ArrayBuffer, resource: (path: string) => Promise<ArrayBuffer>, release: () => void): Promise<LoadedModel> {
    const words = new Uint32Array(descriptor), floats = new Float32Array(descriptor), bytes = new Uint8Array(descriptor);
    if (words[H.TEXTURE_COUNT] !== manifest.textures.length || words[H.GEOMETRY_COUNT] !== manifest.geometries.length || words[H.MATERIAL_COUNT] !== manifest.materialNames.length)
        throw Error('Native scene manifest mismatch');
    const retainedImages = new WeakMap<object, {
        model: number;
        id: number;
        storage: number;
        preview: {
            width: number;
            height: number;
            data: Uint8Array;
        };
    }>();
    const decodedTextures = Array.from({ length: words[H.TEXTURE_COUNT] }, (_, i) => decodeTexture(bytes, words, floats, words[H.TEXTURE_OFFSET] + i * T.WORDS));
    const textures = decodedTextures.map((decoded, id) => {
        const info = manifest.textures[id], image = { width: info.width, height: info.height };
        retainedImages.set(image, { model: manifest.id, id, storage: info.storage, preview: { ...info.preview, data: Uint8Array.from(info.preview.data) } });
        const texture = new THREE.Texture(image as any);
        texture.flipY = decoded.flipY;
        texture.channel = decoded.uvChannel;
        texture.repeat.fromArray(decoded.uvScale);
        texture.offset.fromArray(decoded.uvOffset);
        const wrap = (mode: string) => mode === 'clamp-to-edge' ? THREE.ClampToEdgeWrapping : mode === 'mirrored-repeat' ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        texture.wrapS = wrap(decoded.wrapS);
        texture.wrapT = wrap(decoded.wrapT);
        texture.colorSpace = info.storage === 0 ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
        return texture;
    });
    const textureFor = new Map<object, THREE.Texture>(decodedTextures.map((texture, i) => [texture, textures[i]]));
    const materials = manifest.materialNames.map((name, index) => {
        const decoded = decodeMaterial(words, floats, words[H.MATERIAL_OFFSET] + index * M.WORDS, decodedTextures);
        const json = manifest.document.materials?.[index] ?? {}, e = json.extensions ?? {};
        const physical = Object.keys(e).some(key => [
            'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_ior',
            'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_dispersion'
        ].includes(key));
        const proxy = e.KHR_materials_unlit ? new THREE.MeshBasicMaterial() : physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
        proxy.name = name;
        proxy.userData = { ...json.extras };
        proxy.color.fromArray(decoded.baseColor);
        proxy.opacity = json.pbrMetallicRoughness?.baseColorFactor?.[3] ?? decoded.geometryOpacity;
        proxy.transparent = json.alphaMode === 'BLEND';
        if (json.alphaMode === 'MASK')
            proxy.alphaTest = json.alphaCutoff ?? .5;
        proxy.side = json.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide;
        proxy.map = textureFor.get(decoded.map!) ?? null;
        if (proxy instanceof THREE.MeshStandardMaterial) {
            proxy.roughness = decoded.specularRoughness;
            proxy.metalness = decoded.baseMetalness;
            proxy.emissive.fromArray(decoded.emissionColor);
            proxy.emissiveIntensity = decoded.emissionLuminance;
            proxy.emissiveMap = textureFor.get(decoded.emissiveMap!) ?? null;
            proxy.normalMap = textureFor.get(decoded.normalMap!) ?? null;
            proxy.normalScale.fromArray(decoded.normalScale);
            proxy.roughnessMap = proxy.metalnessMap = textureFor.get(decoded.metallicRoughnessMap!) ?? null;
        }
        if (proxy instanceof THREE.MeshPhysicalMaterial) {
            proxy.transmission = e.KHR_materials_transmission?.transmissionFactor ?? 0;
            proxy.ior = e.KHR_materials_ior?.ior ?? 1.5;
            proxy.clearcoat = e.KHR_materials_clearcoat?.clearcoatFactor ?? 0;
            proxy.clearcoatRoughness = e.KHR_materials_clearcoat?.clearcoatRoughnessFactor ?? 0;
            const normalScale = e.KHR_materials_clearcoat?.clearcoatNormalTexture?.scale ?? 1;
            proxy.clearcoatNormalScale.set(normalScale, normalScale);
            if (e.KHR_materials_sheen) {
                proxy.sheen = 1;
                proxy.sheenColor.fromArray(e.KHR_materials_sheen.sheenColorFactor ?? [0, 0, 0]);
                proxy.sheenRoughness = e.KHR_materials_sheen.sheenRoughnessFactor ?? 0;
            }
            proxy.specularIntensity = e.KHR_materials_specular?.specularFactor ?? 1;
            proxy.specularColor.fromArray(e.KHR_materials_specular?.specularColorFactor ?? [1, 1, 1]);
            proxy.thickness = e.KHR_materials_volume?.thicknessFactor ?? 0;
            proxy.attenuationColor.fromArray(e.KHR_materials_volume?.attenuationColor ?? [1, 1, 1]);
            proxy.attenuationDistance = e.KHR_materials_volume?.attenuationDistance || Infinity;
            proxy.iridescence = e.KHR_materials_iridescence?.iridescenceFactor ?? 0;
            proxy.iridescenceIOR = e.KHR_materials_iridescence?.iridescenceIor ?? 1.3;
            proxy.iridescenceThicknessRange = [e.KHR_materials_iridescence?.iridescenceThicknessMinimum ?? 100, e.KHR_materials_iridescence?.iridescenceThicknessMaximum ?? 400];
            proxy.anisotropy = e.KHR_materials_anisotropy?.anisotropyStrength ?? 0;
            proxy.anisotropyRotation = e.KHR_materials_anisotropy?.anisotropyRotation ?? 0;
            proxy.dispersion = e.KHR_materials_dispersion?.dispersion ?? 0;
            const slots = { transmissionMap: 'transmissionMap', coatWeightMap: 'clearcoatMap', coatRoughnessMap: 'clearcoatRoughnessMap',
                coatNormalMap: 'clearcoatNormalMap', fuzzColorMap: 'sheenColorMap', fuzzRoughnessMap: 'sheenRoughnessMap',
                specularWeightMap: 'specularIntensityMap', specularColorMap: 'specularColorMap', thinFilmMap: 'iridescenceThicknessMap', anisotropyMap: 'anisotropyMap' };
            for (const [native, key] of Object.entries(slots))
                (proxy as any)[key] = textureFor.get((decoded as any)[native]) ?? null;
        }
        return proxy;
    });
    const variants = new Map<string, THREE.MeshBasicMaterial | THREE.MeshStandardMaterial>();
    const materialFor = (geometry: number, index: number) => {
        const info = manifest.geometries[geometry];
        const key = `${index}:${!!info.tangent}:${!!info.color}:${info.normal !== false}`;
        let proxy = variants.get(key);
        if (!proxy) {
            proxy = materials[index].clone();
            proxy.vertexColors = !!info.color;
            if (proxy instanceof THREE.MeshStandardMaterial) {
                proxy.flatShading = info.normal === false;
                // Same primitive-dependent convention as GLTFLoader's final material.
                if (!info.tangent)
                    proxy.normalScale.y *= -1;
                if (proxy instanceof THREE.MeshPhysicalMaterial && !info.tangent)
                    proxy.clearcoatNormalScale.y *= -1;
            }
            // Reuse the web material conversion, including mutracerOpenPBR
            // metadata and defaults. Only small proxy geometry is converted.
            const root = new THREE.Scene();
            root.add(new THREE.Mesh(geometries[geometry], proxy));
            const material = fromTHREEScene(root).meshes[0].materials[0] as OpenPBRMaterial;
            for (const value of Object.values(material))
                if (value instanceof Texture) {
                    const retained = retainedImages.get(value.image);
                    if (retained)
                        hostTextures.set(value, retained);
                }
            hostMaterials.set(proxy, material);
            variants.set(key, proxy);
        }
        return proxy;
    };
    const geometries = manifest.geometries.map((info, id) => {
        const reference = { ...info, id, model: manifest.id };
        const geometry = new Geometry({ position: new Attribute(new Float32Array(), 3), normal: new Attribute(new Float32Array(), 3), indices: new Attribute(new Uint32Array(), 1),
            ...(info.uv ? { uv: new Attribute(new Float32Array(), 2) } : {}), ...(info.uv1 ? { uv1: new Attribute(new Float32Array(), 2) } : {}) });
        hostGeometries.set(geometry, reference);
        // Only bounds are needed by the scene tree, grounding, selection and studio rig.
        const proxy = new THREE.BufferGeometry(), positions: number[] = [];
        for (let i = 0; i < 8; i++)
            positions.push(...info.min.map((v, axis) => i & (1 << axis) ? info.max[axis] : v));
        proxy.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        proxy.setIndex([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]);
        if (info.uv)
            proxy.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(16), 2));
        proxy.boundingBox = new THREE.Box3(new THREE.Vector3(...info.min), new THREE.Vector3(...info.max));
        proxy.boundingSphere = proxy.boundingBox.getBoundingSphere(new THREE.Sphere());
        hostThreeGeometries.set(proxy, { geometry, reference });
        return proxy;
    });
    const json = manifest.document, nodes: THREE.Object3D[] = (json.nodes ?? []).map((node: any) => {
        let object: THREE.Object3D = new THREE.Group();
        if (node.camera !== undefined) {
            const camera = json.cameras[node.camera];
            if (camera.type === 'perspective') {
                const c = camera.perspective;
                object = new THREE.PerspectiveCamera(c.yfov * 180 / Math.PI, c.aspectRatio ?? 1, c.znear ?? 1, c.zfar ?? 2e6);
            }
            else {
                const c = camera.orthographic;
                object = new THREE.OrthographicCamera(-c.xmag, c.xmag, c.ymag, -c.ymag, c.znear, c.zfar);
            }
        }
        const importedCamera=node.camera!==undefined?object:undefined;
        const lightId = node.extensions?.KHR_lights_punctual?.light;
        if (lightId !== undefined) {
            const light = json.extensions.KHR_lights_punctual.lights[lightId], color = new THREE.Color().fromArray(light.color ?? [1, 1, 1]), intensity = light.intensity ?? 1;
            object = light.type === 'directional' ? new THREE.DirectionalLight(color, intensity) : light.type === 'spot' ? new THREE.SpotLight(color, intensity, light.range ?? 0, light.spot?.outerConeAngle ?? Math.PI / 4, 1 - (light.spot?.innerConeAngle ?? 0) / (light.spot?.outerConeAngle ?? Math.PI / 4), 2) : new THREE.PointLight(color, intensity, light.range ?? 0, 2);
            if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight) {
                object.target.position.set(0, 0, -1);
                object.add(object.target);
            }
        }
        if(importedCamera && lightId!==undefined){
            importedCamera.name=node.name??json.cameras[node.camera].name??'';
            importedCamera.userData={...(json.cameras[node.camera].extras??{}),...(node.extras??{})};
            const group=new THREE.Group();group.add(importedCamera,object);object=group;
        }
        object.name = node.name ?? (node.camera !== undefined ? json.cameras[node.camera].name : '') ?? '';
        object.userData = { ...(node.camera !== undefined ? json.cameras[node.camera].extras ?? {} : {}), ...(node.extras ?? {}) };
        if (node.matrix)
            object.matrix.fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
        else {
            object.position.fromArray(node.translation ?? [0, 0, 0]);
            object.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]);
            object.scale.fromArray(node.scale ?? [1, 1, 1]);
        }
        return object;
    });
    (json.nodes ?? []).forEach((node: any, i: number) => {
        for (const child of node.children ?? [])
            nodes[i].add(nodes[child]);
    });
    const root = new THREE.Group();
    root.name = source.mainPath.split('/').pop() ?? 'Model';
    root.userData = { ...(json.scenes?.[json.scene ?? 0]?.extras ?? {}), ...(json.extras ?? {}) };
    for (const id of json.scenes?.[json.scene ?? 0]?.nodes ?? [])
        root.add(nodes[id]);
    root.updateMatrixWorld(true);
    const insertions = new Map<THREE.Object3D, number>();
    const world = new THREE.Matrix4(), local = new THREE.Matrix4();
    const transform = (index: number) => world.fromArray(floats, words[H.MESH_OFFSET] + index * MESH.WORDS + MESH.TRANSFORM);
    for (const mesh of manifest.meshes) {
        const parent = nodes[mesh.node] ?? root, inverse = new THREE.Matrix4().copy(parent.matrixWorld).invert();
        let proxy: THREE.Mesh;
        if (json.nodes?.[mesh.node]?.extensions?.EXT_mesh_gpu_instancing) {
            const instances = new THREE.InstancedMesh(geometries[mesh.geometry], materialFor(mesh.geometry, mesh.material), mesh.count);
            for (let index = 0; index < mesh.count; index++)
                instances.setMatrixAt(index, local.multiplyMatrices(inverse, transform(mesh.first + index)));
            instances.computeBoundingBox();
            instances.computeBoundingSphere();
            proxy = instances;
        }
        else {
            proxy = new THREE.Mesh(geometries[mesh.geometry], materialFor(mesh.geometry, mesh.material));
            local.multiplyMatrices(inverse, transform(mesh.first)).decompose(proxy.position, proxy.quaternion, proxy.scale);
        }
        proxy.name = mesh.name;
        parent.add(proxy);
        // Match GLTFLoader's primitive-before-child order for edits and snippets.
        const at = insertions.get(parent) ?? 0;
        parent.children.pop();
        parent.children.splice(at, 0, proxy);
        insertions.set(parent, at + 1);
    }
    root.updateMatrixWorld(true);
    const lighting = await loadModelLighting(root, json.extras ?? {}, resource);
    lighting.warnings.push(...manifest.warnings.filter(warning => warning !== 'Unsupported optional extension is ignored: KHR_lights_punctual'));
    return { name: root.name, root, animations: [], lighting, source, groundOffset: manifest.groundOffset, revoke: release };
}
