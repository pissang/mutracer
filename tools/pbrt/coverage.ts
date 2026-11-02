export type Coverage = 'supported' | 'approximate' | 'skipped';
export const FEATURE_COVERAGE: Record<string, Record<string, Coverage>> = {
  materials: { diffuse: 'supported', conductor: 'supported', dielectric: 'supported', thindielectric: 'supported', interface: 'supported', '': 'supported', coateddiffuse: 'approximate', coatedconductor: 'approximate', subsurface: 'approximate', diffusetransmission: 'approximate', mix: 'approximate', hair: 'approximate', measured: 'approximate' },
  shapes: { trianglemesh: 'supported', plymesh: 'supported', bilinearmesh: 'supported', sphere: 'approximate', disk: 'approximate', cylinder: 'approximate', loopsubdiv: 'approximate', curve: 'skipped' },
  lights: { point: 'supported', spot: 'supported', distant: 'supported', infinite: 'supported', diffuse: 'supported', goniometric: 'skipped', projection: 'skipped' },
  media: { homogeneous: 'approximate', uniformgrid: 'skipped', rgbgrid: 'skipped', nanovdb: 'skipped', cloud: 'skipped' },
  textures: { imagemap: 'supported', constant: 'supported', scale: 'supported', checkerboard: 'supported' },
  cameras: { perspective: 'supported', orthographic: 'supported', realistic: 'approximate', spherical: 'approximate' }
};
