import type { Inspection } from '../../../tools/pbrt/source';
import { showToast, useViewer } from '../store';
// Conservative import budget: encoded geometry/textures can expand several times
// before the BVH and GPU copy exist simultaneously. This is advisory: encoded
// size cannot establish whether a scene fits the current browser and device.
export function checkPbrtMemory(report: Pick<Inspection, 'totalBytes' | 'unknownSizes'>) {
  if (report.unknownSizes) throw new Error('Scene download size is unknown; include all files locally to check its memory requirements');
  return report.totalBytes * 8;
}

export async function confirmPbrtImport(report: Pick<Inspection, 'totalBytes' | 'unknownSizes'>, remote: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const estimatedBytes = checkPbrtMemory(report);
  const highMemory = estimatedBytes > 8 * 1024 ** 3;
  if (!highMemory && (!remote || report.totalBytes < 1_000_000_000)) return;
  const message = highMemory
    ? `This scene may need about ${(estimatedBytes / 1024 ** 3).toFixed(1)} GiB of working memory, above the 8 GiB warning threshold. Loading may exhaust browser or GPU memory.`
    : `This scene downloads ${(report.totalBytes / 1e9).toFixed(2)} GB and needs several times that in memory.`;
  await new Promise<void>((resolve, reject) => {
    let settled = false, unsubscribe = () => {};
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true; unsubscribe(); signal?.removeEventListener('abort', cancel);
      accepted ? resolve() : reject(new Error('Scene loading cancelled'));
    };
    const cancel = () => finish(false);
    showToast(message, 'warning', [
      { label: highMemory ? 'Load anyway' : 'Load scene', onClick: () => finish(true) },
      { label: 'Cancel', onClick: cancel }
    ]);
    const id = useViewer.getState().toast?.id;
    unsubscribe = useViewer.subscribe(state => { if (state.toast?.id !== id) cancel(); });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
