// Inspect actual archive entries, including metadata added by archivers.
export function checkArchiveEntries(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw Error('SDK archive is empty');
  const invalid = entries.filter(entry => entry.replaceAll('\\', '/').split('/')
    .some(part => part === '__MACOSX' || part.startsWith('._')));
  if (invalid.length) throw Error(`AppleDouble metadata in archive: ${invalid.join(', ')}`);
  return entries;
}
