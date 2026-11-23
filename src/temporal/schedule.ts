export type TemporalMode = 'offline' | 'interactive';

export interface TemporalScheduleOptions {
  mode: TemporalMode;
  historyRadius: {min: number; max: number};
  postRadius: number;
}

export function temporalLatency(options: TemporalScheduleOptions) {
  return options.mode === 'offline' ? options.historyRadius.max + options.postRadius : 0;
}

export function hasTemporalFrameGap(previous: number | undefined, current: number) {
  return previous !== undefined && current !== previous + 1;
}

export function isTemporalCameraCut(surfacePixels: number, acceptedPixels: number) {
  return surfacePixels === 0 || acceptedPixels / surfacePixels < 0.1;
}

export function readyThrough(pushed: number, options: TemporalScheduleOptions, flushing = false) {
  if (pushed < 1) return -1;
  return flushing || options.mode === 'interactive'
    ? pushed - 1
    : pushed - 1 - temporalLatency(options);
}

export function historyNeighbors(index: number, count: number, options: TemporalScheduleOptions, radius: number) {
  const result: number[] = [];
  for (let delta = 1; delta <= radius; delta++) {
    const past = index - delta;
    if (past >= 0) result.push(past);
    const future = index + delta;
    if (options.mode === 'offline' && future < count) result.push(future);
  }
  return result;
}
