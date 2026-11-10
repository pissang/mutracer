import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Separator, TabCloseButton, Workspace, useWorkspaceCallbackRef,
  type TabNode, type TabRenderProps, type WorkspaceChangedMeta, type WorkspaceImperativeHandle
} from 'react-resizable-panels';
import { Aperture, Box, Camera, Download, Globe, Monitor, Palette, Sparkles, Workflow, X, type LucideIcon } from 'lucide-react';
import { setUi, useViewer, type InspectorTab } from '../../store';
import { SceneTree } from '../SceneTree';
import { TextureBrowser } from '../TextureBrowser';
import { GpuOpenBrowser } from '../GpuOpenBrowser';
import { ExamplesPanel } from '../ExamplesBrowser';
import { InspectorPanel } from '../Inspector';
import { PolyHavenLogo } from '../PolyHavenLogo';
import { ViewportSlot } from './ViewportHost';
import { setWorkspace } from './panels';
import {
  INSPECTOR, TRANSIENT, blocksDrop, defaultModel, findTabset, panelTab, pinSizes, placePanel, restoreModel, tabsets,
  type Lengths, type Model, type PanelData, type PanelId, type TransientPanel
} from './workspaceModel';
import './workspace.css';

const GraphEditor = lazy(() => import('../graphEditor/GraphEditor'));

const STORAGE_KEY = 'mutracer.workspace';
const readSaved = (): unknown => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { return null; } };
const writeSaved = (model: Model) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(model)); } catch { /* storage unavailable */ } };

type Handle = WorkspaceImperativeHandle<null, PanelData>;
type Ui = ReturnType<typeof useViewer.getState>['ui'];

const ICONS: Record<PanelId, LucideIcon | typeof PolyHavenLogo> = {
  viewport: Monitor, scene: Box, environment: Globe, material: Palette, camera: Camera, render: Aperture,
  textures: PolyHavenLogo, gpuopen: Download, examples: Sparkles, graph: Workflow
};

function content(tab: TabNode<null>): ReactNode {
  const id = tab.id as PanelId;
  switch (id) {
    case 'viewport': return <ViewportSlot />;
    case 'scene': return <SceneTree />;
    case 'textures': return <TextureBrowser />;
    case 'gpuopen': return <GpuOpenBrowser />;
    case 'examples': return <ExamplesPanel />;
    case 'graph': return <Suspense fallback={null}><GraphEditor /></Suspense>;
    default: return <InspectorPanel tab={id} />;
  }
}

function renderTab(tab: TabNode<null>, props: TabRenderProps) {
  const Icon = ICONS[tab.id as PanelId] ?? Box;
  const index = INSPECTOR.indexOf(tab.id as InspectorTab);
  return (
    <div {...props} className={`${props.className ?? ''} ws-tab`} title={index >= 0 ? `${tab.title} (${index + 1})` : tab.title}>
      <Icon size={14} />
      <span className="ws-tab__title">{tab.title}</span>
      {!tab.disableClose && <TabCloseButton className="ws-tab__close" aria-label={`Close ${tab.title}`}><X size={12} /></TabCloseButton>}
    </div>
  );
}

const renderSeparator = () => <Separator className="ws-separator" />;
const hiddenTabBehavior = (tab: TabNode<null>) => INSPECTOR.includes(tab.id as InspectorTab) ? 'unmount' as const : 'keep-mounted' as const;
const CLASS_NAMES = { tabset: 'ws-tabset', header: 'ws-header', tabList: 'ws-tabs', tabPanels: 'ws-panels', dropIndicator: 'ws-drop', dragPreview: 'ws-drag', split: 'ws-split' };

function initialModel(ui: Ui) {
  return restoreModel(readSaved(), id => ui[TRANSIENT[id]]) ?? defaultModel(ui.tab, ui.left, ui.right);
}

function openPanel(handle: Handle, id: TransientPanel) {
  const model = handle.getModel();
  const placed = placePanel(model, id);
  if ('model' in placed) handle.setModel(placed.model);
  else handle.addTab(panelTab(id), { tabsetId: placed.tabsetId });
}

function setCollapsed(handle: Handle, tabId: string, collapsed: boolean) {
  const tabset = findTabset(handle.getModel(), tabId);
  if (!tabset || !!tabset.collapsed === collapsed) return;
  if (collapsed) handle.collapseTabset(tabset.id);
  else handle.expandTabset(tabset.id);
}

