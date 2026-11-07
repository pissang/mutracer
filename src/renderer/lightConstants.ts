export const LIGHT_CHOICE_ENVIRONMENT = 1;
export const LIGHT_CHOICE_ANALYTIC = 2;
export const LIGHT_CHOICE_EMISSIVE_TRIANGLE = 3;

export const LIGHT_DOMAIN_ENVIRONMENT = 0;
export const LIGHT_DOMAIN_INFINITE = 1;
export const LIGHT_DOMAIN_LOCAL_AND_EMISSIVE = 2;
/** Portable analytic-light limit shared by WebGPU storage and the WebGL light-data texture. */
export const MAX_ANALYTIC_LIGHTS = 1024;
export const CONSTANT_DIRECTIONAL_LIGHT = 1;
export const CONSTANT_SPHERE_LIGHT = 2;
export const CONSTANT_RECT_LIGHT = 3;
export const CONSTANT_SPOT_LIGHT = 4;
export const CONSTANT_DISK_LIGHT = 5;
export const CONSTANT_CYLINDER_LIGHT = 6;
