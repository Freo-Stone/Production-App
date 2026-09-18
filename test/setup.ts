// Global test setup.
//
// IndexedDB is faked per-test-file (import 'fake-indexeddb/auto') rather than
// globally, so unit tests that don't touch the database stay fast and isolated.

const inBrowser = typeof window !== 'undefined';

/* The width the stubbed media queries answer to, and the screens listening. Hoisted
 * to module scope so `setMediaWidth` below can reach them; null means "no query
 * matches", which is what the stub did before it could be moved. */
let mediaWidth: number | null = null;
const mediaListeners = new Map<string, Set<(event: { matches: boolean }) => void>>();

function mediaMatches(query: string): boolean {
  if (mediaWidth === null) return false;
  const max = /max-width:\s*(\d+)px/.exec(query);
  if (max) return mediaWidth <= Number(max[1]);
  const min = /min-width:\s*(\d+)px/.exec(query);
  if (min) return mediaWidth >= Number(min[1]);
  return false;
}

if (inBrowser) {
  // React needs this flag or act() refuses to run outside of a test renderer.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // Cast: the DOM lib types these as always present, so a plain `in` check
  // narrows them away, and jsdom disagrees with the lib anyway.
  const w = window as typeof window & {
    ResizeObserver?: typeof ResizeObserver;
    IntersectionObserver?: typeof IntersectionObserver;
  };

  // jsdom implements none of these, and the app needs all three: media queries
  // pick the mobile column subset, the row virtualiser measures through
  // ResizeObserver, and menus observe their anchor.
  /* A viewport a test can move.
   *
   * jsdom never resizes, so a screen that changes layout at a breakpoint is only
   * ever tested on one side of it — and the bug that lives on the crossing is the
   * nasty one: a hook called in one branch and not the other ("Rendered fewer
   * hooks than expected") leaves a blank page in front of the user. `setMediaWidth`
   * below lets a test cross the line and assert the screen is still there.
   *
   * Until a test calls it, every query reports "does not match" — exactly what the
   * old always-false stub did, so no existing test changes behaviour.
   */
  const stub = (query: string): MediaQueryList => {
    const fire = (event: { matches: boolean }) => {
      for (const cb of mediaListeners.get(query) ?? []) cb(event);
    };
    const add = (cb: (event: { matches: boolean }) => void) => {
      const set = mediaListeners.get(query) ?? new Set();
      set.add(cb);
      mediaListeners.set(query, set);
    };
    const remove = (cb: (event: { matches: boolean }) => void) => {
      mediaListeners.get(query)?.delete(cb);
    };
    return {
      get matches() {
        return mediaMatches(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => add(cb),
      removeEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => remove(cb),
      addListener: (cb: (event: { matches: boolean }) => void) => add(cb),
      removeListener: (cb: (event: { matches: boolean }) => void) => remove(cb),
      dispatchEvent: () => true,
      __fire: fire,
    } as unknown as MediaQueryList;
  };
  window.matchMedia = stub as unknown as typeof window.matchMedia;

  if (!w.ResizeObserver) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    w.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }

  if (!w.IntersectionObserver) {
    class IntersectionObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    w.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
  }

  // jsdom throws "not implemented" for the scroll methods the grid calls.
  window.scrollTo = () => {};
  Element.prototype.scrollTo = () => {};
}

/**
 * Move the test viewport and tell every mounted screen about it, the way a phone
 * rotating or a window dragging narrow does. Pass `null` to go back to "nothing
 * matches", which is how a test starts.
 */
export function setMediaWidth(width: number | null): void {
  mediaWidth = width;
  for (const [query, set] of mediaListeners) {
    const matches = mediaMatches(query);
    for (const cb of set) cb({ matches });
  }
}

export {};
