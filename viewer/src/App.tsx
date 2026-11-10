import { useEffect, useState } from 'react';
import { Toast } from './components/Toast';
import { setSettings, setUi, useViewer } from './store';
import { getEngine } from './engine/ViewerEngine';
import { redo, undo } from './history';
import { Toolbar } from './components/Toolbar';
import { Inspector, TABS } from './components/Inspector';
import { ExportDialog } from './components/ExportDialog';
import { CodeDialog } from './components/CodeDialog';
import { DesktopWorkspace } from './components/layout/DesktopWorkspace';
import { ViewportPortal, ViewportSlot } from './components/layout/ViewportHost';

const MOBILE_QUERY = '(max-width: 768px), (max-width: 1024px) and (max-height: 500px) and (orientation: landscape) and (pointer: coarse)';

function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Key events dispatched on the document have no element target.
      const target = event.target instanceof Element ? event.target : document.body;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        document.getElementById('open-files')?.click();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) redo();
        else undo();
        return;
      }
      // The node graph handles its own keys, such as Delete.
      if (target.closest('.graph-editor')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const state = useViewer.getState();
      const key = event.key.toLowerCase();
      if (key === 'f') getEngine()?.fit();
      else if (key === ' ') {
        if (target.closest('button, [role="slider"], [role="treeitem"]')) return;
        event.preventDefault();
        if (state.animation) getEngine()?.setAnimation({ playing: !state.animation.playing });
        else useViewer.setState({ paused: !state.paused });
      } else if (key === 'd') setSettings({ denoise: !state.settings.denoise });
      else if (key === 'e') setUi({ exportOpen: true });
      else if (key === 'h') setUi({ hidden: !state.ui.hidden });
      else if (key === '[') setUi({ left: !state.ui.left });
      else if (key === ']') setUi({ right: !state.ui.right });
      else if (key === '/') {
        event.preventDefault();
        (document.querySelector('.search input') as HTMLInputElement | null)?.focus();
      } else if (key === 'escape') {
        useViewer.setState({ pickingFocus: false });
        getEngine()?.select(null);
      } else if (/^[1-4]$/.test(key)) setUi({ tab: TABS[Number(key) - 1].id, right: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const ui = useViewer((s) => s.ui);
  const mobile = useMobile();
  useShortcuts();
  const sheet = mobile && ui.right && !ui.hidden;
  return (
    <div className="app" data-hidden={ui.hidden || undefined}>
      {!ui.hidden && <Toolbar mobile={mobile} />}
      {!mobile && !ui.hidden
        ? <main className="workspace workspace--desktop"><DesktopWorkspace /></main>
        : <main className="workspace" data-mobile={mobile || undefined} data-sheet={sheet || undefined}>
          <ViewportSlot />
          {sheet && <Inspector />}
        </main>}
      <ViewportPortal />
      <ExportDialog />
      <CodeDialog />
      <Toast />
    </div>
  );
}
