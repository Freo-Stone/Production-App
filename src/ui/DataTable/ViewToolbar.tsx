import type { ReactNode } from 'react';
import type { ViewDef } from '@/core/types';
import { Icon } from '@/ui/Icon';
import { Button, Chip, IconButton, Popover, Segmented, Toggle, cx } from '@/ui/primitives';
import { withColumnVisible } from './viewPrefs';

export interface ViewToolbarProps {
  view: ViewDef;
  patch: (patch: Partial<ViewDef>) => void;
  /** Every column the screen declares, for the show/hide list. */
  columns: Array<{ key: string; header: string }>;
  /** True when this person has their own saved layout for this screen. */
  isPersonal: boolean;
  hasShared: boolean;
  onResetToShared: () => void;
  onPublishDefault: () => void;
  /** Screen-specific controls: search, horizon picker, filters. */
  extra?: ReactNode;
  /** Screens without row dragging have no business offering manual order. */
  allowManualOrder?: boolean;
  className?: string;
}

/**
 * The controls that belong to a *view*, not to the data: ordering mode, density,
 * visible columns, and who the layout is saved for.
 *
 * The two save buttons are deliberately different: "Save for me" is the everyday
 * one, "Set as default" is a deliberate act that changes what everyone else sees.
 */
export function ViewToolbar({
  view,
  patch,
  columns,
  isPersonal,
  hasShared,
  onResetToShared,
  onPublishDefault,
  extra,
  allowManualOrder = false,
  className,
}: ViewToolbarProps) {
  const visibleCount = view.columns.filter((c) => c.visible).length;

  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{extra}</div>

      <div className="flex flex-wrap items-center gap-1.5">
        {allowManualOrder ? (
          <Segmented
            size="sm"
            value={view.sortMode}
            onChange={(mode) => patch({ sortMode: mode, sort: mode === 'manual' ? [] : view.sort })}
            options={[
              { value: 'column' as const, label: 'Sorted', title: 'Order rows by a column' },
              { value: 'manual' as const, label: 'Drag order', title: 'Drag rows into your own order' },
            ]}
          />
        ) : null}

        <Segmented
          size="sm"
          value={view.density}
          onChange={(density) => patch({ density })}
          options={[
            { value: 'compact' as const, label: 'S', title: 'Compact rows' },
            { value: 'normal' as const, label: 'M', title: 'Normal rows' },
            { value: 'roomy' as const, label: 'L', title: 'Roomy rows for gloves' },
          ]}
        />

        <Popover
          label={<span className="hidden sm:inline">Columns</span>}
          icon="columns"
          width={290}
        >
          {() => (
          <div className="flex flex-col gap-1">
            <p className="pb-1 text-[0.7rem] font-700 uppercase tracking-wide text-ink3">
              Showing {visibleCount} of {columns.length}
            </p>
            {columns.map((col) => {
              const pref = view.columns.find((c) => c.key === col.key);
              const visible = pref ? pref.visible : true;
              return (
                <label key={col.key} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface3">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={(e) => patch({ columns: withColumnVisible(view, col.key, e.target.checked).columns })}
                    className="size-3.5 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[0.84rem]">{col.header}</span>
                  {view.mobileColumns ? (
                    <span className={cx('text-[0.7rem]', view.mobileColumns.includes(col.key) ? 'text-curing' : 'text-ink3')}>
                      phone
                    </span>
                  ) : null}
                </label>
              );
            })}

            <div className="mt-1 border-t border-line pt-2">
              <Toggle
                checked={view.showTotals}
                onChange={(showTotals) => patch({ showTotals })}
                label="Totals row"
              />
              <Toggle
                checked={view.stickyFirstColumn}
                onChange={(stickyFirstColumn) => patch({ stickyFirstColumn })}
                label="Pin leading columns"
                hint="Keeps the code and stock columns in place when scrolling sideways"
              />
              <p className="pt-2 text-[0.7rem] text-ink3">
                Double-click a column edge to fit it, or drag it. Right-click a header for more.
              </p>
            </div>
          </div>
          )}
        </Popover>

        {isPersonal ? (
          <>
            <IconButton
              icon="undo"
              label={hasShared ? 'Discard my layout and use the default' : 'Discard my layout'}
              onClick={onResetToShared}
            />
            <Button size="sm" icon="save" onClick={onPublishDefault} title="Everyone else sees this layout too">
              <span className="hidden sm:inline">Set as default</span>
            </Button>
          </>
        ) : (
          <Chip tone="info" icon="user" title="You are looking at the shared default layout">
            <span className="hidden sm:inline">Default view</span>
          </Chip>
        )}

        {view.sortMode === 'manual' ? (
          <span title="Drag the handle to reorder">
            <Icon name="grip" size={14} className="text-ink3" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Horizon picker for date grids: display-only, never changes the maths. */
export function HorizonPicker({
  value,
  onChange,
}: {
  value: ViewDef['horizonWeeks'];
  onChange: (weeks: ViewDef['horizonWeeks']) => void;
}) {
  return (
    <Segmented
      size="sm"
      value={String(value)}
      onChange={(v) => onChange(v === 'all' ? 'all' : (Number(v) as 1 | 2 | 4 | 6))}
      options={[
        { value: '1', label: '1 wk' },
        { value: '2', label: '2 wk' },
        { value: '4', label: '4 wk' },
        { value: '6', label: '6 wk' },
        { value: 'all', label: 'All' },
      ]}
    />
  );
}
