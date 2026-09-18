import { useSyncExternalStore } from 'react';

/**
 * Hash routing, deliberately.
 *
 * The bundle is served by GitHub Pages from a sub-path, where deep links like
 * `/freo/jobs` 404 because there is no server to rewrite them. `#/jobs` always
 * resolves, and it also survives the PWA being opened from the home-screen icon.
 */

export interface Route {
  /** Normalised path, always starting with '/'. */
  path: string;
  segments: string[];
  query: URLSearchParams;
  /** Raw fragment after '#', for exact-match comparisons. */
  raw: string;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

function currentHash(): string {
  const h = window.location.hash;
  return h === '' || h === '#' ? '#/' : h;
}

function getSnapshot(): string {
  return currentHash();
}

/** Server-rendered snapshot is never available; the fallback keeps React happy. */
function getServerSnapshot(): string {
  return '#/';
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart && pathPart.startsWith('/') ? pathPart : `/${pathPart ?? ''}`;
  return {
    path,
    segments: path.split('/').filter(Boolean),
    query: new URLSearchParams(queryPart ?? ''),
    raw,
  };
}

export function useRoute(): Route {
  // Snapshot must stay a string for useSyncExternalStore; parse after reading.
  return parseHash(useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot));
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const hash = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === hash) return;
  if (opts.replace) {
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(null, '', url);
    emit();
  } else {
    window.location.hash = hash.slice(1);
  }
}

/** True for `#/matrix` style matches, ignoring the query string. */
export function routeIsActive(routePath: string, activePath: string): boolean {
  if (routePath === activePath) return true;
  return activePath.startsWith(`${routePath}/`);
}

/** Query read/write helpers so screens can keep table state in the URL. */
export function setQueryParam(name: string, value: string | null): void {
  const route = parseHash(currentHash());
  const query = new URLSearchParams(route.query);
  if (value === null) query.delete(name);
  else query.set(name, value);
  const qs = query.toString();
  navigate(qs ? `${route.path}?${qs}` : route.path, { replace: true });
}
