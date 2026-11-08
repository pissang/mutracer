import { describe, expect, it, vi } from 'vitest';
import { gpuOpenUpstream, gpuOpenRedirect, proxyGpuOpen } from '../../site/src/gpuopenProxy';
import { defaultGpuOpenPackage, parseGpuOpenMaterial, parseGpuOpenPackage, parseGpuOpenPage, filterGpuOpenMaterials } from '../src/engine/gpuOpen';
const id = 'cda6c347-8e03-4658-8382-dda9522dbf47';
const local = (path: string) => new URL(`https://viewer.test/api/gpuopen/${path}`);
const pkg = (label = '1k 8b', size = '6.2 MB') => ({ id, label, size, file_url: `https://api.matlib.gpuopen.com/api/packages/${id}/download/` });

describe('GPUOpen gateway', () => {
  it('allows only named read endpoints and bounded pagination', () => {
    for (const path of ['materials/?limit=1000&offset=20', 'tags/', 'categories/', 'licenses/', `packages/${id}/`, `packages/${id}/download/`, `renders/${id}/download_thumbnail/`, `renders/${id}/download_preview/`]) {
      expect(gpuOpenUpstream(local(path))?.origin).toBe('https://api.matlib.gpuopen.com');
    }
    for (const path of ['https://example.com', '?url=https://example.com', 'materials/?url=https://example.com', 'materials/?limit=1001', 'materials/?limit=0', 'materials/?offset=-1', 'materials/?limit=1&limit=2', 'materials/?offset=10001', `packages/${id}/?url=x`, 'user/', 'materials/%2e%2e%2fuser/', `packages/${id}%2fdownload/`, 'materials/?limit=1e3']) {
      expect(gpuOpenUpstream(local(path)), path).toBeNull();
    }
  });
  it('restricts redirects to HTTPS, the exact hosts and the matching content kind', () => {
    expect(gpuOpenRedirect(new URL('https://media.matlib.gpuopen.com/signed.zip?signature=a'), 'zip')).toBe(true);
    expect(gpuOpenRedirect(new URL('https://image.matlib.gpuopen.com/signed.jpeg'), 'image')).toBe(true);
    for (const url of ['https://example.com/x', 'http://media.matlib.gpuopen.com/x', 'https://media.matlib.gpuopen.com.evil.test/x', 'https://user@media.matlib.gpuopen.com/x', 'https://media.matlib.gpuopen.com:444/x']) {
      expect(gpuOpenRedirect(new URL(url), 'zip')).toBe(false);
    }
    expect(gpuOpenRedirect(new URL('https://media.matlib.gpuopen.com/x'), 'json')).toBe(false);
  });
  it('follows checked redirects, streams bytes and strips cookies and upstream headers', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://media.matlib.gpuopen.com/signed.zip' } }))
      .mockResolvedValueOnce(new Response('zip data', { headers: { 'Set-Cookie': 'secret=value', 'Content-Type': 'application/zip' } }));
    const response = await proxyGpuOpen(new Request(local(`packages/${id}/download/`), { headers: { Cookie: 'user=private', Authorization: 'private' } }), fetcher);
    expect(await response.text()).toBe('zip data');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Accept: '*/*', 'User-Agent': 'MuTracer/1.0 (+https://mutracer.meimu-studio.com)' });
    expect(fetcher.mock.calls[1][1].redirect).toBe('manual');
  });
  it('rejects writes, invalid redirects and oversized announced or streamed responses', async () => {
    const fetcher = vi.fn();
    expect((await proxyGpuOpen(new Request(local('materials/'), { method: 'POST' }), fetcher)).status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }));
    expect((await proxyGpuOpen(new Request(local(`packages/${id}/download/`)), fetcher)).status).toBe(502);
    fetcher.mockResolvedValueOnce(new Response('', { headers: { 'Content-Length': String(129 * 1048576) } }));
    expect((await proxyGpuOpen(new Request(local(`packages/${id}/download/`)), fetcher)).status).toBe(413);
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(2 * 1048576 + 1), { headers: { 'Content-Type': 'application/json' } }));
    const response = await proxyGpuOpen(new Request(local('materials/')), fetcher);
    await expect(response.arrayBuffer()).rejects.toThrow(/size limit/);
  });
  it('returns short uncached upstream errors and propagates download cancellation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('private upstream details', { status: 500 }));
    const response = await proxyGpuOpen(new Request(local('materials/')), fetcher);
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('private');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const download = await proxyGpuOpen(new Request(local(`packages/${id}/download/`)), fetcher);
    await download.body!.cancel(); expect(cancel).toHaveBeenCalledOnce();
  });
});
describe('GPUOpen catalog', () => {
  it('resolves category and tag IDs, render order, authors and licenses', () => {
    const material = parseGpuOpenMaterial({ id, title: 'Brushed metal', category: id, tags: [id], renders_order: [id], packages: [id], author: 'AMD', license: 'MIT Public Domain', created_date: '2023-08-07' }, new Map([[id, 'Metal']]), new Map([[id, 'brushed']]));
    expect(material).toMatchObject({ name: 'Brushed metal', author: 'AMD', year: '2023', categories: ['Metal'], tags: ['brushed'], render: id });
    expect(filterGpuOpenMaterials([material], 'brushed metal', 'Metal')).toEqual([material]);
    expect(filterGpuOpenMaterials([material], '', 'Wood')).toEqual([]);
    expect(() => parseGpuOpenPage({ count: 1, results: 'invalid' })).toThrow();
    expect(() => parseGpuOpenMaterial({ id: '../evil', title: 'Bad' }, new Map(), new Map())).toThrow();
  });
  it('parses formatted sizes, defaults to 1k 8b and rejects external file URLs', () => {
    const packages = [parseGpuOpenPackage(pkg('2k 16b', '47.89 MB')), parseGpuOpenPackage(pkg())];
    expect(defaultGpuOpenPackage(packages)).toBe(packages[1]);
    expect(packages[1].bytes).toBeCloseTo(6.2 * 1048576);
    expect(packages[1].url).toBe(`/api/gpuopen/packages/${id}/download/`);
    expect(() => parseGpuOpenPackage({ ...pkg(), file_url: 'https://example.com/material.zip' })).toThrow();
    expect(defaultGpuOpenPackage([parseGpuOpenPackage(pkg('8k 16b', '1 GB'))])).toBeUndefined();
  });
});
