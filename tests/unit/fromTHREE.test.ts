import Engine from '../../src/Engine';
import { getLightDirection } from '../../src/renderer/lightsUtil';
import { getRectLightUOrV, getRectLightArea } from '../../src/renderer/lightsUtil.js';
import { setGeometryBvh, getGeometryBvh } from '../../src/renderer/geometryBvh.js';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import SphereLight from '../../src/scene/SphereLight';
import { fromTHREECamera, fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import Camera from '../../src/scene/Camera';
import { parseIESProfile } from '../../src/scene/IESProfile';

describe('Three.js scene conversion', () => {
  it('keeps GLTFLoader unlit meshes visible without turning them into lights', () => {
    const scene = new THREE.Scene();
    const map = new THREE.Texture({ width: 1, height: 1 });
    const material = new THREE.MeshBasicMaterial({
      color: 0x80c0ff,
      map,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide
    });
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene);
    expect(converted.meshes).toHaveLength(1);
    expect(converted.meshes[0].materials[0]).toMatchObject({
      unlit: true,
      baseWeight: 0,
      specularWeight: 0,
      emissionLuminance: 1,
      opacity: 0.6,
      alphaMode: 'blend',
      doubleSided: true
    });
    expect(converted.meshes[0].materials[0].emissiveMap).toBe(
      converted.meshes[0].materials[0].map
    );
  });

  it('preserves secondary UVs and per-texture UV channels', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2)
    );
    geometry.setAttribute(
      'uv1',
      new THREE.Float32BufferAttribute([0.1, 0.2, 0.8, 0.2, 0.1, 0.9], 2)
    );
    geometry.setIndex([0, 1, 2]);
    const map = new THREE.Texture({ width: 1, height: 1 });
    (map as THREE.Texture & { channel: number }).channel = 1;
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map }))
    );

    const converted = fromTHREEScene(scene).meshes[0];

    expect(Array.from(converted.geometry.uv1!.array)).toEqual(
      Array.from(new Float32Array([0.1, 0.2, 0.8, 0.2, 0.1, 0.9]))
    );
    expect(converted.materials[0].map?.uvChannel).toBe(1);
  });

  it('skips objects hidden directly or by a parent', () => {
    const scene = new THREE.Scene();
    const visible = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial()
    );
    const hidden = visible.clone();
    hidden.visible = false;
    const hiddenGroup = new THREE.Group();
    hiddenGroup.visible = false;
    hiddenGroup.add(visible.clone());
    scene.add(visible, hidden, hiddenGroup);

    expect(fromTHREEScene(scene).meshes).toHaveLength(1);
  });

  it('uses complete TRIANGLES only and skips meshes with no complete triangle', () => {
    for (const vertexCount of [1, 2, 4, 5, 6]) {
      const geometry = new THREE.BufferGeometry();
      const positions = Array.from({ length: vertexCount }, (_unused, index) =>
        [index, index % 2, 0]).flat();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

      const converted = fromTHREEScene(scene);
      const completeIndexCount = Math.floor(vertexCount / 3) * 3;
      if (!completeIndexCount) {
        expect(converted.meshes).toHaveLength(0);
        continue;
      }
      expect(converted.meshes).toHaveLength(1);
      expect(converted.meshes[0].geometry.indices.array.length)
        .toBe(completeIndexCount);
      expect(completeIndexCount % 3).toBe(0);
    }

    for (const indexCount of [1, 2, 4, 5, 6]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0
      ], 3));
      geometry.setIndex(Array.from({ length: indexCount }, (_unused, index) => index));
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

      const converted = fromTHREEScene(scene);
      const completeIndexCount = Math.floor(indexCount / 3) * 3;
      expect(converted.meshes).toHaveLength(completeIndexCount ? 1 : 0);
      if (completeIndexCount) {
        expect(converted.meshes[0].geometry.indices.array.length)
          .toBe(completeIndexCount);
      }
    }
  });

  it('decodes normalized quantized geometry attributes', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Uint16Array([0, 32_768, 65_535, 65_535, 0, 32_768, 0, 0, 0]),
        3,
        true
      )
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(
        new Int8Array([0, 0, 127, 0, 127, 0, -127, 0, 0]),
        3,
        true
      )
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(
        new Uint16Array([0, 0, 65_535, 0, 0, 65_535]),
        2,
        true
      )
    );
    geometry.setAttribute(
      'tangent',
      new THREE.BufferAttribute(
        new Float32Array([
          1, 0, 0, 1,
          0, 1, 0, -1,
          0, 0, 1, 1
        ]),
        4
      )
    );
    geometry.setIndex([0, 1, 2]);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    const converted = fromTHREEScene(scene).meshes[0].geometry;

    expect(Array.from(converted.position.array)).toEqual(
      Array.from(
        new Float32Array([
          0,
          32_768 / 65_535,
          1,
          1,
          0,
          32_768 / 65_535,
          0,
          0,
          0
        ])
      )
    );
    expect(Array.from(converted.normal.array)).toEqual([
      0, 0, 1, 0, 1, 0, -1, 0, 0
    ]);
    expect(Array.from(converted.uv!.array)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(converted.tangent!.array)).toEqual([
      1, 0, 0, 1,
      0, 1, 0, -1,
      0, 0, 1, 1
    ]);
  });

  it.each([false, true])('copies float attributes independently (interleaved: %s)', (interleaved) => {
    const geometry = new THREE.BufferGeometry();
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const tangents = [1, 0, 0, 1, 0, 1, 0, -1, 0, 0, 1, 1];
    if (interleaved) {
      const values: number[] = [];
      for (let vertex = 0; vertex < 3; vertex++) {
        values.push(99, ...positions.slice(vertex * 3, vertex * 3 + 3),
          ...normals.slice(vertex * 3, vertex * 3 + 3),
          ...tangents.slice(vertex * 4, vertex * 4 + 4), 99);
      }
      const data = new THREE.InterleavedBuffer(new Float32Array(values), 12);
      geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(data, 3, 1));
      geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(data, 3, 4));
      geometry.setAttribute('tangent', new THREE.InterleavedBufferAttribute(data, 4, 7));
    } else {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4));
    }
    geometry.setIndex([0, 1, 2]);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    const converted = fromTHREEScene(scene).meshes[0].geometry;
    expect(Array.from(converted.position.array)).toEqual(positions);
    expect(Array.from(converted.normal.array)).toEqual(normals);
    expect(Array.from(converted.tangent!.array)).toEqual([1, 0, 0, 1, 0, 1, 0, -1, 0, 0, 1, 1]);
    expect(Array.from(converted.boundingBox.min)).toEqual([0, 0, 0]);
    expect(Array.from(converted.boundingBox.max)).toEqual([1, 1, 0]);

    geometry.getAttribute('position').setX(0, 10);
    geometry.getAttribute('tangent').setY(0, 10);
    geometry.index!.setX(0, 2);
    expect(converted.position.array[0]).toBe(0);
    expect(converted.tangent!.array[1]).toBe(0);
    expect(converted.indices.array[0]).toBe(0);
    converted.normal.array[2] = -1;
    expect(geometry.getAttribute('normal').getZ(0)).toBe(1);
  });

  it('decodes interleaved normalized integers and half-float attributes', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float16BufferAttribute(
      [0, 0, 0, 0.5, 0, 0, 0, 0.25, 0].map(THREE.DataUtils.toHalfFloat), 3
    ));
    const data = new THREE.InterleavedBuffer(new Int8Array([
      42, 0, 0, 127, 1, 0, 0, -128,
      42, 0, 127, 0, 0, 1, 0, 127,
      42, -128, 0, 0, 0, 0, 1, 127
    ]), 8);
    geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(data, 3, 1, true));
    geometry.setAttribute('tangent', new THREE.InterleavedBufferAttribute(data, 4, 4, true));
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    const converted = fromTHREEScene(scene).meshes[0].geometry;
    expect(Array.from(converted.position.array)).toEqual([0, 0, 0, 0.5, 0, 0, 0, 0.25, 0]);
    expect(Array.from(converted.normal.array)).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    expect(Array.from(converted.tangent!.array)).toEqual(Array.from(new Float32Array([
      1 / 127, 0, 0, -1, 0, 1 / 127, 0, 1, 0, 0, 1 / 127, 1
    ])));
  });

  it.each([Uint16Array, Uint32Array])('copies only complete grouped triangles from %s indices', (ArrayType) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0
    ], 3));
    geometry.setIndex(new THREE.BufferAttribute(new ArrayType([0, 1, 2, 2, 1, 3, 0, 4]), 1));
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 10, 1);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]));

    const converted = fromTHREEScene(scene).meshes;
    expect(converted).toHaveLength(2);
    expect(Array.from(converted[0].geometry.indices.array)).toEqual([0, 1, 2]);
    expect(Array.from(converted[1].geometry.indices.array)).toEqual([2, 1, 3]);
    expect(converted[1].geometry.indices.array).toBeInstanceOf(Uint32Array);
    expect(Array.from(geometry.index!.array)).toEqual([0, 1, 2, 2, 1, 3, 0, 4]);
  });

  it('generates grouped non-indexed triangles at the original vertex offsets', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0, 4, 0, 0
    ], 3));
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, Infinity, 1);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]));

    const converted = fromTHREEScene(scene).meshes;
    expect(converted).toHaveLength(2);
    expect(Array.from(converted[0].geometry.indices.array)).toEqual([0, 1, 2]);
    expect(Array.from(converted[1].geometry.indices.array)).toEqual([3, 4, 5]);
    expect(Array.from(converted[1].geometry.normal.array.slice(9, 18))).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('converts physical materials, transforms and environment data', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x336699,
      roughness: 0.35,
      metalness: 0.7,
      transmission: 0.4,
      ior: 1.45,
      opacity: 0.8,
      transparent: true
    });
    const physicalMaterial = material as THREE.MeshPhysicalMaterial & {
      dispersion: number;
      anisotropy: number;
    };
    physicalMaterial.dispersion = 0.35;
    physicalMaterial.anisotropy = 0.8;
    material.userData.mutracerBevelSize = 0.075;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.name = 'Converted cube';
    mesh.position.set(1, 2, 3);
    scene.add(mesh);

    const environment = new THREE.DataTexture(
      new Float32Array([1, 0.5, 0.25, 1, 0.2, 0.3, 0.4, 1]),
      2,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;
    scene.background = environment;

    const result = fromTHREEScene(scene);
    expect(result.meshes).toHaveLength(1);
    expect(result.meshes[0].name).toBe('Converted cube');
    expect(Array.from(result.meshes[0].transform.slice(12, 15))).toEqual([1, 2, 3]);
    expect(result.meshes[0].materials[0]).toMatchObject({
      specularRoughness: 0.35,
      baseMetalness: 0.7,
      transmissionWeight: 0.4,
      specularIor: 1.45,
      transmissionDispersionScale: 0.35,
      specularAnisotropy: 0.8,
      opacity: 0.8,
      bevelSize: 0.075,
      mapAlphaUsage: "alpha"
    });
    expect(
      result.lights.some((light) => light.type === 'EnvironmentLight')
    ).toBe(true);
    expect(result.background && !Array.isArray(result.background)).toBe(true);
  });

  it.each([
    { value: 0, expected: 0 },
    { value: 0.4, expected: 0.4 },
    { value: 3, expected: 3 },
    { value: -1, expected: 0 },
    { value: NaN, expected: 0 },
    { value: Infinity, expected: 0 }
  ])('imports dispersion $value as $expected from physical materials and OpenPBR metadata', ({ value, expected }) => {
    for (const source of ['physical', 'metadata']) {
      const material = new THREE.MeshPhysicalMaterial({ transmission: 1 });
      if (source === 'physical') material.dispersion = value;
      else material.userData.mutracerOpenPBR = { transmissionDispersionScale: value };
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
      expect(fromTHREEScene(scene).meshes[0].materials[0].transmissionDispersionScale, source).toBe(expected);
    }
  });

  it('keeps the physical dispersion when OpenPBR metadata is non-finite', () => {
    const material = new THREE.MeshPhysicalMaterial({ transmission: 1, dispersion: 0.4 });
    material.userData.mutracerOpenPBR = { transmissionDispersionScale: Infinity };
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    expect(fromTHREEScene(scene).meshes[0].materials[0].transmissionDispersionScale).toBe(0.4);
  });

  it('converts Three.js projective displacement settings', () => {
    const displacementMap = new THREE.DataTexture(
      new Uint8Array([128]),
      1,
      1,
      THREE.RedFormat
    );
    const material = new THREE.MeshStandardMaterial({
      displacementMap,
      displacementScale: 0.25,
      displacementBias: -.125,
    });
    material.userData.mutracerUvProjection = 'spherical';
    material.userData.mutracerUvProjectionScale = [1.5, 2.5];
    material.userData.mutracerUvReferenceLength = 2;
    material.userData.mutracerDisplacementStepSize = 0.004;
    material.userData.mutracerDisplacementUvProjection = 'cylindrical';
    material.userData.mutracerDisplacementUvProjectionScale = 2.5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const scene = new THREE.Scene();
    scene.add(mesh);

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.displacementMap?.image).toMatchObject({width: 1, height: 1,
      data: new Uint8Array([128, 0, 0, 255])});
    expect(converted).toMatchObject({
      displacementScale: 0.25,
      displacementBias: -.125,
      uvProjection: 'spherical',
      uvProjectionScale: [1.5, 2.5],
      displacementStepSize: 0.004,
      displacementUvProjection: 'cylindrical',
      displacementUvProjectionScale: 2.5
    });
  });

  it('uses native displacement defaults before a map is assigned and preserves authored Three.js heights', () => {
    const source = new THREE.MeshStandardMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
    const defaults = new OpenPBRMaterial();
    let converted = fromTHREEScene(scene).meshes[0].materials[0];
    expect(source.displacementScale).toBe(1);
    expect(converted.displacementScale).toBe(defaults.displacementScale);
    expect(converted.displacementStepSize).toBe(0);

    source.displacementScale = .025;
    expect(fromTHREEScene(scene).meshes[0].materials[0].displacementScale).toBe(.025);
    source.displacementScale = 1;
    source.displacementMap = new THREE.DataTexture(new Uint8Array(16), 2, 2);
    converted = fromTHREEScene(scene).meshes[0].materials[0];
    expect(converted.displacementScale).toBe(1);
    source.displacementScale = 0;
    expect(fromTHREEScene(scene).meshes[0].materials[0].displacementScale).toBe(0);
  });

  it('preserves explicit small marching steps and supports automatic step metadata', () => {
    const source = new THREE.MeshStandardMaterial();
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
    source.userData.mutracerDisplacementStepSize = 1e-9;
    expect(fromTHREEScene(scene).meshes[0].materials[0].displacementStepSize).toBe(1e-9);
    source.userData.mutracerDisplacementStepSize = 0;
    expect(fromTHREEScene(scene).meshes[0].materials[0].displacementStepSize).toBe(0);
    source.userData.mutracerOpenPBR = { displacementScale: .003, displacementBias: -.001, displacementStepSize: .00002 };
    expect(fromTHREEScene(scene).meshes[0].materials[0]).toMatchObject({
      displacementScale: .003, displacementBias: -.001, displacementStepSize: .00002
    });
  });

  it('converts viewer thin-film metadata', () => {
    const material = new THREE.MeshPhysicalMaterial({ transmission: 1 });
    material.userData.mutracerOpenPBR = {
      thinWalled: true,
      thinFilmWeight: 1,
      thinFilmThickness: 0.52,
      thinFilmIor: 1.33
    };
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.thinWalled).toBe(true);
    expect(converted.thinFilmWeight).toBe(1);
    expect(converted.thinFilmThickness).toBeCloseTo(0.52);
    expect(converted.thinFilmIor).toBe(1.33);
  });

  it('uses native Three.js iridescence as a thin-film fallback', () => {
    const thinFilmMap = new THREE.Texture({
      width: 1,
      height: 1
    } as HTMLImageElement);
    const material = new THREE.MeshPhysicalMaterial();
    const iridescent = material as THREE.MeshPhysicalMaterial & {
      iridescence: number;
      iridescenceIOR: number;
      iridescenceThicknessRange: number[];
      iridescenceThicknessMap: THREE.Texture | null;
    };
    iridescent.iridescence = 0.75;
    iridescent.iridescenceIOR = 1.62;
    iridescent.iridescenceThicknessRange = [0, 680];
    iridescent.iridescenceThicknessMap = thinFilmMap;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.thinFilmWeight).toBe(0.75);
    expect(converted.thinFilmThickness).toBeCloseTo(0.68);
    expect(converted.thinFilmIor).toBe(1.62);
    expect(converted.thinFilmMap).toBeDefined();
  });

  it('keeps standalone roughness and metalness textures separate', () => {
    const roughnessMap = new THREE.Texture({
      width: 2,
      height: 2
    } as HTMLImageElement);
    const metalnessMap = new THREE.Texture({
      width: 4,
      height: 4
    } as HTMLImageElement);
    const material = new THREE.MeshStandardMaterial({
      roughnessMap,
      metalnessMap
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.metallicRoughnessMap).toBeUndefined();
    expect(converted.roughnessMap?.image).toBe(roughnessMap.image);
    expect(converted.metalnessMap?.image).toBe(metalnessMap.image);
  });

  it.each([0, 0.2, 0.5, 0.9, 1])('maps sheenRoughness %s to fuzzRoughness', (sheenRoughness) => {
    const material = new THREE.MeshPhysicalMaterial({
      sheen: 0.8, sheenRoughness, sheenColor: new THREE.Color(0.2, 0.4, 1)
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.fuzzRoughness).toBe(sheenRoughness);
    expect(converted.fuzzWeight).toBe(0.8);
    expect(converted.fuzzColor).toEqual([0.2, 0.4, 1]);
  });

  it('preserves physical sheen roughness even when the sheen layer is disabled', () => {
    const material = new THREE.MeshPhysicalMaterial({sheen: 0, sheenRoughness: 0.2});
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(), material));
    const converted = fromTHREEScene(scene).meshes[0].materials[0];
    expect(converted.fuzzWeight).toBe(0);
    expect(converted.fuzzRoughness).toBe(0.2);
  });

  it.each([0, 0.4, 1])('imports clearcoat %s without internal-reflection darkening', (clearcoat) => {
    const material = new THREE.MeshPhysicalMaterial({clearcoat, clearcoatRoughness: 0.2});
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(), material));

    expect(fromTHREEScene(scene).meshes[0].materials[0]).toMatchObject({
      coatWeight: clearcoat,
      coatRoughness: 0.2,
      coatIor: 1.5,
      coatDarkening: 0
    });
  });

  it.each([0, 0.8, 1])('lets OpenPBR metadata override imported coatDarkening with %s', (coatDarkening) => {
    const material = new THREE.MeshPhysicalMaterial({clearcoat: 1});
    material.userData.mutracerOpenPBR = {coatDarkening};
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(), material));

    expect(fromTHREEScene(scene).meshes[0].materials[0].coatDarkening).toBe(coatDarkening);
  });

  it('keeps glTF specular off fully metallic materials only', () => {
    const convert = (params: THREE.MeshPhysicalMaterialParameters, metalnessMap = false) => {
      const material = new THREE.MeshPhysicalMaterial({
        specularIntensity: 0,
        specularColor: new THREE.Color(0.2, 0.4, 0.6),
        specularIntensityMap: new THREE.Texture(),
        specularColorMap: new THREE.Texture(),
        ...params
      });
      if (metalnessMap) material.metalnessMap = new THREE.Texture();
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
      return fromTHREEScene(scene).meshes[0].materials[0];
    };
    // KHR_materials_specular does not affect the glTF metal BRDF.
    const metal = convert({metalness: 1});
    expect(metal.specularWeight).toBe(1);
    expect(metal.specularColor).toEqual(new OpenPBRMaterial().specularColor);
    expect(metal.specularWeightMap).toBeUndefined();
    expect(metal.specularColorMap).toBeUndefined();
    // No single OpenPBR value matches a dielectric/metal blend, so these keep the source.
    for (const material of [convert({metalness: 0.5}), convert({metalness: 1}, true)]) {
      expect(material.specularWeight).toBe(0);
      expect(material.specularColor[0]).toBeCloseTo(0.2);
      expect(material.specularWeightMap).toBeDefined();
      expect(material.specularColorMap).toBeDefined();
    }
  });

  it('converts canonical viewer OpenPBR metadata', () => {
    const material = new THREE.MeshPhysicalMaterial({
      transmission: 0.7,
      attenuationColor: new THREE.Color(0x80a0c0),
      attenuationDistance: 2.5,
      clearcoat: 0.4,
      sheen: 0.3,
      sheenRoughness: 0.2
    });
    material.userData.mutracerOpenPBR = {
      baseWeight: 0.8,
      baseDiffuseRoughness: 0.2,
      specularWeight: 0.9,
      specularColor: [0.9, 0.8, 0.7],
      transmissionScatter: [0.1, 0.2, 0.3],
      transmissionScatterAnisotropy: 0.35,
      transmissionDispersionScale: 0.45,
      transmissionDispersionAbbeNumber: 32,
      subsurfaceWeight: 0.6,
      subsurfaceColor: [0.8, 0.3, 0.2],
      subsurfaceRadius: 0.25,
      subsurfaceRadiusScale: [1, 0.5, 0.25],
      subsurfaceAnisotropy: 0.15,
      coatColor: [0.95, 0.9, 0.85],
      coatIor: 1.7,
      coatDarkening: 0.8,
      fuzzColor: [0.7, 0.2, 0.1],
      fuzzRoughness: 0.55,
      thinWalled: true,
      thinFilmWeight: 1,
      thinFilmThickness: 0.45,
      thinFilmIor: 1.4
    };
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted).toMatchObject({
      baseWeight: 0.8,
      baseDiffuseRoughness: 0.2,
      specularWeight: 0.9,
      transmissionWeight: 0.7,
      transmissionDepth: 2.5,
      transmissionScatter: [0.1, 0.2, 0.3],
      transmissionScatterAnisotropy: 0.35,
      transmissionDispersionScale: 0.45,
      transmissionDispersionAbbeNumber: 32,
      subsurfaceWeight: 0.6,
      subsurfaceRadius: 0.25,
      subsurfaceAnisotropy: 0.15,
      coatWeight: 0.4,
      coatIor: 1.7,
      coatDarkening: 0.8,
      fuzzWeight: 0.3,
      fuzzRoughness: 0.55,
      thinWalled: true,
      thinFilmWeight: 1,
      thinFilmThickness: 0.45,
      thinFilmIor: 1.4
    });
  });

  it('keeps textured physical transmission independent from base-color alpha', () => {
    const map = new THREE.Texture({ width: 1, height: 1 } as HTMLImageElement);
    const transmissionMap = new THREE.Texture({
      width: 2,
      height: 2
    } as HTMLImageElement);
    transmissionMap.repeat.set(4, 5);
    map.repeat.set(2.5, 3);
    map.offset.set(0.2, -0.1);
    const material = new THREE.MeshPhysicalMaterial({
      map,
      transmissionMap,
      transmission: 0.8,
      metalness: 0,
      transparent: false
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.transmissionWeight).toBe(0.8);
    expect(converted.transmissionMap?.image).toBe(transmissionMap.image);
    expect(converted.transmissionMap?.uvScale).toEqual([4, 5]);
    expect(converted.map).toBeDefined();
    expect(converted.map?.uvScale).toEqual([2.5, 3]);
    expect(converted.map?.uvOffset).toEqual([0.2, -0.1]);
    expect(converted.mapAlphaUsage).toBe(
      "opaque"
    );
  });

  it('converts a standalone alpha map and cutoff for path tracing', () => {
    const alphaMap = new THREE.Texture({
      width: 2,
      height: 2
    } as HTMLImageElement);
    alphaMap.repeat.set(3, 4);
    const material = new THREE.MeshStandardMaterial({
      alphaMap,
      alphaTest: 0.35,
      transparent: true
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.alphaMap?.image).toBe(alphaMap.image);
    expect(converted.alphaMap?.uvScale).toEqual([3, 4]);
    expect(converted.alphaCutoff).toBe(0.35);
    expect(converted.alphaMode).toBe('mask');
    expect(converted.mapAlphaUsage).toBe(
      "alpha"
    );
  });

  it('preserves Three.js double-sided materials for path tracing', () => {
    const material = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.doubleSided).toBe(true);
  });

  it('converts a tagged Three shadow material to a shadow catcher', () => {
    const material = new THREE.ShadowMaterial();
    material.userData.mutracerShadowCatcher = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));

    const converted = fromTHREEScene(scene).meshes[0].materials[0];

    expect(converted.shadowCatcher).toBe(true);
  });

  it('clamps invalid shader bevel radii during conversion', () => {
    const material = new THREE.MeshStandardMaterial();
    material.userData.mutracerBevelSize = -2;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

    expect(fromTHREEScene(scene).meshes[0].materials[0].bevelSize).toBe(0);

    material.userData.mutracerBevelSize = Number.NaN;
    expect(fromTHREEScene(scene).meshes[0].materials[0].bevelSize).toBe(0);
  });

  it('maps Three analytic lights to path tracer lights', () => {
    const scene = new THREE.Scene();
    const rect = new THREE.RectAreaLight(0xffffff, 10, 2, 3);
    rect.position.set(1, 2, 3);
    const point = new THREE.PointLight(0xff0000, 4);
    point.position.set(4, 5, 6);
    point.userData.mutracerRadius = 0.75;
    const directional = new THREE.DirectionalLight(0x00ff00, 2);
    directional.position.set(3, 4, 5);
    scene.add(rect, point, directional, directional.target);

    const result = fromTHREEScene(scene);
    expect(result.lights.map((light) => light.type)).toEqual([
      'RectLight',
      'SphereLight',
      'DirectionalLight'
    ]);
    expect(result.lights[1]).toMatchObject({ radius: 0.75, intensity: 4 });
  });

  it('keeps the existing unparented directional light vector', () => {
    const scene = new THREE.Scene();
    const light = new THREE.DirectionalLight();
    light.position.set(3, 4, 5);
    light.target.position.set(-1, 2, 0);
    scene.add(light, light.target);
    const converted = fromTHREEScene(scene).lights[0];
    if(converted.type !== 'DirectionalLight') throw Error('missing sun');
    expect(converted.position).toEqual([3,4,5]);
    getLightDirection(converted).forEach((value,i)=>expect(value).toBeCloseTo([-4,-2,-5][i]/Math.hypot(4,2,5)));
  });

  it('resolves directional light and independently parented target in world coordinates', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Group(), targetParent = new THREE.Group();
    parent.matrixAutoUpdate = false;
    parent.matrix.set(0, -3, 0, 10, 2, 0, 0, 20, 0, 0, 4, 30, 0, 0, 0, 1);
    targetParent.matrixAutoUpdate = false;
    targetParent.matrix.set(0, 0, 7, -4, 0, 6, 0, 5, -5, 0, 0, -6, 0, 0, 0, 1);
    targetParent.matrixWorldNeedsUpdate = true;
    const light = new THREE.DirectionalLight();
    light.position.set(1, 0, 0); light.target.position.set(0, 0, 1);
    parent.add(light); targetParent.add(light.target); scene.add(parent);
    // The target's parent need not be part of the rendered scene.
    const converted = fromTHREEScene(scene).lights[0];
    if(converted.type !== 'DirectionalLight') throw Error('missing sun');
    expect(converted.position).toEqual([10,22,30]);
    getLightDirection(converted).forEach((value,i)=>expect(value).toBeCloseTo([-7,-17,-36][i]/Math.hypot(7,17,36)));
  });

  it('preserves a rotated source sun with a child target under a nonuniform parent', () => {
    const scene = new THREE.Scene(), parent = new THREE.Group();
    parent.position.set(4, 2, 7); parent.scale.set(2, 0.6, 1.2);
    parent.rotation.set(0.3, -0.4, 0.1); scene.add(parent);
    const light = new THREE.DirectionalLight(); parent.add(light);
    light.position.set(1.1, 2.2, 3.3); light.scale.set(0.9, 1.1, 1.2);
    const raw = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 0.2, 0.9))
      .toArray().map((value) => -value * (1 + 3e-10));
    light.quaternion.fromArray(raw); light.color.setRGB(1.234567891, 0.456789123, 0.234567891);
    light.add(light.target); light.target.position.set(0, 0, -1);
    scene.updateMatrixWorld(true);
    const origin = new THREE.Vector3().applyMatrix4(light.matrixWorld);
    const endpoint = new THREE.Vector3(0, 0, -1).applyMatrix4(light.matrixWorld);
    const expected = origin.sub(endpoint).toArray();
    const converted = fromTHREEScene(scene).lights[0];
    expect(converted).toMatchObject({ type: 'DirectionalLight',
      color: light.color.toArray(), intensity: light.intensity });
    if(converted.type !== 'DirectionalLight') throw Error('missing sun');
    expect(converted.position).toEqual(light.getWorldPosition(new THREE.Vector3()).toArray());
    getLightDirection(converted).forEach((value,i)=>expect(value).toBeCloseTo(-expected[i]/Math.hypot(...expected)));
    expect(light.quaternion.toArray()).toEqual(raw);
    expect(light.target.position.toArray()).toEqual([0, 0, -1]);
  });

  it.each([[2, 2, 2], [1.5, 0.6, 1.2], [-1.5, 0.6, 1.2]])(
    'keeps the approximated Rect sampling frame rigid under parent scale %j', (...scale) => {
      const scene = new THREE.Scene(), parent = new THREE.Group();
      parent.scale.fromArray(scale); parent.rotation.set(0.2, 0.4, 0.1); scene.add(parent);
      const rect = new THREE.RectAreaLight(0xffffff, 4, 1.5, 0.8); parent.add(rect);
      rect.position.set(1.234567891, 2.345678912, 3.456789123);
      rect.color.setRGB(1.234567891, 0.789123456, 0.345678912);
      rect.quaternion.setFromEuler(new THREE.Euler(-0.9, 0.3, 0.4));
      const raw = rect.quaternion.toArray().map((value) => -value * (1 + 3e-10));
      rect.quaternion.fromArray(raw); scene.updateMatrixWorld(true);
      const world = rect.matrixWorld.toArray(), local = rect.matrix.toArray();
      const result = fromTHREEScene(scene).lights[0];
      if (result.type !== 'RectLight') throw new Error('Expected RectLight');
      expect(result.size).toEqual([
        rect.width * Math.hypot(world[0], world[1], world[2]),
        rect.height * Math.hypot(world[4], world[5], world[6])
      ]);
      expect(result.color).toEqual(rect.color.toArray()); expect(result.intensity).toBe(4);
      const matrix = result.transform;
      const x = new THREE.Vector3(matrix[0], matrix[1], matrix[2]);
      const y = new THREE.Vector3(matrix[4], matrix[5], matrix[6]);
      const doubleRoundoff = 64 * Number.EPSILON;
      expect(Math.abs(x.lengthSq() - 1)).toBeLessThanOrEqual(doubleRoundoff);
      expect(Math.abs(y.lengthSq() - 1)).toBeLessThanOrEqual(doubleRoundoff);
      expect(Math.abs(x.dot(y))).toBeLessThanOrEqual(doubleRoundoff);
      expect(Math.abs(x.clone().cross(y).length() - 1)).toBeLessThanOrEqual(doubleRoundoff);
      // Renderer sampling vectors are packed through Float32Array. Verify the
      // actual packed geometry against the PDF area within float32 roundoff.
      const u = new THREE.Vector3(...getRectLightUOrV(result, 0));
      const v = new THREE.Vector3(...getRectLightUOrV(result, 1));
      expect(Math.abs(u.cross(v).length() / getRectLightArea(result) - 1)).toBeLessThanOrEqual(16 * 2 ** -23);
      expect(matrix.slice(12, 15)).toEqual(world.slice(12, 15));
      expect(rect.quaternion.toArray()).toEqual(raw);
      expect(rect.matrix.toArray()).toEqual(local); expect(rect.matrixWorld.toArray()).toEqual(world);
      expect(rect.parent).toBe(parent);
    }
  );

  it('uses effective rectangle dimensions under rotated nonuniform parents', () => {
    for (const scale of [[2, 2, 2], [2, 3, 1]]) {
      const scene = new THREE.Scene();
      const parent = new THREE.Group();
      parent.scale.fromArray(scale);
      parent.rotation.z = 0.3;
      scene.add(parent);
      const rect = new THREE.RectAreaLight(0xffffff, 4, 1.5, 0.8);
      rect.rotation.z = 0.4;
      parent.add(rect);
      scene.updateMatrixWorld(true);
      const matrix = rect.matrixWorld.elements;
      const width = 1.5 * Math.hypot(matrix[0], matrix[1], matrix[2]);
      const height = 0.8 * Math.hypot(matrix[4], matrix[5], matrix[6]);
      const converted = fromTHREEScene(scene).lights[0];
      expect(converted.type).toBe('RectLight');
      if (converted.type !== 'RectLight') return;
      expect(converted.size[0]).toBeCloseTo(width);
      expect(converted.size[1]).toBeCloseTo(height);
      const convertedMatrix = converted.transform;
      expect(Math.hypot(convertedMatrix[0], convertedMatrix[1], convertedMatrix[2]))
        .toBeCloseTo(1);
      expect(Math.hypot(convertedMatrix[4], convertedMatrix[5], convertedMatrix[6]))
        .toBeCloseTo(1);
    }
  });

  it('converts half-float HDR data without flipping source rows', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(
      new Uint16Array([
        0x3c00, 0x3800, 0x3400, 0x3c00,
        0x3400, 0x3800, 0x3c00, 0x3c00
      ]),
      1,
      2,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    environment.flipY = true;
    scene.environment = environment;
    scene.background = environment;

    const result = fromTHREEScene(scene);
    const environmentLight = result.lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    expect(environmentLight?.type).toBe('EnvironmentLight');
    if (!environmentLight || environmentLight.type !== 'EnvironmentLight') return;

    const image = environmentLight.map.image as {
      data: Float32Array;
      width: number;
      height: number;
    };
    expect(image.data).toBeInstanceOf(Float32Array);
    expect(Array.from(image.data.slice(0, 4))).toEqual([1, 0.5, 0.25, 1]);
    expect(result.background).toBe(environmentLight.map);
  });

  it('reorders Three.js equirect rows so the sky comes first', () => {
    const sky = [0.5, 0.5, 0.5, 1], ground = [0, 0, 0, 1];
    const convertFirstRow = (rows: number[][], flipY: boolean) => {
      const scene = new THREE.Scene();
      const source = new Float32Array(rows.flat());
      const environment = new THREE.DataTexture(source, 1, 2, THREE.RGBAFormat, THREE.FloatType);
      environment.flipY = flipY;
      scene.environment = environment;
      const light = fromTHREEScene(scene).lights.find((light) => light.type === 'EnvironmentLight');
      if (!light || light.type !== 'EnvironmentLight') throw new Error('missing environment');
      expect(Array.from(source)).toEqual(rows.flat());
      return Array.from((light.map.image as { data: Float32Array }).data.slice(0, 4));
    };
    // flipY = false: Three.js samples row 0 at v = 0, the nadir.
    expect(convertFirstRow([ground, sky], false)).toEqual(sky);
    // flipY = true (HDRLoader): row 0 is already the top.
    expect(convertFirstRow([sky, ground], true)).toEqual(sky);
  });

  it.each(['environment', 'background', 'grounded'] as const)(
    'keeps a shared material texture independent of its %s conversion',
    (target) => {
      for (const flipY of [false, true]) {
        const scene = new THREE.Scene();
        const rows = [
          [0, 0, 0, 1, 0.125, 0, 0, 1],
          [0.5, 0.25, 0.125, 1, 1, 0.5, 0.25, 1]
        ];
        const pixels = new Float32Array(rows.flat());
        const texture = new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat, THREE.FloatType);
        texture.flipY = flipY;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({map: texture})));
        if (target === 'environment') scene.environment = scene.background = texture;
        else if (target === 'background') scene.background = texture;
        else scene.userData.mutracerGroundedSkybox = {texture, height: 1.7, radius: 40};

        const result = fromTHREEScene(scene);
        const background = result.background;
        if (!background || Array.isArray(background)) throw new Error('missing textured background');
        const equirect = 'map' in background ? background.map : background;
        const materialMap = result.meshes[0].materials[0].map!;
        expect(equirect.flipY).toBe(false);
        expect(equirect.image).toEqual({
          data: new Float32Array((flipY ? rows : [rows[1], rows[0]]).flat()), width: 2, height: 2
        });
        expect(materialMap.image).toBe(texture.image);
        expect(materialMap.flipY).toBe(flipY);
        expect(equirect).not.toBe(materialMap);
        expect(Array.from(pixels)).toEqual(rows.flat());
        expect(texture.flipY).toBe(flipY);
        if (target === 'environment') {
          const light = result.lights.find(light => light.type === 'EnvironmentLight');
          expect(light?.map).toBe(equirect);
        }
      }
    }
  );

  it('creates fresh one-shot environment lights and reads the current version', () => {
    const scene = new THREE.Scene();
    const pixels = new Float32Array([1, 0.5, 0.25, 1]);
    const environment = new THREE.DataTexture(
      pixels,
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;

    const first = fromTHREEScene(scene).lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    const second = fromTHREEScene(scene).lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    expect(second).not.toBe(first);

    pixels[0] = 0.25;
    environment.needsUpdate = true;
    const updated = fromTHREEScene(scene).lights.find(
      (light) => light.type === 'EnvironmentLight'
    );
    expect(updated).not.toBe(first);
    expect(updated?.type).toBe('EnvironmentLight');
    if (!updated || updated.type !== 'EnvironmentLight') return;
    expect(updated.map.version).toBe(environment.version);
    expect((updated.map.image as { data: Float32Array }).data[0]).toBe(0.25);
  });

  it('converts grounded skybox metadata without treating its preview mesh as geometry', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(
      new Float32Array([1, 0.5, 0.25, 1]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;
    scene.userData.mutracerGroundedSkybox = {
      texture: environment,
      height: 1.7,
      radius: 40,
      groundHeight: -0.25,
      center: [2, 3]
    };
    const preview = new THREE.Mesh(
      new THREE.SphereGeometry(),
      new THREE.MeshBasicMaterial()
    );
    preview.userData.viewerEnvironment = true;
    scene.add(preview);

    const result = fromTHREEScene(scene);

    expect(result.meshes).toHaveLength(0);
    expect(result.background).toMatchObject({
      type: 'GroundedSkybox',
      height: 1.7,
      radius: 40,
      groundHeight: -0.25,
      center: [2, 3]
    });
  });

  it('ignores viewer realtime displacement proxy meshes', () => {
    const scene = new THREE.Scene();
    const source = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial()
    );
    const proxy = source.clone();
    proxy.userData.viewerRealtimeDisplacement = true;
    scene.add(source, proxy);

    expect(fromTHREEScene(scene).meshes).toHaveLength(1);
  });

  it('keeps environment lighting while explicitly hiding the background', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(
      new Float32Array([1, 0.5, 0.25, 1]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    scene.environment = environment;
    scene.background = null;
    scene.userData.mutracerHiddenBackground = true;

    const result = fromTHREEScene(scene);

    expect(result.lights.some((light) => light.type === 'EnvironmentLight')).toBe(true);
    expect(result.background).toEqual([0, 0, 0, 0]);
  });

  it('splits grouped Three meshes into path tracer primitives', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-1, 0, 0, 0, 0, 0, -1, 1, 0, 0, 1, 0],
        3
      )
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    const mesh = new THREE.Mesh(geometry, [
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      new THREE.MeshStandardMaterial({ color: 0x00ff00 })
    ]);
    const scene = new THREE.Scene();
    scene.add(mesh);

    const result = fromTHREEScene(scene);
    expect(result.meshes).toHaveLength(2);
    expect(result.meshes[0].geometry.indices.array).toHaveLength(3);
    expect(result.meshes[1].materials[0].baseColor).toEqual([0, 1, 0]);
  });

  it('preserves shared texture references across converted mesh materials', () => {
    const image = { width: 4, height: 4 } as HTMLImageElement;
    const texture = new THREE.Texture(image);
    const material = new THREE.MeshStandardMaterial({ map: texture });
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(new THREE.BoxGeometry(), material),
      new THREE.Mesh(new THREE.SphereGeometry(), material)
    );

    const result = fromTHREEScene(scene);

    expect(result.meshes).toHaveLength(2);
    expect(result.meshes[0].materials[0]).toBe(
      result.meshes[1].materials[0]
    );
    expect(result.meshes[0].materials[0].map).toBe(
      result.meshes[1].materials[0].map
    );
  });

  it('retains converted geometry and BVH while syncing transforms', () => {
    const scene = new THREE.Scene();
    const sourceGeometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(
      sourceGeometry,
      new THREE.MeshStandardMaterial()
    );
    scene.add(mesh);
    const sync = initializedSync(scene);
    const first = sync.scene;
    const firstGeometry = first.meshes[0].geometry;
    setGeometryBvh(first.meshes[0].geometry, {
      buffer: new ArrayBuffer(32),
      maxDepth: 1
    });
    mesh.position.x = 2;
    mesh.updateMatrixWorld(true);
    sync.update();
    const second = sync.scene;

    expect(second.meshes[0].geometry).toBe(firstGeometry);
    expect(getGeometryBvh(second.meshes[0].geometry)).toBe(getGeometryBvh(first.meshes[0].geometry));
    expect(second.meshes[0].transform[12]).toBe(2);
  });

  it('uses triplanar displacement automatically for a UV-less mesh', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    geometry.setIndex([0, 1, 2]);
    const material = new THREE.MeshStandardMaterial();
    material.displacementMap = new THREE.DataTexture(
      new Uint8Array([0, 255, 255, 0]),
      2,
      2,
      THREE.RedFormat
    );
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));

    const converted = fromTHREEScene(scene).meshes[0];

    expect(converted.geometry.uv).toBeUndefined();
    expect(converted.materials[0].displacementUvProjection).toBe('triplanar');
  });

  it('uses shared triplanar projection automatically for textures on a UV-less mesh', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    geometry.setIndex([0, 1, 2]);
    const material = new THREE.MeshStandardMaterial({
      map: new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]),
        1,
        1
      )
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));

    const converted = fromTHREEScene(scene).meshes[0];

    expect(converted.geometry.uv).toBeUndefined();
    expect(converted.materials[0].uvProjection).toBe('triplanar');
  });
});

