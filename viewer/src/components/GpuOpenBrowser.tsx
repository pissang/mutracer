import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, Search, X } from 'lucide-react';
import { showToast, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import {
  canDownloadGpuOpen, defaultGpuOpenPackage, downloadGpuOpenPackage, filterGpuOpenMaterials, gpuOpenPackages,
  gpuOpenSource, gpuOpenThumbnail, listGpuOpenMaterials, GPUOPEN_PACKAGE_LIMIT,
  type GpuOpenMaterial, type GpuOpenPackage, type GpuOpenLicense
} from '../engine/gpuOpen';
import { topCategories } from '../engine/polyHaven';
import { GpuOpenPackagePicker } from './GpuOpenPackagePicker';

const PAGE = 48;
let lastQuery = '', lastCategory: string | null = null;

export function GpuOpenBrowser() {
  const material = useViewer(s => s.material);
  const [catalog, setCatalog] = useState<GpuOpenMaterial[] | null>(null);
  const [licenses, setLicenses] = useState<GpuOpenLicense[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(lastQuery), [category, setCategory] = useState(lastCategory);
  const [limit, setLimit] = useState(PAGE);
  const [pick, setPick] = useState<GpuOpenMaterial | null>(null);
  const [packages, setPackages] = useState<GpuOpenPackage[] | null>(null);
  const [packageId, setPackageId] = useState('');
  const [progress, setProgress] = useState<{ loaded: number; total: number; importing: boolean } | null>(null);
  const [applied, setApplied] = useState<{ id: string; target: string } | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    listGpuOpenMaterials().then(data => { if (active) { setCatalog(data.materials); setLicenses(data.licenses); } },
      error => { if (active) setError((error as Error).message); });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { lastQuery = query; lastCategory = category; setLimit(PAGE); }, [query, category]);
  useEffect(() => {
    controller.current?.abort(); setProgress(null);
  }, [material?.id]);
  useEffect(() => {
    setPackages(null); setPackageId('');
    if (!pick) return;
    const request = new AbortController();
    gpuOpenPackages(pick, request.signal).then(list => {
      setPackages(list); setPackageId(defaultGpuOpenPackage(list)?.id ?? list[0]?.id ?? '');
    }).catch(error => { if (!request.signal.aborted) setError((error as Error).message); });
    return () => request.abort();
  }, [pick]);
  const categories = useMemo(() => catalog ? topCategories(catalog, 30) : [], [catalog]);
  const shown = useMemo(() => catalog ? filterGpuOpenMaterials(catalog, query, category) : [], [catalog, query, category]);
  const selected = packages?.find(p => p.id === packageId);
  const notice = licenses.find(l => l.name === pick?.license)?.description
    .replace('{YEAR}', pick?.year ?? '').replace('{AUTHOR}', pick?.author ?? '');
  const cancel = () => { controller.current?.abort(); setProgress(null); };
  const apply = async () => {
    if (!pick || !selected || !material) return;
    cancel(); setError(null);
    const target = { id: material.id, name: material.name };
    const request = new AbortController(); controller.current = request;
    setProgress({ loaded: 0, total: 0, importing: false });
    try {
      const files = await downloadGpuOpenPackage(selected, (loaded, total) => {
        if (!request.signal.aborted) setProgress({ loaded, total, importing: false });
      }, request.signal);
      request.signal.throwIfAborted();
      setProgress(p => p && { ...p, importing: true });
      const ok = await getEngine()?.importMaterialX(target.id, files, request.signal);
      if (ok && !request.signal.aborted) setApplied({ id: pick.id, target: target.name });
    } catch (error) {
      if (!request.signal.aborted) { setError((error as Error).message); showToast('Could not download the GPUOpen material', 'error'); }
    } finally { if (controller.current === request) { controller.current = null; setProgress(null); } }
  };
  return (
    <section className="panel tex-browser gpuopen-browser" aria-label="GPUOpen materials">
      <div className="insp-head">
        <a className="badge" href="https://matlib.gpuopen.com" target="_blank" rel="noreferrer" aria-label="GPUOpen website"><Download size={18} /></a>
        <div className="copy"><strong>GPUOpen materials</strong><small>{material ? `Apply to ${material.name}` : 'Select a material'}</small></div>
      </div>
      <div className="tex-browser__filters">
        <label className="search"><Search size={13} /><input placeholder="Search wood, metal, fabric…" value={query} onChange={e => setQuery(e.currentTarget.value)} />
          {query && <button className="icon-btn icon-btn--bare xs" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</label>
        <div className="ph-cats" role="radiogroup" aria-label="Category">
          {[null, ...categories].map(c => <button key={c ?? 'all'} role="radio" aria-checked={c === category} data-on={c === category || undefined}
            onClick={() => setCategory(c)}>{c ?? 'All'}</button>)}
        </div>
      </div>
      {error && <div className="ph-empty" role="alert">{error} <button className="hint__link" onClick={() => { setError(null); if (!catalog) setRetry(n => n + 1); else setPick(p => p && { ...p }); }}>Retry</button></div>}
      <div className="ph-grid" onScroll={e => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) setLimit(l => l + PAGE); }}>
        {!catalog && !error && <div className="ph-empty">Loading the catalog…</div>}
        {catalog && !shown.length && <div className="ph-empty">No matching materials</div>}
        {shown.slice(0, limit).map(m => <button className="ph-card" key={m.id} title={`${m.name} · ${m.author} · ${m.license}`}
          data-on={pick?.id === m.id || undefined} aria-pressed={pick?.id === m.id}
          onClick={() => { cancel(); setError(null); setPick(m); }}>
          {m.render ? <img src={gpuOpenThumbnail(m.render)} alt="" loading="lazy" /> : <i />}
          <span>{m.name}</span>
        </button>)}
      </div>
      {pick && <div className="gpuopen-detail">
        <a href={gpuOpenSource(pick.id)} target="_blank" rel="noreferrer"><strong>{pick.name}</strong> <ExternalLink size={12} /></a>
        <span>{pick.author} · {pick.license}</span>
        {notice && <details><summary>License</summary><pre>{notice}</pre></details>}
        {packages ? <GpuOpenPackagePicker packages={packages} value={packageId}
          onChange={setPackageId} disabled={!!progress} /> : <span>Loading packages…</span>}
        {!canDownloadGpuOpen(pick) ? <a href={gpuOpenSource(pick.id)} target="_blank" rel="noreferrer">Download from GPUOpen</a> :
          <button className="btn btn--wide" disabled={!material || !selected || !!progress || selected.bytes > GPUOPEN_PACKAGE_LIMIT} onClick={() => void apply()}>
            <Download size={14} />Apply material
          </button>}
        {progress && <div role="status"><span>{progress.importing ? 'Importing MaterialX…' : `${(progress.loaded / 1048576).toFixed(1)}${progress.total ? ` / ${(progress.total / 1048576).toFixed(1)}` : ''} MB`}</span>
          <button className="hint__link" onClick={cancel}>Cancel</button>
          <div className="progress"><i style={{ width: `${progress.total ? Math.max(4, progress.loaded / progress.total * 100) : 4}%` }} /></div>
        </div>}
        {applied?.id === pick.id && <span role="status">Applied to {applied.target}</span>}
      </div>}
    </section>
  );
}
