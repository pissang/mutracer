/** Backend bounds on configured scattering depth and total path-loop events. */
export const MAX_PATH_EVENTS_WGPU = 50;
export const MAX_PATH_EVENTS_WEBGL = 20;

/** Round and clamp depth; the legacy/native default stays 20. NaN selects 1. */
export function normalizeBounces(bounces: number, maxPathEvents = MAX_PATH_EVENTS_WEBGL): number {
  return Math.min(maxPathEvents, Math.max(1, Number.isNaN(bounces) ? 1 : Math.round(bounces)));
}