describe('Three.js camera conversion', () => {
  it('preserves orthographic bounds in constructor order', () => {
    const source = new THREE.OrthographicCamera(-4, 6, 3, -2, 0.1, 100);
    source.zoom = 2;
    const camera = fromTHREECamera(source);
    expect(camera).toMatchObject({
      left: -4,
      right: 6,
      top: 3,
      bottom: -2,
      zoom: 2,
      near: 0.1,
      far: 100
    });
  });

  it('converts THREE.SpotLight target, cone, radius, range, and IES metadata', () => {
    const scene = new THREE.Scene();
    const light = new THREE.SpotLight(0xff8040, 12, 20, Math.PI / 3, 0.25);
    light.position.set(1, 3, 2);
    light.target.position.set(1, 1, 2);
    light.userData.mutracerRadius = 0.05;
    light.userData.mutracerIesRotation = 30;
    light.userData.mutracerIesProfile = parseIESProfile([
      'IESNA:LM-63-1995', 'TILT=NONE', '1 1 1 2 1 1 1 0 0 0',
      '1 1 1', '0 90', '0', '1 0'
    ].join('\n'));
    scene.add(light, light.target);
    const converted = fromTHREEScene(scene).lights.find((item) => item.type === 'SpotLight');
    expect(converted).toMatchObject({
      type: 'SpotLight',
      intensity: 12,
      radius: 0.05
    });
    if (converted?.type !== 'SpotLight') throw new Error('missing converted spot light');
    expect(converted.position).toEqual([1,3,2]);
    expect(getLightDirection(converted)).toEqual([0,-1,0]);
    expect(converted).not.toHaveProperty('range'); expect(converted).not.toHaveProperty('iesRotation');
    expect(converted.innerAngle).toBeCloseTo(45);
    expect(converted.outerAngle).toBeCloseTo(60);
  });

  it('copies orthographic projection state into a reusable camera', () => {
    const source = fromTHREECamera(
      Object.assign(new THREE.OrthographicCamera(-3, 5, 4, -2), {
        zoom: 1.5
      })
    );
    const target = new Camera({projection: 'perspective'});
    source.fStop = 2.8;
    source.focusDistance = 6.5;
    source.sensorHeight = 15.6;
    source.metersPerUnit = 0.01;
    target.copy(source);

    expect(target).toMatchObject({
      projection: 'orthographic',
      left: -3,
      right: 5,
      top: 4,
      bottom: -2,
      zoom: 1.5,
      fStop: 2.8,
      focusDistance: 6.5,
      sensorHeight: 15.6,
      metersPerUnit: 0.01
    });
  });

  it('converts Three.js focus and film height into lens settings', () => {
    const three = new THREE.PerspectiveCamera(40, 2, 0.1, 100);
    three.focus = 3.5;
    three.filmGauge = 36;
    const camera = fromTHREECamera(three, { fStop: 4 });

    expect(camera.focusDistance).toBe(3.5);
    // Three.js applies the film gauge to the larger frame dimension.
    expect(camera.sensorHeight).toBeCloseTo(18);
    expect(camera.sensorHeight).toBeCloseTo(three.getFilmHeight());
    expect(camera.fov).toBe(three.fov);
    expect(camera.fStop).toBe(4);
    expect(fromTHREECamera(three, { focusDistance: 2, metersPerUnit: 0.01 }))
      .toMatchObject({ focusDistance: 2, metersPerUnit: 0.01, fStop: 0 });
  });
});

