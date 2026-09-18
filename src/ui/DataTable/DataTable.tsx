import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useIsCompact } from '@/app/useMediaQuery';
import type { ViewDef } from '@/core/types';
import { Spinner } from '@/ui/primitives';
import { ColumnMenu, type ColumnMenuAnchor } from './ColumnMenu';
import { HeaderCell } from './HeaderCell';
import { Rows, ROW_H, HANDLE_W } from './rows';
import {
  gridTemplate,
  resolveColumns,
  sortRows,
  totalsText,
  type ColumnDef,
  type OrderedColumn,
} from './columns';
import { useColumnResize } from './useColumnResize';
import {
  sortLabel,
  sortOrdinal,
  withColumnMoved,
  withColumnVisible,
  withColumnWidth,
  withSortToggled,
} from './viewPrefs';

export type { ColumnDef } from './columns';

export interface DataTableProps<T> {
  rows: T[];
  columns: ColumnDef<T>[];
  /** Saved (or default) view: widths, order, sorting, density, formats. */
  view: ViewDef;
  onViewChange: (patch: Partial<ViewDef>) => void;
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  /** Tie-break for column sorts so a sort never scrambles a hand-made order. */
  rankOf?: (row: T) => number;
  /** Enables manual row dragging (needs view.sortMode === 'manual'). */
  onReorder?: (draggedId: string, toIndex: number) => void;
  /** Drag-to-stage: a row dropped on a column carrying `dropStage`. */
  onStageDrop?: (stage: string, draggedId: string) => void;
  rowClassName?: (row: T) => string | undefined;
  empty?: ReactNode;
  /** CSS height. Omit to fill the parent, which then needs a height of its own. */
  height?: number | string;
  loading?: boolean;
}

/** Below this many rows, virtualising costs more than it saves. */
const VIRTUAL_MIN = 40;

