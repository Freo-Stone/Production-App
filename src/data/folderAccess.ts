/**
 * The browser's part of the folder watch: remembering a folder, and reading two
 * workbooks out of it.
 *
 * Everything here is a thin seam over the File System Access API, and it is kept
 * thin on purpose — the *rules* (is this file worth publishing? is it still being
 * written? is it the report its name claims?) live in `core/folderSource.ts` and
 * `data/folderPublish.ts` where they can be tested against the shop's own
 * workbooks. What lives here cannot be tested properly from this repository at
 * all: `showDirectoryPicker` is a native dialog, and the permission answer comes
 * from the browser, not from us. So there is one deliberate seam —
 * {@link FolderSource} — and the watch is written against that.
 *
 * Three things about this API are worth knowing before reading the code:
 *
 * - **Chrome and Edge only.** Firefox and Safari do not ship the local-disk
 *   pickers. `supportsFolders()` is the honest answer and the screen says it
 *   rather than showing a button that does nothing.
 * - **The handle outlives the page but not the permission.** A
 *   `FileSystemDirectoryHandle` can be stored in IndexedDB and reopened, which is
 *   how the app knows which folder it means tomorrow morning. What it cannot do is
 *   read the folder without the browser agreeing, and after a browser restart the
 *   browser wants one more click. That click is `requestAccess()`, and it only
 *   works from a real gesture — so it has to be a button on the screen, and the
 *   state that leads the eye to that button has to be impossible to miss.
 * - **A file in a synced folder may not be on the computer yet.** OneDrive shows a
 *   file's name and size before it downloads the bytes. Asking for the bytes pulls
 *   them across the internet, which is fine but slow, and fails outright with no
 *   signal. So the watch reads metadata every tick and bytes only when the
 *   metadata says something changed.
 */

import type { FolderFile } from '@/core/folderSource';
import { db, getMeta, setMeta } from './db';

/** What this device can do about a folder right now, and what to say about it. */
export type FolderAccessState =
  /** This browser has no folder picker. Nothing on the screen can fix that. */
  | 'unsupported'
  /** Supported, but nobody on this computer has picked a folder yet. */
  | 'none'
  /** A folder is remembered; the browser wants one click before it will be read. */
  | 'needs-a-click'
  /** The person on this computer said no to the browser's prompt. */
  | 'denied'
  /** Ready to read. */
  | 'ready';

export interface FolderAccessStatus {
  state: FolderAccessState;
  /** The folder's own name, as Windows shows it. Empty when there is none. */
  folderName: string;
  /** The sentence for the screen. Never empty. */
  detail: string;
}

/**
 * What the watch needs from a folder. Tests hand this a plain object; the browser
 * gets the one built here.
 */
export interface FolderSource {
  status(): Promise<FolderAccessStatus>;
  /** Every file in the folder, directories excluded. Names as the folder has them. */
  list(): Promise<FolderFile[]>;
  /** The bytes of one file, or null when it is not there (or would not download). */
  read(name: string): Promise<Uint8Array | null>;
}

