// Dropped and picked files, and the hand-off from the home page to the viewer.
// No Three.js imports: the home page bundles this module.

/** A file with the path it was dropped or picked with (folders keep relative paths). */
export interface PathedFile {
  file: File;
  path: string;
}

export const isModelFile = (name: string) => /\.(glb|gltf|pbrt|pbrt\.gz)$/i.test(name);
export const isHDRFile = (name: string) => name.toLowerCase().endsWith('.hdr');
/** A MaterialX document, or a zip package of one with its textures. */
export const isMaterialXFile = (name: string) => /\.(mtlx|zip)$/i.test(name);

/** Reads dropped items, descending into folders. */
export async function readDroppedItems(items: DataTransferItemList): Promise<PathedFile[]> {
  const entries = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  const out: PathedFile[] = [];
  const visit = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        await Promise.all(batch.map((child) => visit(child, `${prefix}${entry.name}/`)));
      }
    }
  };
  await Promise.all(entries.map((entry) => visit(entry, '')));
  return out;
}

export function toPathedFiles(files: FileList | File[]): PathedFile[] {
  return Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

// The home page and the viewer share an origin, so files dropped on the home
// page travel to the viewer through IndexedDB (Files are structured-cloneable,
// and browsers store them by reference rather than copying them into memory).
const DB_NAME = 'mutracer-handoff';
const STORE = 'files';
const KEY = 'pending';

/** Viewer URL hash flag that asks it to load the stashed files. */
export const HANDOFF_HASH = 'open=files';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}

/** Stores files for the next viewer page load. Replaces any earlier hand-off. */
export function stashFiles(files: PathedFile[]): Promise<void> {
  return transact('readwrite', (store) => store.put(files, KEY)).then(() => undefined);
}

/** Returns and clears the stashed files, or `null` when there are none or storage is unavailable. */
export async function takeStashedFiles(): Promise<PathedFile[] | null> {
  try {
    const files = await transact<PathedFile[] | undefined>('readonly', (store) => store.get(KEY));
    await transact('readwrite', (store) => store.delete(KEY));
    return files?.length ? files : null;
  } catch {
    return null;
  }
}
