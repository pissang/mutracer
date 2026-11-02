import { PBRT_SCENES, PBRT_SOURCE } from '../engine/pbrt';
import { SCENES_BASE } from '../../../tools/pbrt/source';
import { getEngine } from '../engine/ViewerEngine';
const groups = [...new Set(PBRT_SCENES.map(scene => scene.group))];
export function PbrtCatalog({ onChoose }: { onChoose?: () => void }) {
  return <div className="pbrt-catalog">
    <p className="hint example-note"><a href={PBRT_SOURCE} target="_blank" rel="noopener noreferrer">PBRT scenes · sources and licenses ↗</a></p>
    {groups.map(group => <details key={group}>
      <summary>{group}</summary>
      {PBRT_SCENES.filter(scene => scene.group === group).map(scene => <button className="btn" key={scene.path}
        onClick={() => { void getEngine()?.loadUrl(SCENES_BASE + scene.path); onChoose?.(); }}>
        {scene.path.slice(group.length + 1)} · {(scene.bytes / 1e6).toFixed(1)} MB
      </button>)}
    </details>)}
  </div>;
}
