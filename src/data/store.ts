/**
 * What holds the shop's data.
 *
 * The app has always talked to a repository through a small number of calls, and
 * nothing above this file has ever known the difference between a merge and a
 * commit. This file names that seam properly, so a second implementation can sit
 * beside the first: the same app, served from and storing to a machine the shop
 * owns. See `docs/server.md` for why, and `server/` for the thing it talks to.
 *
 * Two rules keep this honest:
 *
 * - **Compare-and-set, always.** Every write carries the number the writer last
 *   read, and a writer whose number is out of date gets `ConflictError` with the
 *   number the store holds now. That is how two floors typing at once end up
 *   merged rather than lost, and it is why the number has to mean the same thing
 *   in both stores: it is the git blob sha of the bytes, in the repository and on
 *   the server alike.
 * - **`null` means empty, never failure.** "Nothing has been written yet" is the
 *   normal state of a new store, and treating it as an error would stop a first
 *   run for a reason that is not wrong.
 */

import { ConflictError } from './github';
import type { StateDocument } from '@/data/merge';
import type { TokenCheck } from './github';

/** A read result: the document and the number that makes a later write safe. */
export interface StateSlot {
  sha: string;
  content: StateDocument;
}

/** A read result for a file we keep as bytes — the MYOB workbooks. */
export interface BinarySlot {
  sha: string;
  bytes: Uint8Array;
}

/**
 * Everything the app asks a store to do. `GitHubClient` satisfies it as it stands;
 * {@link ServerStore} is the second answer.
 *
 * `kind` is not decoration. A person looking at Settings is entitled to know which
 * machine their numbers are sitting on, because the answer changes where they look
 * when something goes wrong.
 */
export interface ShopStore {
  readonly kind: 'github' | 'server';

  /** The shop document, or `null` when nothing has been written yet. */
  getState(): Promise<StateSlot | null>;

  /** Compare-and-set write of the shop document. `sha: null` creates it. */
  putState(content: StateDocument, sha: string | null, message: string): Promise<{ sha: string }>;

  /** A binary file — the mirrored workbook — or `null` when it is not there. */
  getBinaryFile(path: string): Promise<BinarySlot | null>;

  /** What a file is worth right now, without fetching it. */
  getEntrySha(path: string): Promise<string | null>;

  /** Compare-and-set write of a binary file. `sha: null` creates it. */
  putBinaryFile(path: string, bytes: Uint8Array, sha: string | null, message: string): Promise<{ sha: string }>;

  /** Can this device actually reach and write the store, and if not, what to do. */
  validateToken(probe?: boolean): Promise<TokenCheck>;
}

/**
 * The store cannot be reached, or answered something that is not an answer.
 *
 * Deliberately a different error from {@link ConflictError}: a conflict is a normal
 * part of two people working at once, and the caller merges and tries again. This is
 * not normal, and nothing should retry it quietly.
 */
export class StoreError extends Error {
  constructor(
    readonly detail: string,
    readonly status: number = 0,
    readonly store: 'github' | 'server' = 'server',
  ) {
    super(detail);
    this.name = 'StoreError';
  }
}

export { ConflictError };
export type { TokenCheck };
