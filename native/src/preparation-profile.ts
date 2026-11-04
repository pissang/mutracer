// Diagnostics only: no clock reads or mark allocation outside profile runs.
let enabled = false;
let marks: {stage: string; epochMs: number}[] = [];
export function preparationMark(stage: string) {
  if (enabled) marks.push({stage, epochMs: Date.now()});
}
export function preparationProfile(on: number): Uint8Array {
  const result = new TextEncoder().encode(JSON.stringify({nativeCoreProfile: marks}));
  marks = []; enabled = on !== 0;
  return result;
}
