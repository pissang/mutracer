import { useState } from 'react';
import { Shapes } from 'lucide-react';
import { useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { thumbnailUrl } from '../engine/presets';
import { MATERIALX_SAMPLES, materialXSampleFiles } from '../engine/materialxSamples';

/** Bundled procedural MaterialX samples, applied to the selected material. */
export function MaterialXSamplesBrowser() {
  const material = useViewer(s => s.material);
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  return (
    <section className="panel tex-browser" aria-label="MaterialX samples">
      <div className="insp-head">
        <span className="badge"><Shapes size={18} /></span>
        <div className="copy"><strong>MaterialX samples</strong><small>{material ? `Apply to ${material.name}` : 'Select a material'}</small></div>
      </div>
      <div className="ph-grid">
        {MATERIALX_SAMPLES.map(sample => (
          <button key={sample.id} className="ph-card" title={`Apply ${sample.label}`} disabled={!material || !!busy}
            data-busy={busy === sample.id || undefined} data-on={applied === sample.id || undefined}
            onClick={async () => {
              if (!material) return;
              setBusy(sample.id);
              try { if (await getEngine()?.importMaterialX(material.id, materialXSampleFiles(sample))) setApplied(sample.id); }
              finally { setBusy(null); }
            }}>
            <img src={thumbnailUrl(`materialx-${sample.id}`)} alt="" /><span>{sample.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
