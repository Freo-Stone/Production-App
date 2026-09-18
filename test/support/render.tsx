import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface Rendered {
  host: HTMLElement;
  root: Root;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
  /** Cells of a row, in visual order. */
  rowCells: (rowIndex: number) => string[];
  headerLabels: () => string[];
}

/**
 * Minimal render harness.
 *
 * No testing-library: the app's UI is a grid of divs with roles, and asserting
 * on `role="row"`/`role="columnheader"` directly keeps the dependency surface
 * small and the assertions honest about what a screen reader would see.
 */
export function render(node: ReactNode): Rendered {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));

  return {
    host,
    root,
    rerender: (next) =>
      act(() => {
        root.render(next);
      }),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
    rowCells: (rowIndex) => {
      const rows = host.querySelectorAll<HTMLElement>('[role="row"]');
      const row = rows[rowIndex];
      if (!row) return [];
      return [...row.querySelectorAll('.dt-cell')].map((c) => (c.textContent ?? '').trim());
    },
    headerLabels: () =>
      [...host.querySelectorAll('[role="columnheader"]')].map((h) => (h.textContent ?? '').trim()),
  };
}

/**
 * Type into a controlled input the way a keyboard does: the value goes in through the
 * prototype setter (React keeps its own copy), then an `input` event that bubbles.
 */
export function typeInto(target: Element, value: string): void {
  const input = target as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    input.focus();
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Let queued promises and React's scheduler run between two assertions. */
export async function settle(times = 6, ms = 0): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

/**
 * Wait for something the screen will do on its own, then let React paint it.
 *
 * Sign-in hashes the passcode at the app's real cost — a couple of hundred
 * milliseconds of WebCrypto — so a fixed number of macrotask turns is the wrong
 * wait: it finishes while the hash is still running and the assertion below reads a
 * screen that has not caught up. Polling for the outcome is both faster when it is
 * already true and correct when it is slow.
 */
export async function waitUntil(
  what: () => boolean,
  describe: string,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (what()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${describe}`);
  }
}

/**
 * The innermost element whose text contains `text`. Innermost because a sentence
 * broken across a nested link or button still reads as one sentence to a person —
 * and to `textContent`.
 */
export function byText(host: HTMLElement, text: string): HTMLElement {
  const matches = [...host.querySelectorAll<HTMLElement>('*')].filter((el) =>
    (el.textContent ?? '').includes(text),
  );
  const innermost = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
  const found = innermost[0];
  if (!found) {
    throw new Error(`nothing on screen contains "${text}".\n--- screen ---\n${host.textContent ?? ''}`);
  }
  return found;
}

export function fieldByLabel(host: HTMLElement, label: string): HTMLInputElement {
  const labelled = [...host.querySelectorAll<HTMLElement>('label')].find((l) =>
    (l.textContent ?? '').startsWith(label),
  );
  const input = labelled?.querySelector('input');
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input as HTMLInputElement;
}

export function buttonNamed(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.textContent ?? '').trim().includes(name),
  );
  if (!found) {
    throw new Error(
      `no button containing "${name}". Buttons: ${[...host.querySelectorAll<HTMLButtonElement>('button')]
        .map((b) => JSON.stringify((b.textContent ?? '').trim()))
        .join(', ')}`,
    );
  }
  return found;
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

export function headerNamed(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll('[role="columnheader"]')].find((h) =>
    (h.textContent ?? '').startsWith(label),
  );
  if (!found) throw new Error(`no column header matching "${label}"`);
  return found as HTMLElement;
}

export function rows(host: HTMLElement): HTMLElement[] {
  // role="row" includes the totals row, which is marked with .dt-totals.
  return [...host.querySelectorAll<HTMLElement>('[role="row"]:not(.dt-totals)')];
}

export function cellTexts(host: HTMLElement, columnIndex: number): string[] {
  return rows(host).map((r) => (r.querySelectorAll('.dt-cell')[columnIndex]?.textContent ?? '').trim());
}
