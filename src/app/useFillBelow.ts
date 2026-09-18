import { useCallback, useEffect, useState } from 'react';

/**
 * How tall an element needs to be to reach the bottom of the window.
 *
 * The grid screens used to guess: 64vh here, 62vh there. A guess is wrong in
 * whichever direction the chrome above happens to move — a tall window left a
 * strip of empty page under the table and a short one pushed the table's bottom
 * rows off the screen — and on a phone `vh` does not know about the browser's own
 * bars at all. Measuring is shorter and true: the space between where this element
 * starts and where the window ends, minus whatever sits underneath it.
 *
 * `gap` is what lives below the element: the page's bottom padding, a footnote, the
 * phone's bottom bar. `min` keeps a table usable when something above has pushed it
 * so far down that only a couple of rows would fit — the page scrolls in that case,
 * which is what a person expects from a page that has run out of room.
 */
export function useFillBelow({ gap = 12, min = 280 }: { gap?: number; min?: number } = {}): {
  ref: (node: HTMLDivElement | null) => void;
  height: number | null;
} {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    const next = Math.max(min, Math.round(globalThis.window ? window.innerHeight - top - gap : min));
    setHeight((prev) => (prev === next ? prev : next));
  }, [node, gap, min]);

  useEffect(() => {
    if (!node) return;
    measure();
    // What has to be watched is anything that can move this element's top edge:
    // the window resizing, a phone's URL bar sliding in, a banner opening above,
    // the line of facts wrapping when its webfont arrives. The obvious single
    // observer on the document misses the last of those — when the facts grow by
    // 12px and this box shrinks by 12px, the document is exactly as tall as it was
    // and never tells anyone. So every element that sits *above* this one, at
    // every level out to the page, is watched in its own right.
    const watched: Element[] = [document.documentElement];
    for (let el: Element | null = node; el && el !== document.body; el = el.parentElement) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) watched.push(sib);
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    for (const el of watched) observer?.observe(el);
    globalThis.window?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      globalThis.window?.removeEventListener('resize', measure);
    };
  }, [node, measure]);

  return { ref: setNode, height };
}
