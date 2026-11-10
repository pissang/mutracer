import { Aperture, Camera, Globe, Palette } from 'lucide-react';
import { setUi, useViewer, type InspectorTab } from '../store';
import { EnvironmentPanel } from './panels/EnvironmentPanel';
import { MaterialPanel } from './panels/MaterialPanel';
import { CameraPanel } from './panels/CameraPanel';
import { RenderPanel } from './panels/RenderPanel';
import { SceneTree } from './SceneTree';

export const TABS: { id: InspectorTab; label: string; Icon: typeof Globe }[] = [
  { id: 'environment', label: 'Lighting', Icon: Globe },
  { id: 'material', label: 'Material', Icon: Palette },
  { id: 'camera', label: 'Camera', Icon: Camera },
  { id: 'render', label: 'Render', Icon: Aperture }
];

const PANELS: Record<InspectorTab, () => JSX.Element> = {
  environment: EnvironmentPanel,
  material: MaterialPanel,
  camera: CameraPanel,
  render: RenderPanel
};

/** The mobile inspector: a bottom sheet with the scene tree and every panel. */
export function Inspector() {
  const tab = useViewer((s) => s.ui.mobileTab);
  const Panel = tab === 'scene' ? null : PANELS[tab];
  return (
    <section className="panel inspector inspector--sheet" aria-label="Inspector">
      <div className="sheet-tabs" role="tablist">
        {[{ id: 'scene' as const, label: 'Scene' }, ...TABS].map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} data-on={tab === t.id || undefined}
            onClick={() => setUi({ mobileTab: t.id })}>{t.label}</button>
        ))}
      </div>
      {Panel ? <div className="insp-body"><Panel /></div> : <SceneTree />}
    </section>
  );
}

/** One inspector panel, shown as a tab of the desktop workspace. */
export function InspectorPanel({ tab }: { tab: InspectorTab }) {
  const Panel = PANELS[tab];
  return <section className="panel inspector"><div className="insp-body"><Panel /></div></section>;
}
