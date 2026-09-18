import { useEffect, useRef } from 'react';
import { Icon } from '@/ui/Icon';

export interface ColumnMenuAnchor {
  key: string;
  header: string;
  /** Viewport coordinates of the button that opened it. */
  x: number;
  y: number;
  canHide: boolean;
  isPinned: boolean;
  widthIsCustom: boolean;
}

/**
 * Header right-click menu.
 *
 * Rendered fixed rather than inside the header cell because header cells clip
 * their overflow (that is what keeps long titles from stretching the grid).
 */
export function ColumnMenu({
  anchor,
  onClose,
  onSort,
  onHide,
  onTogglePin,
  onResetWidth,
  onAllToThisWidth,
}: {
  anchor: ColumnMenuAnchor;
  onClose: () => void;
  onSort: (dir: 'asc' | 'desc') => void;
  onHide: () => void;
  onTogglePin: () => void;
  onResetWidth: () => void;
  onAllToThisWidth: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    box.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items: Array<{ label: string; run: () => void; icon?: 'check' | 'close' | 'pin' | 'refresh' | 'columns' }> = [
    { label: 'Sort A → Z', run: () => onSort('asc'), icon: 'check' },
    { label: 'Sort Z → A', run: () => onSort('desc'), icon: 'check' },
    { label: 'Pin to left', run: onTogglePin, icon: 'pin' },
    { label: 'Reset width', run: onResetWidth, icon: 'refresh' },
    { label: 'Fit all to this width', run: onAllToThisWidth, icon: 'columns' },
    { label: 'Hide column', run: onHide, icon: 'close' },
  ];

  return (
    <>
      <div
        ref={box}
        role="menu"
        tabIndex={-1}
        className="fixed z-50 min-w-48 overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface2 py-1 shadow-xl outline-none"
        style={{
          // Flip left near the right edge so the menu never runs off a phone.
          left: Math.min(anchor.x, window.innerWidth - 210),
          top: Math.min(anchor.y, window.innerHeight - 240),
        }}
      >
        <p className="truncate border-b border-line px-2.5 py-1 text-[0.72rem] font-700 text-ink3">
          {anchor.header}
        </p>
        {items
          .filter((i) => i.label !== 'Hide column' || anchor.canHide)
          .map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                item.run();
                onClose();
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.84rem] hover:bg-surface3"
            >
              <span className="w-4 text-ink3">{item.icon ? <Icon name={item.icon} size={13} /> : null}</span>
              {item.label}
            </button>
          ))}
      </div>
    </>
  );
}
