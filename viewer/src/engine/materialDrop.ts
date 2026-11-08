import { isMaterialXFile, isModelFile, type PathedFile } from './droppedFiles';

export interface MaterialDropTarget {
  materialId: string;
  objectId: string | null;
  name: string;
}

export const isMaterialXDrop = (files: PathedFile[]) =>
  files.some(({ path }) => isMaterialXFile(path)) && !files.some(({ path }) => isModelFile(path));

/** A viewport hit takes precedence; the inspector always uses its displayed material. */
export function materialDropTarget(
  surface: 'viewport' | 'panel', hit: MaterialDropTarget | null, selected: MaterialDropTarget | null
) {
  return surface === 'viewport' ? hit ?? selected : selected;
}