it('reads only the renamed displacement projection scale userData key', () => {
 const material=new THREE.MeshStandardMaterial();material.userData.mutracerDisplacementUvScale=7;
 const scene=new THREE.Scene();scene.add(new THREE.Mesh(new THREE.BoxGeometry(),material));
 expect(fromTHREEScene(scene).meshes[0].materials[0].displacementUvProjectionScale).toBe(1);
 material.userData.mutracerDisplacementUvProjectionScale=3;
 expect(fromTHREEScene(scene).meshes[0].materials[0].displacementUvProjectionScale).toBe(3);
});

function initializedSync(scene: THREE.Scene, options: import('../../src/util/fromTHREE').FromTHREESceneOptions = {}) {
  const sync = new THREESync(new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}), {scene, ...options});
  sync.update(); return sync as THREESync & {scene: NonNullable<THREESync['scene']>};
}

describe('one-shot conversion hooks', () => {
  it('uses default material and light conversion when hooks return undefined', () => {
    const source = new THREE.Scene();
    source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({color: 0x123456})), new THREE.PointLight(0xffffff, 3));
    const ordinary = fromTHREEScene(source);
    const fallback = fromTHREEScene(source, {convertMaterial: () => undefined, convertLight: () => undefined});
    expect(fallback).toEqual(ordinary);
  });
  it('supports custom shaders/lights, skips null sources and reruns on each conversion', () => {
    const source = new THREE.Scene(); const material = new THREE.ShaderMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const light = new THREE.HemisphereLight(); source.add(mesh, light);
    const customMaterial = new OpenPBRMaterial({baseColor: [.1,.2,.3]});
    const customLight = new SphereLight({radius: .4});
    const convertMaterial = vi.fn(() => customMaterial); const convertLight = vi.fn(() => customLight);
    const a = fromTHREEScene(source, {convertMaterial, convertLight});
    const b = fromTHREEScene(source, {convertMaterial, convertLight});
    expect(a.meshes[0].materials[0]).toBe(customMaterial); expect(b.meshes[0].materials[0]).toBe(customMaterial);
    expect(a.lights[0]).toBe(customLight); expect(b.lights[0]).toBe(customLight);
    expect(convertMaterial).toHaveBeenCalledTimes(2); expect(convertMaterial).toHaveBeenCalledWith(material);
    expect(convertLight).toHaveBeenCalledTimes(2); expect(convertLight).toHaveBeenCalledWith(light);
    expect(fromTHREEScene(source, {convertMaterial: () => null, convertLight: () => null})).toMatchObject({meshes: [], lights: []});
  });
  it('skips all groups and instances when any material hook returns null', () => {
    const source = new THREE.Scene(); const materials = [new THREE.MeshStandardMaterial(), new THREE.ShaderMaterial()];
    source.add(new THREE.InstancedMesh(new THREE.BoxGeometry(), materials, 2));
    expect(fromTHREEScene(source, {convertMaterial: m => m === materials[1] ? null : undefined}).meshes).toEqual([]);
  });
});
