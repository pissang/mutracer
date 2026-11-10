import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceModel, type SplitNode, type TabsetNode } from 'react-resizable-panels';
import {
  blocksDrop, defaultModel, findTabset, pinSizes, placePanel, restoreModel, tabsets, type Lengths, type Model, type PanelData
} from '../src/components/layout/workspaceModel';

const model = (input = defaultModel('material', true, true)) => normalizeWorkspaceModel<null, PanelData>(input)!;
const apply = (current: Model, placed: ReturnType<typeof placePanel>, id: string) =>
  'model' in placed ? model(placed.model) : model({ ...current, root: addTo(current.root as SplitNode<null, PanelData>, placed.tabsetId!, id) });
const addTo = (root: SplitNode<null, PanelData>, tabsetId: string, id: string): SplitNode<null, PanelData> => ({
  ...root,
  children: root.children.map(child => child.type === 'tabset'
    ? child.id === tabsetId ? { ...child, tabs: [...child.tabs, { id, data: null }] } : child
    : addTo(child, tabsetId, id))
});
const ids = (current: Model) => [...tabsets(current)].map(tabset => tabset.tabs.map(tab => tab.id));

describe('viewer workspace layout', () => {
  it('starts with the scene, the viewport and the inspector panels', () => {
    const current = model(defaultModel('camera', false, true));
    expect(ids(current)).toEqual([['scene'], ['viewport'], ['environment', 'material', 'camera', 'render']]);
    expect(findTabset(current, 'scene')?.collapsed).toBe(true);
    expect(findTabset(current, 'camera')?.selectedId).toBe('camera');
  });

  it('restores saved layouts, dropping closed and unknown panels and rejecting incomplete ones', () => {
    const saved = model();
    const withPanels = apply(saved, placePanel(saved, 'textures'), 'textures');
    const json = JSON.parse(JSON.stringify(withPanels));
    expect(ids(restoreModel(json, () => true)!)).toContainEqual(['textures']);
    expect(ids(restoreModel(json, () => false)!).flat()).not.toContain('textures');
    json.root.children[0].tabs.push({ id: 'removed-panel', data: null });
    expect(ids(restoreModel(json, () => true)!).flat()).not.toContain('removed-panel');
    json.root.children[0].tabs = [];
    expect(restoreModel(json, () => true)).toBeNull();
    expect(restoreModel('corrupt', () => true)).toBeNull();
  });

  it('opens browsers in one tabset left of the inspector and the node graph below the viewport', () => {
    let current = model();
    current = apply(current, placePanel(current, 'textures'), 'textures');
    current = apply(current, placePanel(current, 'gpuopen'), 'gpuopen');
    current = apply(current, placePanel(current, 'graph'), 'graph');
    const root = current.root as SplitNode<null, PanelData>;
    expect(root.children.map(child => child.type === 'tabset' ? child.tabs.map(tab => tab.id) : child.orientation)).toEqual([
      ['scene'], 'vertical', ['textures', 'gpuopen'], ['environment', 'material', 'camera', 'render']
    ]);
    const column = root.children[1] as SplitNode<null, PanelData>;
    expect(column.children.map(child => (child as TabsetNode<null, PanelData>).tabs[0].id)).toEqual(['viewport', 'graph']);
    // The viewport gives up the space: it has no size, the inserted panels do.
    expect(column.children[0].size).toBeUndefined();
    expect(root.children[2].size).toBe('300px');
  });

  it('keeps tabs out of the viewport tabset', () => {
    const current = model();
    const viewport = findTabset(current, 'viewport')!.id;
    expect(blocksDrop(current, { tabsetId: viewport, region: 'center' })).toBe(true);
    expect(blocksDrop(current, { tabsetId: viewport, index: 0 })).toBe(true);
    expect(blocksDrop(current, { tabsetId: viewport, region: 'bottom' })).toBe(false);
    expect(blocksDrop(current, { edge: 'left' })).toBe(false);
  });

  it('pins side panels to pixels and gives the viewport the rest, also with a collapsed sibling', () => {
    const lengths = (split: number): Lengths => ({ split: () => split, node: () => undefined, strip: () => 44 });
    const pinned = model(pinSizes(model(), lengths(1424)));
    const sizes = (current: Model) => (current.root as SplitNode<null, PanelData>).children.map(child => child.size as number);
    const available = 1424 - 12;
    expect(sizes(pinned).map(size => Math.round(size * available / 100))).toEqual([252, available - 252 - 280, 280]);
    expect([...tabsets(pinned)].map(tabset => tabset.data?.px)).toEqual([252, undefined, 280]);

    // A narrower window keeps the remembered side sizes.
    const narrow = model(pinSizes(pinned, lengths(1084)));
    expect(sizes(narrow).map(size => Math.round(size * (1084 - 12) / 100))).toEqual([252, 1084 - 12 - 252 - 280, 280]);

    // A collapsed tabset's strip, not its size, is taken from the viewport's share.
    const collapsed = model({ ...pinned, root: { ...pinned.root, children: (pinned.root as SplitNode<null, PanelData>).children.map(child =>
      child.type === 'tabset' && child.id === 'inspector-tabs' ? { ...child, collapsed: true } : child) } as SplitNode<null, PanelData> });
    // Applied as is: the model's sizes are weights that the workspace distributes.
    const repinned = sizes(pinSizes(collapsed, lengths(1424)) as Model);
    expect(Math.round(repinned[1] * available / 100)).toBe(available - 252 - 44);
    expect(Math.round(repinned[2] * available / 100)).toBe(280);
  });
});
