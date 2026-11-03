import type { Resolver, Resource } from './source';
/** Bound network fan-out while the caller's resolver retains downloaded files. */
export async function prefetchResources(resources: Resource[], resolver: Resolver, concurrency = 6): Promise<void> {
  const paths = [...new Set(resources.filter(resource => resource.kind !== 'text').map(resource => resource.path))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (next < paths.length) await resolver.read(paths[next++]);
  }));
}
