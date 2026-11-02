import type { Inspection } from '../../../tools/pbrt/source';
// Conservative import budget: encoded geometry/textures can expand several times
// before the BVH and GPU copy exist simultaneously. Reject before binary fetches.
export function checkPbrtMemory(report: Pick<Inspection, 'totalBytes' | 'unknownSizes'>) {
  if (report.unknownSizes) throw new Error('Scene download size is unknown; include all files locally to check its memory requirements');
  if (report.totalBytes * 8 > 8 * 1024 ** 3) throw new Error(`Estimated scene working set is ${(report.totalBytes * 8 / 1024 ** 3).toFixed(1)} GB of working memory; the browser import budget is 8 GB. No binary assets were downloaded.`);
}
