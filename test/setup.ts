// Global test setup.
//
// IndexedDB is faked per-test-file (import 'fake-indexeddb/auto') rather than
// globally, so unit tests that don't touch the database stay fast and isolated.

const inBrowser = typeof window !== 'undefined';

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
  if (!window.matchMedia) {
    const stub = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList;
    window.matchMedia = stub as unknown as typeof window.matchMedia;
  }

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

export {};