export function DataTable<T>({
  rows,
  columns,
  view,
  onViewChange,
  getRowId,
  onRowClick,
  selectedId,
  rankOf,
  onReorder,
  onStageDrop,
  rowClassName,
  empty,
  height,
  loading = false,
}: DataTableProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const compact = useIsCompact();
  const [menu, setMenu] = useState<ColumnMenuAnchor | null>(null);

  const draggable = view.sortMode === 'manual' && onReorder != null;

  const resolved = useMemo(() => resolveColumns(columns, view, { compact }), [columns, view, compact]);
  const visible = useMemo(() => resolved.filter((c) => c.visible), [resolved]);

  // Room for the drag-handle column; pinned columns shift right to clear it.
  const cols = useMemo(
    () =>
      draggable
        ? visible.map((c) => ({
            ...c,
            stickyLeft: c.stickyLeft == null ? null : c.stickyLeft + HANDLE_W,
          }))
        : visible,
    [visible, draggable],
  );

  const resize = useColumnResize(
    useCallback(
      (key: string, width: number | null) => {
        onViewChange({ columns: withColumnWidth(view, key, width).columns });
      },
      [onViewChange, view],
    ),
  );

  // Live widths while dragging, so the grid follows the finger before anything is saved.
  const renderCols = useMemo<OrderedColumn<T>[]>(() => {
    if (!resize.live) return cols;
    const shifted = draggable ? HANDLE_W : 0;
    let left = 0;
    return cols.map((c) => {
      const width = c.key === resize.live?.key ? resize.live.width : c.width;
      const stickyLeft = c.stickyLeft == null ? null : left + shifted;
      if (c.stickyLeft != null) left += width;
      return { ...c, width, stickyLeft };
    });
  }, [cols, resize.live, draggable]);

  const template = (draggable ? `${HANDLE_W}px ` : '') + gridTemplate(renderCols);
  const totalWidth = renderCols.reduce((n, c) => n + c.width, 0) + (draggable ? HANDLE_W : 0);

  const ordered = useMemo(
    () =>
      view.sortMode === 'manual'
        ? rows
        : sortRows(rows, resolved, view.sort, { idOf: getRowId, rank: rankOf }),
    [rows, view.sortMode, view.sort, resolved, getRowId, rankOf],
  );

  const rowH = ROW_H[view.density];
  const virtualOn = !draggable && ordered.length > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 8,
    enabled: virtualOn,
  });

  const vItems = virtualOn ? virtualizer.getVirtualItems() : null;
  const indices = vItems ? vItems.map((v) => v.index) : ordered.map((_, i) => i);
  const leadingPad = vItems ? (vItems[0]?.start ?? 0) : 0;
  const last = vItems?.[vItems.length - 1];
  const trailingPad = vItems ? Math.max(0, virtualizer.getTotalSize() - (last?.end ?? 0)) : 0;

  const sensors = useSensors(
    // A 6px threshold keeps a tap on a row from becoming a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Space to pick a row up, arrows to walk it, space to drop. The pointer is
    // the fast way and the keyboard is the precise one — both write the same rank.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const focusRow = useCallback((index: number) => {
    scroller.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)?.focus();
  }, []);

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over) return;
    const draggedId = String(active.id);
    const stage = (over.data.current as { stage?: string } | undefined)?.stage;
    if (stage && onStageDrop) {
      onStageDrop(stage, draggedId);
      return;
    }
    if (!onReorder || String(over.id) === draggedId) return;
    const to = ordered.findIndex((r) => getRowId(r) === String(over.id));
    if (to >= 0) onReorder(draggedId, to);
  };

  const showTotals = view.showTotals && ordered.length > 0 && columns.some((c) => c.totals != null && c.totals !== 'none');

  return (
    // With no `height`, "fill the parent" has to mean h-full. Without it this box
    // takes its content's height, so the scroller below grows to the height of
    // every row in the table (measured: 91,673px for 1,102 job lines), the virtualiser
    // measures that as the visible window and renders everything, and the card
    // around it — which clips, as cards do — cuts the rest off. The rows below the
    // fold then belonged to no scroll: the wheel moved the page, the table stayed
    // put, and the bottom of it was simply gone. Both screens that mount it this way
    // had it; Sources showed twelve of 1,102 lines and no way to reach the rest.
    <div
      className={height == null ? 'flex h-full min-h-0 flex-col' : 'flex min-h-0 flex-col'}
      style={height != null ? { height } : undefined}
    >
      <div
        ref={scroller}
        data-density={view.density}
        className="relative min-h-0 flex-1 overflow-auto overscroll-x-contain"
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          {/* ── Header ─────────────────────────────────────────────────────── */}
          <div className="dt-head" style={{ gridTemplateColumns: template, width: totalWidth }}>
            {draggable ? (
              <div className="dt-headcell !px-0" data-pinned style={{ left: 0 }} aria-hidden="true" />
            ) : null}
            {renderCols.map((entry) => (
              <HeaderCell
                key={entry.key}
                id={entry.key}
                header={entry.column.header}
                hint={entry.column.headerHint}
                align={entry.align}
                sortable={entry.column.sortable !== false}
                sortDir={view.sortMode === 'manual' ? null : sortLabel(view, entry.key)}
                sortIndex={view.sort.length > 1 ? sortOrdinal(view, entry.key) : -1}
                stickyLeft={entry.stickyLeft}
                dropStage={entry.column.dropStage}
                resizing={resize.live?.key === entry.key}
                onSort={(additive) => {
                  // Emit only what changed, never a whole view document.
                  const next = withSortToggled(view, entry.key, additive);
                  onViewChange({ sort: next.sort, sortMode: next.sortMode });
                }}
                onMenu={(x, y) =>
                  setMenu({
                    key: entry.key,
                    header: entry.column.header,
                    x,
                    y,
                    canHide: renderCols.length > 1,
                    isPinned: entry.stickyLeft != null,
                    widthIsCustom: view.columns.find((c) => c.key === entry.key)?.width != null,
                  })
                }
                onResizeStart={(e) =>
                  resize.start(e, { key: entry.key, width: entry.width, minWidth: entry.column.minWidth })
                }
                onResizeMove={resize.move}
                onResizeEnd={resize.end}
                onResizeKeys={(e) =>
                  resize.nudge(e, { key: entry.key, width: entry.width, minWidth: entry.column.minWidth })
                }
              />
            ))}
          </div>

          {/* ── Rows ────────────────────────────────────────────────────────── */}
          {ordered.length === 0 ? (
            <div style={{ width: totalWidth }}>
              {loading ? (
                <div className="flex items-center gap-2 px-3 py-6 text-ink3">
                  <Spinner /> Loading…
                </div>
              ) : (
                empty ?? <div className="px-3 py-6 text-sm text-ink3">Nothing to show.</div>
              )}
            </div>
          ) : draggable ? (
            /* SortableContext only exists when manual ordering is on, so the
               plain path pays nothing for the drag machinery. */
            <SortableContext items={ordered.map(getRowId)} strategy={verticalListSortingStrategy}>
              <Rows
                rows={ordered}
                indices={indices}
                cols={renderCols}
                view={view}
                template={template}
                getRowId={getRowId}
                draggable
                selectedId={selectedId}
                onRowClick={onRowClick}
                onMoveFocus={focusRow}
                rowClassName={rowClassName}
                leadingPad={leadingPad}
                trailingPad={trailingPad}
              />
            </SortableContext>
          ) : (
            <Rows
              rows={ordered}
              indices={indices}
              cols={renderCols}
              view={view}
              template={template}
              getRowId={getRowId}
              draggable={false}
              selectedId={selectedId}
              onRowClick={onRowClick}
              onMoveFocus={focusRow}
              rowClassName={rowClassName}
              leadingPad={leadingPad}
              trailingPad={trailingPad}
            />
          )}


          {/* ── Totals ─────────────────────────────────────────────────────── */}
          {showTotals ? (
            <div className="dt-totals" role="row" style={{ gridTemplateColumns: template, width: totalWidth }}>
              {draggable ? <div className="dt-cell" /> : null}
              {renderCols.map((entry, i) => (
                <div
                  key={entry.key}
                  className="dt-cell"
                  data-align={entry.align}
                  data-pinned={entry.stickyLeft != null}
                  style={entry.stickyLeft != null ? { left: `${entry.stickyLeft}px` } : undefined}
                >
                  <span className={entry.align === 'right' ? 'num' : undefined}>
                    {totalsText(entry, ordered) || (i === 0 ? `Total · ${ordered.length}` : '')}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        </DndContext>
      </div>

      {menu ? (
        <ColumnMenu
          anchor={menu}
          onClose={() => setMenu(null)}
          onSort={(dir) => onViewChange({ sort: [{ key: menu.key, dir }], sortMode: 'column' })}
          onHide={() => onViewChange({ columns: withColumnVisible(view, menu.key, false).columns })}
          onTogglePin={() =>
            onViewChange({
              stickyFirstColumn: !view.stickyFirstColumn,
              // Pinning only works for the leading run, so move the column there.
              columns: view.stickyFirstColumn ? view.columns : withColumnMoved(view, menu.key, 0).columns,
            })
          }
          onResetWidth={() => onViewChange({ columns: withColumnWidth(view, menu.key, null).columns })}
          onAllToThisWidth={() =>
            onViewChange({
              columns: view.columns.map((c) =>
                c.key === menu.key
                  ? c
                  : { ...c, width: view.columns.find((x) => x.key === menu.key)?.width ?? null },
              ),
            })
          }
        />
      ) : null}
    </div>
  );
}

/** Kept importable so screens can size their own row windows. */
export { ROW_H };
