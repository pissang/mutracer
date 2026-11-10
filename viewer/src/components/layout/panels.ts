import type { WorkspaceImperativeHandle } from 'react-resizable-panels';
import { setUi, useViewer } from '../../store';
import { TRANSIENT, findTabset, type PanelData, type PanelId, type TransientPanel } from './workspaceModel';

let workspace: WorkspaceImperativeHandle<null, PanelData> | null = null;

/** Registered by the desktop workspace while it is mounted. */
export function setWorkspace(handle: WorkspaceImperativeHandle<null, PanelData> | null) {
  workspace = handle;
}

function visible(id: PanelId) {
  if (!workspace) return false;
  const model = workspace.getModel();
  const tabset = findTabset(model, id);
  return !!tabset && tabset.selectedId === id && !tabset.collapsed && (!model.maximizedTabsetId || model.maximizedTabsetId === tabset.id);
}

/** Brings a panel to the front: selects its tab and expands its tabset. Opens transient panels. */
export function revealPanel(id: PanelId) {
  const flag = id in TRANSIENT ? TRANSIENT[id as TransientPanel] : null;
  if (flag && !useViewer.getState().ui[flag]) setUi({ [flag]: true });
  if (!workspace) return;
  const tabset = findTabset(workspace.getModel(), id);
  if (!tabset) return;
  workspace.selectTab(id);
  if (tabset.collapsed) workspace.expandTabset(tabset.id);
  if (workspace.getModel().maximizedTabsetId && workspace.getModel().maximizedTabsetId !== tabset.id) workspace.restoreTabset();
}

/** Toolbar buttons for transient panels: show the panel, or close it when it is already in view. */
export function togglePanel(id: TransientPanel) {
  const flag = TRANSIENT[id];
  if (useViewer.getState().ui[flag] && (visible(id) || !workspace)) setUi({ [flag]: false });
  else revealPanel(id);
}
