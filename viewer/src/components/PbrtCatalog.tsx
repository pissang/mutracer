import catalog from '../engine/pbrt-catalog.json';
import { getEngine } from '../engine/ViewerEngine';
const PBRT_SCENES = catalog.scenes;
const PBRT_SOURCE = `https://github.com/mmp/pbrt-v4-scenes/blob/${catalog.commit}/README.md`;
const SCENES_BASE = `https://raw.githubusercontent.com/mmp/pbrt-v4-scenes/${catalog.commit}/`;
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
