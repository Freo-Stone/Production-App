import { useEffect, useState } from 'react';

/**
 * Responsive read of one media query.
 *
 * Layout, not data: the mobile path renders fewer columns, so the query has to
 * drive rendering rather than CSS alone — rendering 42 date columns on a phone
 * would cost a frame or two on a cheap Android handset.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 1023px)');
}

export function useIsCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}
