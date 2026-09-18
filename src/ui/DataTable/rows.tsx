import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, ReactNode } from 'react';
import type { ViewDef } from '@/core/types';
import { cx } from '@/ui/primitives';
import { DragHandle } from './HeaderCell';
import { cellText, ruleTone, toneClass, type OrderedColumn } from './columns';

/** Must match --row-h / --row-h-compact / --row-h-roomy in theme.css. */
export const ROW_H = { compact: 26, normal: 34, roomy: 44 } as const;
/** Width of the manual-order handle column. */
export const HANDLE_W = 28;

interface CellsProps<T> {
  row: T;
  cols: OrderedColumn<T>[];
  view: ViewDef;
}

/** One row's cells. Shared by the plain and the draggable row paths. */
function Cells<T>({ row, cols, view }: CellsProps<T>) {
  return (
    <>
      {cols.map((entry) => {
        const raw = entry.column.value(row);
        const text = cellText(row, entry);
        // The product's own colouring wins, then any rule the user set for the column.
        const colour =
          toneClass(entry.column.tone?.(row) ?? null) || ruleTone(view.formatRules, entry.key, raw);
        return (
          <div
            key={entry.key}
            className="dt-cell"
            data-col={entry.key}
            data-align={entry.align}
            data-pinned={entry.stickyLeft != null}
            data-wrap={entry.wrap}
            style={entry.stickyLeft != null ? { left: `${entry.stickyLeft}px` } : undefined}
            title={text}
          >
            {entry.column.render ? (
              entry.column.render(row, { text, value: raw })
            ) : (
              <span className={cx(entry.align === 'right' && 'num', colour)}>{text}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

interface RowViewProps<T> {
  row: T;
  index: number;
  cols: OrderedColumn<T>[];
  view: ViewDef;
  template: string;
  selected: boolean;
  handle?: ReactNode;
  onRowClick?: (row: T) => void;
  onMoveFocus: (index: number) => void;
  className?: string;
  dragging?: boolean;
  rowStyle?: CSSProperties;
}

export function RowView<T>({
  row,
  index,
  cols,
  view,
  template,
  selected,
  handle,
  onRowClick,
  onMoveFocus,
  className,
  dragging = false,
  rowStyle,
}: RowViewProps<T>) {
  return (
    <div
      role="row"
      tabIndex={0}
      data-row-index={index}
      data-selected={selected}
      data-dragging={dragging}
      className={cx('dt-row', className)}
      style={{ gridTemplateColumns: template, ...rowStyle }}
      onClick={() => onRowClick?.(row)}
      onKeyDown={(e) => {
        // Arrow keys walk the grid so a keyboard user is never trapped in a cell.
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onMoveFocus(index + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          onMoveFocus(index - 1);
        } else if (e.key === 'Enter') {
          onRowClick?.(row);
        }
      }}
    >
      {handle != null ? (
        <div className="dt-cell !justify-center !px-0" data-pinned style={{ left: 0 }}>
          {handle}
        </div>
      ) : null}
      <Cells row={row} cols={cols} view={view} />
    </div>
  );
}

/** Row that participates in drag-to-reorder. Kept apart so the plain path pays nothing. */
export function SortableRow<T>(props: RowViewProps<T> & { id: string }) {
  const { id, rowStyle, ...rest } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <RowView
        {...rest}
        dragging={isDragging}
        rowStyle={rowStyle}
        handle={
          <DragHandle
            label={`Reorder ${rest.index + 1}`}
            attributes={attributes as unknown as Record<string, unknown>}
            listeners={listeners as unknown as Record<string, unknown>}
            setNodeRef={setActivatorNodeRef}
          />
        }
      />
    </div>
  );
}

export interface RowsProps<T> {
  rows: T[];
  /** Which row indexes to paint — the caller's windowing strategy decides this. */
  indices: number[];
  cols: OrderedColumn<T>[];
  view: ViewDef;
  template: string;
  getRowId: (row: T) => string;
  draggable: boolean;
  selectedId?: string | null;
  onRowClick?: (row: T) => void;
  onMoveFocus: (index: number) => void;
  rowClassName?: (row: T) => string | undefined;
  leadingPad: number;
  trailingPad: number;
}

/**
 * The row band. Windowed rows are replaced by spacers rather than absolutely
 * positioned elements: a transformed ancestor would break the pinned columns,
 * which are sticky and measured from the scroll box.
 */
export function Rows<T>({
  rows,
  indices,
  cols,
  view,
  template,
  getRowId,
  draggable,
  selectedId,
  onRowClick,
  onMoveFocus,
  rowClassName,
  leadingPad,
  trailingPad,
}: RowsProps<T>) {
  const painted = indices.flatMap((index) => {
    const row = rows[index];
    if (row === undefined) return [];
    const id = getRowId(row);
    const shared = {
      index,
      cols,
      view,
      template,
      selected: selectedId != null && selectedId === id,
      onRowClick,
      onMoveFocus,
      className: rowClassName?.(row),
    };
    return draggable
      ? [<SortableRow key={id} id={id} row={row} {...shared} />]
      : [<RowView key={id} row={row} {...shared} />];
  });

  return (
    <>
      {leadingPad > 0 ? <div style={{ height: leadingPad }} /> : null}
      {painted}
      {trailingPad > 0 ? <div style={{ height: trailingPad }} /> : null}
    </>
  );
}
