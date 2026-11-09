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

export const TEXTURE_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif';
const imageTypes = new Set(TEXTURE_ACCEPT.split(','));

/** The file picker and drops accept the same browser-decodable image formats. */
export function textureDropError(files: File[]): string | null {
  if (files.length !== 1) return 'Drop one image on a texture slot';
  const file = files[0];
  if (!imageTypes.has(file.type.toLowerCase()) || !/\.(png|jpe?g|webp|avif)$/i.test(file.name)) {
    return 'Use a PNG, JPEG, WebP or AVIF image';
  }
  return null;
}
