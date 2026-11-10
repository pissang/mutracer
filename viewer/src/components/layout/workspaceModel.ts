import {
  normalizeWorkspaceModel, type TabDropTarget, type TabNode, type TabsetNode, type TabsetNodeInput, type WorkspaceModel,
  type WorkspaceModelInput, type WorkspaceNode, type WorkspaceNodeInput
} from 'react-resizable-panels';
import type { InspectorTab } from '../../store';

/** Every panel the desktop workspace can show; tab ids are panel ids. */
export type PanelId = 'viewport' | 'scene' | InspectorTab | TransientPanel;
/** Panels the user opens and closes; each mirrors a `ui` flag in the store. */
export type TransientPanel = keyof typeof TRANSIENT;
export type Model = WorkspaceModel<null, PanelData>;
/** Tabset data: the pixel size a side tabset keeps beside the viewport (see `pinSizes`). */
export type PanelData = { px?: number };

export const INSPECTOR: InspectorTab[] = ['environment', 'material', 'camera', 'render'];
export const TRANSIENT = {
  textures: 'textureBrowser',
  gpuopen: 'materialBrowser',
  examples: 'examplesPinned',
  graph: 'graphEditor'
} as const;
const BROWSERS: PanelId[] = ['textures', 'gpuopen', 'examples'];
const FIXED: PanelId[] = ['viewport', 'scene', ...INSPECTOR];

export const PANEL_TITLES: Record<PanelId, string> = {
  viewport: 'Viewport', scene: 'Scene', environment: 'Lighting', material: 'Material', camera: 'Camera', render: 'Render',
  textures: 'Poly Haven', gpuopen: 'GPUOpen', examples: 'Examples', graph: 'Node graph'
};

export const isPanel = (id: string): id is PanelId => id in PANEL_TITLES;
export const isTransient = (id: string): id is TransientPanel => id in TRANSIENT;

export function panelTab(id: PanelId): TabNode<null> {
  return { id, title: PANEL_TITLES[id], data: null, disableClose: FIXED.includes(id) || undefined, disableDrag: id === 'viewport' || undefined };
}

export function defaultModel(tab: InspectorTab, left: boolean, right: boolean): WorkspaceModelInput<null, PanelData> {
  return {
    version: 1,
    root: {
      type: 'split', orientation: 'horizontal', children: [
        { type: 'tabset', id: 'scene-tabs', size: '252px', minWidth: '180px', collapsible: true, collapsed: !left, tabs: [panelTab('scene')] },
        { type: 'tabset', id: 'viewport-tabs', disableDrag: true, tabs: [panelTab('viewport')] },
        { type: 'tabset', id: 'inspector-tabs', size: '280px', minWidth: '240px', collapsible: true, collapsed: !right, selectedId: tab, tabs: INSPECTOR.map(panelTab) }
      ]
    }
  };
}

/** Restores a saved layout; transient panels are kept only while `open` says they are open. */
export function restoreModel(saved: unknown, open: (id: TransientPanel) => boolean): Model | null {
  const model = normalizeWorkspaceModel<null, PanelData>(saved, {
    mapTab: tab => isPanel(tab.id) && (!isTransient(tab.id) || open(tab.id)) ? panelTab(tab.id) : null
  });
  return model && FIXED.every(id => findTabset(model, id)) ? model : null;
}

export function* tabsets(model: Model): Generator<TabsetNode<null, PanelData>> {
  const visit = function* (node: WorkspaceNode<null, PanelData>): Generator<TabsetNode<null, PanelData>> {
    if (node.type === 'tabset') yield node;
    else for (const child of node.children) yield* visit(child);
  };
  yield* visit(model.root);
  for (const floating of model.floating ?? []) yield floating as TabsetNode<null, PanelData>;
}

export function findTabset(model: Model, tabId: string): TabsetNode<null, PanelData> | undefined {
  for (const tabset of tabsets(model)) if (tabset.tabs.some(tab => tab.id === tabId)) return tabset;
}

const contains = (node: WorkspaceNodeInput<null, PanelData>, tabId: string): boolean =>
  node.type === 'tabset' ? node.tabs.some(tab => tab.id === tabId) : node.children.some(child => contains(child, tabId));

/**
 * Inserts `added` beside the tabset `target`. In the split that receives it, the child holding the viewport
 * gives up the space (it loses its size so it takes the remainder); otherwise the target does.
 */
export function insertBeside(model: Model, target: string, side: 'left' | 'right' | 'top' | 'bottom', added: TabsetNodeInput<null, PanelData>): WorkspaceModelInput<null, PanelData> {
  const orientation = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
  const before = side === 'left' || side === 'top';
  const visit = (node: WorkspaceNodeInput<null, PanelData>): WorkspaceNodeInput<null, PanelData> => {
    if (node.type === 'tabset') {
      if (node.id !== target) return node;
      const rest = { ...node, size: undefined };
      return { type: 'split', orientation, size: node.size, children: before ? [added, rest] : [rest, added] };
    }
    const index = node.children.findIndex(child => child.type === 'tabset' && child.id === target);
    if (index < 0 || node.orientation !== orientation) return { ...node, children: node.children.map(visit) };
    const flexible = node.children.some(child => contains(child, 'viewport'))
      ? (child: WorkspaceNodeInput<null, PanelData>) => contains(child, 'viewport')
      : (child: WorkspaceNodeInput<null, PanelData>) => child.type === 'tabset' && child.id === target;
    const children = node.children.map(child => flexible(child) ? { ...child, size: undefined } : child);
    children.splice(before ? index : index + 1, 0, added);
    return { ...node, children };
  };
  return { ...model, maximizedTabsetId: undefined, root: visit(model.root) };
}

