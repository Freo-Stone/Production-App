import { useState, type ReactNode } from 'react';
import { cx } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';

/**
 * Editors that live inside a table cell.
 *
 * A row in this app is also a button (it opens the record), and the grid walks
 * with the arrow keys. Anything editable therefore has to keep its events to
 * itself: `stopPropagation` on pointer/click stops the row opening under the
 * finger, and `keydown` stops an arrow key press in a number field from moving
 * the focus to the next row.
 */
function isolate(e: { stopPropagation(): void; preventDefault?: () => void }): void {
  e.stopPropagation();
}

const FILL =
  'h-6 w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1 ' +
  'text-[0.82rem] leading-none hover:border-line hover:bg-surface3 focus:border-accent focus:bg-surface';

export function CellNumber({
  value,
  onCommit,
  decimals = 2,
  placeholder = '—',
  align = 'right',
  unit,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  decimals?: number;
  placeholder?: string;
  align?: 'left' | 'right';
  unit?: string;
}) {
  // Local text while typing: a controlled number input that commits on every
  // keystroke would fight "2." on the way to "2.5".
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value == null ? '' : trimTo(value, decimals));

  const commit = (): void => {
    const text = draft;
    setDraft(null);
    if (text == null) return;
    const next = text.trim() === '' ? null : Number(text);
    if (next != null && !Number.isFinite(next)) return;
    if (next !== value) onCommit(next);
  };

  return (
    <span className="relative flex items-center">
      <input
        type="number"
        inputMode="decimal"
        step="any"
        aria-valuetext={value == null ? placeholder : `${value}${unit ? ` ${unit}` : ''}`}
        className={cx(FILL, 'tabular-nums', align === 'right' ? 'text-right' : 'text-left', unit && 'pr-7')}
        value={shown}
        placeholder={placeholder}
        onClick={isolate}
        onPointerDown={isolate}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      {unit ? <span className="pointer-events-none absolute right-1 text-[0.65rem] text-ink3">{unit}</span> : null}
    </span>
  );
}

export function CellSelect<T extends string>({
  value,
  options,
  onCommit,
  tone,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onCommit: (next: T) => void;
  tone?: string;
  className?: string;
}) {
  return (
    <select
      className={cx(FILL, 'cursor-pointer appearance-none pr-4 font-600', tone, className)}
      value={value}
      onClick={isolate}
      onPointerDown={isolate}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') e.stopPropagation();
      }}
      onChange={(e) => onCommit(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Compact yes/no. A tick, not a switch: a switch is 36px wide and rows are 34px tall. */
export function CellCheck({
  checked,
  onCommit,
  label,
  icon = 'check',
  onClass = 'text-curing',
  offClass = 'text-ink3',
}: {
  checked: boolean;
  onCommit: (next: boolean) => void;
  label: string;
  icon?: 'check' | 'blast' | 'products';
  onClass?: string;
  offClass?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={cx(
        'mx-auto flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] border transition-colors',
        checked ? `border-curing/40 bg-curingbg ${onClass}` : 'border-line bg-surface2',
      )}
      onClick={(e) => {
        isolate(e);
        onCommit(!checked);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') e.stopPropagation();
      }}
    >
      {checked ? <Icon name={icon} size={12} className={onClass} /> : null}
      <span className="sr-only">{checked ? 'Yes' : 'No'}</span>
      {!checked ? <span className={cx('text-[0.7rem]', offClass)}>—</span> : null}
    </button>
  );
}

/** Plain text cell editor, for notes. */
export function CellText({
  value,
  onCommit,
  placeholder = '—',
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={cx(FILL, 'placeholder:text-ink3')}
      value={draft ?? value}
      placeholder={placeholder}
      onClick={isolate}
      onPointerDown={isolate}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const text = draft;
        setDraft(null);
        if (text != null && text !== value) onCommit(text);
      }}
    />
  );
}

/** Anything that is not a number renders as-is; used by read-only computed cells. */
export function CellStatic({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <span className={cx('block truncate', className)}>{children}</span>;
}

function trimTo(value: number, decimals: number): string {
  // 2.5 must not read as "2.50" in an input, and 0 must not read as empty.
  const fixed = value.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