/** Store flags that follow the layout after the user rearranges it. */
function uiFromModel(model: Model, ui: Ui, active: string | undefined): Partial<Ui> {
  const patch: Partial<Record<keyof Ui, unknown>> = {};
  for (const [id, flag] of Object.entries(TRANSIENT) as [TransientPanel, (typeof TRANSIENT)[TransientPanel]][]) {
    const present = !!findTabset(model, id);
    if (ui[flag] !== present) patch[flag] = present;
  }
  const activeTabset = [...tabsets(model)].find(tabset => tabset.id === active);
  const selected = activeTabset?.selectedId;
  const tab = selected && INSPECTOR.includes(selected as InspectorTab) ? selected as InspectorTab : ui.tab;
  if (tab !== ui.tab) patch.tab = tab;
  const left = !findTabset(model, 'scene')?.collapsed;
  const right = !findTabset(model, tab)?.collapsed;
  if (left !== ui.left) patch.left = left;
  if (right !== ui.right) patch.right = right;
  return patch as Partial<Ui>;
}

/** Desktop layout: the viewport with dockable, resizable tabs for every panel. */
export function DesktopWorkspace() {
  const [handle, setHandle] = useWorkspaceCallbackRef<null, PanelData>();
  const model = useMemo(() => initialModel(useViewer.getState().ui), []);
  const ui = useViewer(s => s.ui);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => { setWorkspace(handle); return () => setWorkspace(null); }, [handle]);

  // Side panels keep pixel sizes and the viewport takes the rest (see `pinSizes`). The workspace scales
  // every tabset in a split when the split's space changes (a window resize, a sibling collapsing), so the
  // pinned sizes are applied again afterwards.
  const pin = useCallback((model: Model, fromLayout = false) => {
    const element = root.current;
    if (!handle || !element) return;
    const rect = (selector: string) => element.querySelector(selector)?.getBoundingClientRect();
    const along = (r: DOMRect | undefined, orientation: 'horizontal' | 'vertical') => r && (orientation === 'vertical' ? r.height : r.width);
    const lengths: Lengths = {
      split: (id, orientation) => along(rect(`[data-split-id="${CSS.escape(id)}"]`), orientation),
      node: (id, orientation) => along(rect(`[data-tabset-id="${CSS.escape(id)}"]`) ?? rect(`[data-split-id="${CSS.escape(id)}"]`), orientation),
      strip: id => { const r = rect(`[data-tabset-id="${CSS.escape(id)}"]`); return r ? Math.min(r.width, r.height) : 44; }
    };
    handle.setModel(pinSizes(model, lengths, fromLayout));
  }, [handle]);

  useEffect(() => {
    if (!handle || !root.current) return;
    let timer = 0;
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = window.setTimeout(() => pin(handle.getModel()), 100); });
    observer.observe(root.current);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [handle, pin]);

  const onModelChanged = useCallback((next: Model, meta: WorkspaceChangedMeta) => {
    writeSaved(next);
    if (!handle) return;
    if (meta.reason === 'collapse' || meta.reason === 'expand') setTimeout(() => pin(handle.getModel()), 50);
    if (meta.isUserInteraction && (meta.reason === 'resize' || meta.reason === 'move')) queueMicrotask(() => pin(next, true));
    const patch = uiFromModel(next, useViewer.getState().ui, handle.getActiveTabsetId());
    if (Object.keys(patch).length) setUi(patch);
    // Tabsets the workspace creates (e.g. by splitting) start without the collapsible flag.
    for (const tabset of tabsets(next)) {
      if (!tabset.collapsible && !(next.floating ?? []).some(f => f.id === tabset.id) && !tabset.tabs.some(tab => tab.id === 'viewport'))
        queueMicrotask(() => handle.updateTabset(tabset.id, { collapsible: true }));
    }
  }, [handle, pin]);

  useEffect(() => {
    if (!handle) return;
    for (const [id, flag] of Object.entries(TRANSIENT) as [TransientPanel, (typeof TRANSIENT)[TransientPanel]][]) {
      const present = !!findTabset(handle.getModel(), id);
      if (ui[flag] && !present) openPanel(handle, id);
      else if (!ui[flag] && present) handle.closeTab(id);
    }
  }, [handle, ui.textureBrowser, ui.materialBrowser, ui.examplesPinned, ui.graphEditor]);

  useEffect(() => {
    if (!handle) return;
    if (findTabset(handle.getModel(), ui.tab)?.selectedId !== ui.tab) handle.selectTab(ui.tab);
  }, [handle, ui.tab]);
  useEffect(() => { if (handle) setCollapsed(handle, 'scene', !ui.left); }, [handle, ui.left]);
  useEffect(() => { if (handle) setCollapsed(handle, useViewer.getState().ui.tab, !ui.right); }, [handle, ui.right]);

  return (
    <Workspace<null, PanelData>
      id="viewer-workspace"
      className="ws"
      classNames={CLASS_NAMES}
      defaultModel={model}
      elementRef={root}
      workspaceRef={setHandle}
      onModelChanged={onModelChanged}
      disableDrop={({ model, target }) => blocksDrop(model, target)}
      hiddenTabBehavior={hiddenTabBehavior}
      renderTab={renderTab}
      renderTabContent={content}
      renderSeparator={renderSeparator}
      tabsetMinWidth="160px"
      tabsetMinHeight="120px"
    />
  );
}
