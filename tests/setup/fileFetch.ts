import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Node fetch rejects file: URLs. Serve module-relative assets (new URL(..., import.meta.url))
// from disk, as a bundler or static server would in the browser.
const networkFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith('file:')) return networkFetch(input, init);
  try {return new Response(await readFile(fileURLToPath(url)));}
  catch {return new Response(null, {status: 404});}
}) as typeof fetch;