/** Shape we actually use, so this module does not depend on which lib.dom version is installed. */
interface FileHandleLike {
  kind: string;
  name: string;
  getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

interface DirectoryHandleLike {
  name: string;
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>;
  queryPermission?(request: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(request: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface PickerWindow {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }): Promise<DirectoryHandleLike>;
}

/** One row in `meta`: the folder this browser was shown, and its handle. */
export const FOLDER_HANDLE_KEY = 'folder.handle';

interface StoredFolder {
  name: string;
  handle: DirectoryHandleLike;
}

/**
 * The handle for this page load. The browser will not let us read a folder from a
 * timer without it, and IndexedDB may hold one from yesterday that has not been
 * re-authorised — which is why `needs-a-click` is a state the screen must show
 * rather than an error to log.
 */
let session: DirectoryHandleLike | null = null;

export function supportsFolders(): boolean {
  return typeof (globalThis as Partial<PickerWindow>).showDirectoryPicker === 'function';
}

function status(state: FolderAccessState, folderName: string, detail: string): FolderAccessStatus {
  return { state, folderName, detail };
}

/**
 * The folder this computer pointed the app at, if any.
 *
 * Reads the stored handle once per call rather than caching the answer, because the
 * permission answer changes during the day (a click grants it, a browser restart
 * takes it back) and a screen that shows yesterday's permission state is worse than
 * one that asks.
 */
async function storedFolder(): Promise<StoredFolder | null> {
  const stored = await getMeta<StoredFolder | null>(FOLDER_HANDLE_KEY, null);
  if (stored == null || typeof stored.name !== 'string' || stored.handle == null) return null;
  return { name: stored.name, handle: stored.handle };
}

/**
 * The handle to read from when the permission says we may.
 *
 * Either the one picked on this page load, or the one remembered from yesterday —
 * Chrome answers `granted` for a remembered handle without asking again in some
 * versions, and a watch that only looked at the session handle would then report
 * "watching" while listing nothing at all.
 */
async function usableHandle(): Promise<DirectoryHandleLike | null> {
  if (session != null) return session;
  const stored = await storedFolder();
  return stored?.handle ?? null;
}

export async function folderStatus(): Promise<FolderAccessStatus> {
  if (!supportsFolders()) {
    return status(
      'unsupported',
      '',
      'this browser cannot open a folder — Chrome or Edge on Windows can, and dropping the files in by hand still works here',
    );
  }
  const stored = await storedFolder();
  if (stored == null && session == null) {
    return status('none', '', 'no folder chosen on this computer yet');
  }
  const handle = session ?? stored?.handle ?? null;
  const name = handle?.name ?? stored?.name ?? '';
  if (handle == null) return status('none', '', 'no folder chosen on this computer yet');

  // `queryPermission` is the non-standard part of the API: on a browser that has
  // the picker but not this method we simply ask, and the browser answers without
  // prompting when it already said yes.
  if (typeof handle.queryPermission !== 'function') return status('ready', name, `watching ${name}`);
  const permission = await handle.queryPermission({ mode: 'read' });
  if (permission === 'granted') return status('ready', name, `watching ${name}`);
  if (permission === 'denied') {
    return status('denied', name, `this computer said no to reading ${name} — choose the folder again to change that`);
  }
  return status('needs-a-click', name, `${name} is remembered, and needs one click to be read again`);
}

/**
 * Show the picker and remember what was picked.
 *
 * Must be called from a click. A cancelled dialog comes back as an `AbortError`,
 * which is not a failure and is not reported as one — the person was allowed to
 * change their mind.
 */
export async function chooseFolder(): Promise<FolderAccessStatus> {
  const picker = (globalThis as Partial<PickerWindow>).showDirectoryPicker;
  if (typeof picker !== 'function') {
    return status('unsupported', '', 'this browser cannot open a folder — Chrome or Edge on Windows can');
  }
  let handle: DirectoryHandleLike;
  try {
    handle = await picker.call(globalThis, { id: 'freo-exports', mode: 'read', startIn: 'documents' });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError') return folderStatus();
    return status(
      (await folderStatus()).state,
      '',
      `the folder could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  session = handle;
  try {
    await setMeta(FOLDER_HANDLE_KEY, { name: handle.name, handle });
  } catch (error) {
    // A browser that will not store the handle still watches for the rest of this
    // page load, and the person needs to know it will not survive a reload.
    console.warn('[freo] the folder handle could not be stored for next time', error);
  }
  // Choosing the folder *is* the permission, so ask straight away rather than
  // waiting for the first tick to discover it needs another click.
  await requestAccess();
  return folderStatus();
}

/** One click: "yes, read that folder again". Only works from a real gesture. */
export async function requestAccess(): Promise<FolderAccessStatus> {
  const stored = await storedFolder();
  const handle = session ?? stored?.handle ?? null;
  if (handle == null) return folderStatus();
  session = handle;
  if (typeof handle.requestPermission === 'function') {
    try {
      await handle.requestPermission({ mode: 'read' });
    } catch (error) {
      console.warn('[freo] the browser refused to re-grant the folder', error);
    }
  }
  return folderStatus();
}

/** Stop watching, and forget the folder. Nothing else on this device changes. */
export async function forgetFolder(): Promise<void> {
  session = null;
  await db.meta.delete(FOLDER_HANDLE_KEY);
}

/** Only for tests: what this page is holding in memory. */
export function sessionFolderName(): string {
  return session?.name ?? '';
}

async function filesIn(handle: DirectoryHandleLike): Promise<{ handles: FileHandleLike[]; files: FolderFile[] }> {
  const handles: FileHandleLike[] = [];
  const files: FolderFile[] = [];
  for await (const entry of handle.values()) {
    const child = entry as FileHandleLike;
    // Folders inside the folder are not exports, and descending into them would
    // pick up whatever else lives under the picked folder.
    if (child.kind !== 'file') continue;
    handles.push(child);
    // `getFile()` gives size and time without reading the bytes.
    const file = await child.getFile();
    files.push({ name: child.name, sizeBytes: file.size, modifiedAt: file.lastModified });
  }
  return { handles, files };
}

/** The watch's real folder. Safe to construct even on an unsupported browser. */
export function browserFolderSource(): FolderSource {
  return {
    status: folderStatus,
    async list() {
      const ready = await folderStatus();
      if (ready.state !== 'ready') return [];
      const handle = await usableHandle();
      if (handle == null) return [];
      return (await filesIn(handle)).files;
    },
    async read(name) {
      const ready = await folderStatus();
      if (ready.state !== 'ready') return null;
      const handle = await usableHandle();
      if (handle == null) return null;
      const { handles } = await filesIn(handle);
      const wanted = handles.find((h) => h.name === name);
      if (wanted == null) return null;
      try {
        const file = await wanted.getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        // The usual cause is OneDrive showing a file it has not downloaded while
        // the shop has no signal. That is a sentence for the screen, not a stack.
        console.warn('[freo] the folder would not give up its bytes', name, error);
        return null;
      }
    },
  };
}
