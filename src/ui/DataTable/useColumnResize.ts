import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { MIN_COL_WIDTH } from './columns';

export interface LiveResize {
  key: string;
  width: number;
}

interface DragState {
  key: string;
  pointerId: number;
  startX: number;
  startWidth: number;
  min: number;
  width: number;
}

/** What the move/end handlers need — a React event or a raw window event. */
interface PointerSample {
  pointerId: number;
  clientX: number;
}

/**
 * Column resizing with pointer events.
 *
 * One implementation covers mouse, pen and touch — a separate touch path always
 * drifts out of sync, and on the floor it is used with gloved fingers, so the
 * handle is 9px of hit area around a 1px line. Width is held locally while
 * dragging and only written to the saved view on release, otherwise every pixel
 * of movement would hit IndexedDB.
 */
export function useColumnResize(onCommit: (key: string, width: number | null) => void) {
  const [live, setLive] = useState<LiveResize | null>(null);
  const drag = useRef<DragState | null>(null);

  const start = useCallback(
    (
      e: ReactPointerEvent<HTMLElement>,
      opts: { key: string; width: number; minWidth?: number },
    ): void => {
      // Right-click/middle-click on a mouse should not start a drag.
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort; the window listeners below still see the events */
      }
      const min = Math.max(MIN_COL_WIDTH, opts.minWidth ?? MIN_COL_WIDTH);
      drag.current = {
        key: opts.key,
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: opts.width,
        min,
        width: Math.max(min, opts.width),
      };
      setLive({ key: opts.key, width: drag.current.width });
    },
    [],
  );

  const move = useCallback((e: PointerSample): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.width = Math.max(d.min, Math.round(d.startWidth + (e.clientX - d.startX)));
    setLive({ key: d.key, width: d.width });
  }, []);

  const end = useCallback(
    (e: PointerSample): void => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      setLive(null);
      onCommit(d.key, d.width);
    },
    [onCommit],
  );

  /**
   * Window-level listeners for the duration of a drag.
   *
   * Pointer capture usually keeps the events coming, but it is not something to
   * bet a factory-floor touchscreen on: capture is dropped if the handle is
   * re-created under the finger (the header re-renders on every width change),
   * and without these listeners the drag would stop dead mid-move and never
   * commit the width.
   */
  const dragging = live !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => move(e);
    const onEnd = (e: PointerEvent): void => end(e);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [dragging, move, end]);

  /** Keyboard equivalent: arrows nudge, Shift nudges further, Enter resets. */
  const nudge = useCallback(
    (e: ReactKeyboardEventLike, opts: { key: string; width: number; minWidth?: number }): void => {
      const min = Math.max(MIN_COL_WIDTH, opts.minWidth ?? MIN_COL_WIDTH);
      if (e.key === 'Enter') {
        e.preventDefault();
        onCommit(opts.key, null);
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const next = Math.max(
        min,
        opts.width + (e.key === 'ArrowRight' ? step : -step),
      );
      onCommit(opts.key, next);
    },
    [onCommit],
  );

  return { live, start, move, end, nudge };
}

interface ReactKeyboardEventLike {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}