/**
 * Where a newly opened panel goes: browsers share one tabset left of the inspector,
 * the node graph goes below the viewport. Returns a model to apply, or a tabset to add the tab to.
 */
export function placePanel(model: Model, id: TransientPanel): { model: WorkspaceModelInput<null, PanelData> } | { tabsetId?: string } {
  const added: TabsetNodeInput<null, PanelData> = { type: 'tabset', id: `${id}-tabs`, collapsible: true, tabs: [panelTab(id)] };
  const floating = new Set((model.floating ?? []).map(tabset => tabset.id));
  if (BROWSERS.includes(id)) {
    const shared = [...tabsets(model)].find(tabset => tabset.tabs.some(tab => BROWSERS.includes(tab.id as PanelId)));
    if (shared) return { tabsetId: shared.id };
    const inspector = findTabset(model, 'material');
    if (!inspector || floating.has(inspector.id)) return {};
    return { model: insertBeside(model, inspector.id, 'left', { ...added, size: '300px', minWidth: '240px' }) };
  }
  const viewport = findTabset(model, 'viewport')!;
  return { model: insertBeside(model, viewport.id, 'bottom', { ...added, size: '45%', minHeight: '160px' }) };
}

/** Tabs can't be dropped among the viewport's tabs, which would hide the viewport. */
export function blocksDrop(model: Model, target: TabDropTarget): boolean {
  if ('edge' in target) return false;
  const tabset = findTabset(model, 'viewport');
  return target.tabsetId === tabset?.id && ('index' in target || target.region === 'center');
}

export type SplitLength = (splitId: string, orientation: 'horizontal' | 'vertical') => number | undefined;
type Size = number | string | undefined;

function pixels(size: Size, length: number): number | undefined {
  if (typeof size === 'number') return size * length / 100;
  if (typeof size !== 'string') return undefined;
  const value = parseFloat(size);
  if (!Number.isFinite(value)) return undefined;
  return size.endsWith('px') ? value : size.endsWith('%') || /^[\d.]+$/.test(size) ? value * length / 100 : undefined;
}

/** Width of the separators between tabsets, in pixels. */
const GAP = 6;

export interface Lengths {
  /** A split's length along its orientation. */
  split: SplitLength;
  /** A tabset's or split's laid-out length along its parent split. */
  node: (id: string, orientation: 'horizontal' | 'vertical') => number | undefined;
  /** Length of a collapsed tabset. */
  strip: (tabsetId: string) => number;
}

const collapsed = (node: WorkspaceNode<null, PanelData>) => node.type === 'tabset' && !!node.collapsed;

/**
 * Keeps the panels beside the viewport at fixed pixel sizes and gives the rest to the viewport, when the window
 * resizes and when a sibling collapses or expands (the workspace would scale every tabset in the split).
 * Each side tabset remembers its size in its data; `fromLayout` takes the sizes from the current layout instead,
 * after the user resized or moved panels.
 *
 * The workspace applies a model's sizes as percentages (it weighs pixel sizes by their old layout once a split
 * has been laid out), so every size, the viewport's included, is written as a percentage of the split's
 * current length. Window resizes call this again.
 */
export function pinSizes(model: Model, lengths: Lengths, fromLayout = false): WorkspaceModelInput<null, PanelData> {
  const visit = (node: WorkspaceNode<null, PanelData>): WorkspaceNodeInput<null, PanelData> => {
    if (node.type === 'tabset') return node;
    const children = node.children.map(visit);
    const holder = node.children.findIndex(child => contains(child, 'viewport'));
    const total = lengths.split(node.id, node.orientation);
    if (holder < 0 || !total) return { ...node, children };
    const sizes = node.children.map((child, i) => {
      if (i === holder) return 0;
      const laid = fromLayout && !collapsed(child) ? lengths.node(child.id, node.orientation) : undefined;
      return laid ?? (child.type === 'tabset' ? child.data?.px : undefined) ?? pixels(child.size, total);
    });
    if (sizes.some(size => size === undefined)) return { ...node, children };
    const px = sizes.map(size => Math.round(size!));
    const remember = (child: WorkspaceNodeInput<null, PanelData>, i: number): WorkspaceNodeInput<null, PanelData> =>
      child.type === 'tabset' ? { ...child, data: { ...child.data, px: px[i] } } : child;
    const available = total - GAP * (node.children.length - 1);
    const percent = (length: number) => length / available * 100;
    let rest = 100;
    for (const [i, child] of node.children.entries()) if (i !== holder) rest -= percent(collapsed(child) ? lengths.strip(child.id) : px[i]);
    return {
      ...node,
      children: children.map((child, i) => i === holder ? { ...child, size: Math.max(1, rest) } : { ...remember(child, i), size: percent(px[i]) })
    };
  };
  return { ...model, root: visit(model.root) };
}

