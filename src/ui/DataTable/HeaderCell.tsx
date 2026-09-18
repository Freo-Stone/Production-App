import { useDroppable } from '@dnd-kit/core';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '@/ui/Icon';
import { cx } from '@/ui/primitives';

/**
 * Invisible drop target covering a header cell, so a row can be dragged onto a
 * stage column. pointer-events:none keeps the header clickable: dnd-kit measures
 * the rectangle, it does not need to receive the pointer itself.
 */
export function StageDroppable({ stage }: { stage: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage}`, data: { stage } });
  return (
    <div
      ref={setNodeRef}
      data-stage={isOver ? 'over' : undefined}
      className="pointer-events-none absolute inset-0 z-[1]"
    />
  );
}

export interface HeaderCellProps {
  id: string;
  header: string;
  hint?: string;
  align: 'left' | 'right' | 'center';
  sortable: boolean;
  sortDir: 'asc' | 'desc' | null;
  /** 0-based position in a multi-column sort; -1 when it is the only sort. */
  sortIndex: number;
  stickyLeft: number | null;
  dropStage?: string;
  resizing: boolean;
  onSort: (additive: boolean) => void;
  onMenu: (x: number, y: number) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeys: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function HeaderCell({
  id,
  header,
  hint,
  align,
  sortable,
  sortDir,
  sortIndex,
  stickyLeft,
  dropStage,
  resizing,
  onSort,
  onMenu,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeys,
}: HeaderCellProps) {
  const label =
    sortDir == null
      ? `Sort by ${header}`
      : `Sorted ${sortDir === 'asc' ? 'ascending' : 'descending'}${sortIndex >= 0 ? ` (level ${sortIndex + 1})` : ''} — click to change`;

  return (
    <div
      className="dt-headcell"
      role="columnheader"
      // The column key, on the header. Its own attribute name on purpose: tests and
      // anything else that addresses a column say `[data-col="code"]` for the cells,
      // and a header answering to the same name turns "the code column" into "the
      // code column including its heading", which reads as an extra row of data.
      data-headcol={id}
      aria-sort={sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none'}
      data-align={align}
      data-sortable={sortable}
      data-pinned={stickyLeft != null}
      style={{ left: stickyLeft ?? undefined }}
      title={hint ?? header}
      aria-label={label}
      onClick={(e) => {
        if (sortable) onSort(e.shiftKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      tabIndex={sortable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!sortable) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(e.shiftKey);
        }
      }}
    >
      {dropStage ? <StageDroppable stage={dropStage} /> : null}
      <span className="truncate">{header}</span>
      {sortDir ? (
        <Icon
          name={sortDir === 'asc' ? 'chevronUp' : 'chevronDown'}
          size={13}
          className="shrink-0 text-accent"
        />
      ) : null}
      <button
        type="button"
        aria-label={`Options for ${header}`}
        className="absolute right-2.5 top-0 grid h-full place-items-center px-1 text-ink3/70 hover:text-ink"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom);
        }}
      >
        <Icon name="more" size={13} />
      </button>

      {/* Resize handle: pointer events cover mouse, pen and touch. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${header} column`}
        tabIndex={0}
        className="dt-resize"
        data-live={resizing ? '1' : undefined}
        title="Drag to resize · double-click to fit · arrow keys to nudge"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onResizeKeys({ key: 'Enter', shiftKey: false, preventDefault: () => {} } as never);
        }}
        onKeyDown={onResizeKeys}
      />
    </div>
  );
}

/** Row drag handle. Kept separate so a plain row click never starts a drag. */
export function DragHandle({
  listeners,
  attributes,
  setNodeRef,
  label,
}: {
  listeners?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  setNodeRef?: (el: HTMLElement | null) => void;
  label: string;
}) {
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-label={label}
      title={label}
      className={cx('btn btn-ghost !px-1 !py-0 text-ink3')}
      style={{ touchAction: 'none' }}
      {...attributes}
      {...listeners}
    >
      <Icon name="grip" size={14} />
    </button>
  );
}
