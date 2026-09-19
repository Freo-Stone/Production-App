import { AnimatePresence, motion } from 'framer-motion';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Icon, type IconName } from '@/ui/Icon';

/** Join class names, dropping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Buttons ───────────────────────────────────────────────────────────────── */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'touch';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconEnd?: IconName;
  loading?: boolean;
  active?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  iconEnd,
  loading = false,
  active = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'py-1 text-[0.8rem]',
        size === 'touch' && 'btn-touch',
        active && 'border-accent/70 text-accent',
        loading && 'pointer-events-none opacity-60',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
}

export interface IconButtonProps extends ComponentProps<'button'> {
  icon: IconName;
  /** Required for screen readers and for long-press tooltips on touch. */
  label: string;
  size?: number;
  active?: boolean;
  tone?: 'default' | 'danger';
}

export function IconButton({
  icon,
  label,
  size = 16,
  active = false,
  tone = 'default',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={cx(
        'btn btn-ghost !px-1.5',
        active && 'text-accent',
        tone === 'danger' && 'text-short',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ── Chips, cards, tiles ───────────────────────────────────────────────────── */

export type Tone = 'neutral' | 'info' | 'curing' | 'warn' | 'short' | 'accent';

const CHIP: Record<Tone, string> = {
  neutral: 'bg-surface3 text-ink2 border-line',
  info: 'bg-infobg text-info border-info/35',
  curing: 'bg-curingbg text-curing border-curing/35',
  warn: 'bg-warnbg text-warn border-warn/35',
  short: 'bg-shortbg text-short border-short/35',
  accent: 'bg-accent/15 text-accent border-accent/40',
};

/**
 * Written out in full on purpose: Tailwind only generates utilities it can see
 * as literal strings, so `text-${tone}` would compile to nothing.
 */
const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  info: 'text-info',
  curing: 'text-curing',
  warn: 'text-warn',
  short: 'text-short',
  accent: 'text-accent',
};

export function Chip({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
  ...rest
}: ComponentProps<'span'> & { tone?: Tone; icon?: IconName }) {
  return (
    <span className={cx('chip', CHIP[tone], className)} title={title} {...rest}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx('card overflow-hidden', className)}>
      {title || actions ? (
        // Wrapped rather than in one unwinding row: a count chip beside the title
        // is `shrink-0`, so on a phone it used to win the fight and the heading
        // itself came out as "The…". The chips drop to a second line instead.
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface2 px-3 py-2">
          <div className="min-w-[10rem] flex-1">
            {title ? <h2 className="truncate text-title font-650">{title}</h2> : null}
            {subtitle ? <p className="truncate text-xs text-ink3">{subtitle}</p> : null}
          </div>
          {/* Not `shrink-0`: three buttons in a card header are wider than a phone,
              and the card clips what does not fit — so the button row was cut off
              mid-word ("Mark entered" came out as "Mark enter"). The row is allowed
              to shrink and wrap instead, and takes the second line when it must. */}
          {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx(padded && 'p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Tile({
  label,
  value,
  sub,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx(
        'card flex flex-col gap-0.5 px-3 py-2 text-left',
        onClick && 'cursor-pointer hover:border-linestrong',
      )}
    >
      <span className="text-eyebrow font-600 uppercase tracking-wide text-ink3">{label}</span>
      <span className={cx('num text-lg font-700 leading-tight', TONE_TEXT[tone])}>{value}</span>
      {sub ? <span className="truncate text-xs text-ink3">{sub}</span> : null}
    </Wrapper>
  );
}

export function EmptyState({
  icon = 'info',
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="rounded-full border border-line bg-surface2 p-3 text-ink3">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="text-title font-650">{title}</h3>
      {body ? <p className="max-w-md text-sm text-ink2">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cx('animate-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ── Fields ────────────────────────────────────────────────────────────────── */

/**
 * The description of the control inside a Field.
 *
 * Kept out of the `<label>` deliberately. Text inside a label is folded into the
 * control's accessible name, so a field labelled "Cut-off" would be announced as
 * "Cut-off, later than this rolls to the following week", and anything asking for
 * a field by name also matches every hint that mentions it — the token box on the
 * Settings screen matches "Repository" because its hint mentions the repository.
 * Descriptions belong beside the control, linked to it, not inside its name.
 */
export const FieldDescription = createContext<string | undefined>(undefined);

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  const descriptionId = useId();
  const description = error ?? hint;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label className="flex flex-col gap-1" htmlFor={htmlFor}>
        <span className="text-eyebrow font-650 uppercase tracking-wide text-ink3">{label}</span>
        <FieldDescription.Provider value={description ? descriptionId : undefined}>
          {children}
        </FieldDescription.Provider>
      </label>
      {description ? (
        <span id={descriptionId} className={cx('text-xs', error ? 'text-short' : 'text-ink3')}>
          {description}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: ComponentProps<'input'> & { ref?: Ref<HTMLInputElement> }) {
  const describedBy = useContext(FieldDescription);
  return (
    <input
      className={cx('input', className)}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      {...rest}
    />
  );
}

export function NumberInput({
  className,
  value,
  onValueChange,
  unit,
  ...rest
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & {
  value: number | null;
  onValueChange: (n: number | null) => void;
  unit?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  const describedBy = useContext(FieldDescription);
  return (
    <span className="relative flex items-center">
      <input
        type="number"
        className={cx('input w-full', unit && 'pr-12', className)}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        value={value ?? ''}
        onChange={(e) => {
          const next = e.target.value === '' ? null : Number(e.target.value);
          onValueChange(next === null || Number.isNaN(next) ? null : next);
        }}
        {...rest}
      />
      {unit ? (
        <span className="pointer-events-none absolute right-2 text-[0.7rem] text-ink3">{unit}</span>
      ) : null}
    </span>
  );
}

export function Select({
  className,
  options,
  ...rest
}: ComponentProps<'select'> & {
  options: Array<{ value: string; label: string }>;
  ref?: Ref<HTMLSelectElement>;
}) {
  const describedBy = useContext(FieldDescription);
  return (
    <select
      className={cx('input cursor-pointer', className)}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-2.5">
      <button
        id={id}
        type="button"
        role="switch"
        aria-describedby={hint ? hintId : undefined}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent/35' : 'border-line bg-surface3',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-current transition-transform',
            checked ? 'left-4 text-accent' : 'left-0.5 text-ink3',
          )}
        />
      </button>
      {/* The hint stays outside the label for the same reason Field does: inside
          a label it is folded into the switch name. */}
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm leading-tight">
          {label}
        </label>
        {hint ? (
          <span id={hintId} className="text-xs text-ink3">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={cx('flex rounded-[var(--radius-md)] border border-line bg-surface2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-[5px] font-600 whitespace-nowrap transition-colors',
            size === 'sm' ? 'px-2 py-0.5 text-[0.75rem]' : 'px-2.5 py-1 text-ui',
            value === o.value ? 'bg-surface3 text-ink' : 'text-ink3 hover:text-ink2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Popover ───────────────────────────────────────────────────────────────── */

/**
 * Anchored panel. Fixed positioning with the opening button's rectangle, because
 * toolbars sit inside overflow-hidden cards where an absolutely-positioned panel
 * would be clipped.
 */
export function Popover({
  label,
  icon = 'settings',
  children,
  width = 260,
  align = 'end',
  buttonVariant = 'default',
}: {
  label: ReactNode;
  icon?: IconName;
  children: (close: () => void) => ReactNode;
  width?: number;
  align?: 'start' | 'end';
  buttonVariant?: ButtonVariant;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  const open = (x: number, y: number) => setPos({ x, y });
  const close = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (anchor.current?.contains(e.target as Node)) return;
      const panel = document.getElementById('freo-popover');
      if (panel?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pos]);

  const rect = anchor.current?.getBoundingClientRect();

  return (
    <span ref={anchor} className="relative inline-flex">
      <Button
        variant={buttonVariant}
        icon={icon}
        iconEnd="chevronDown"
        aria-expanded={pos != null}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          open(r.left, r.bottom + 4);
        }}
      >
        {label}
      </Button>
      {pos && rect ? createPortal(
        <div
          id="freo-popover"
          role="dialog"
          className="fixed z-50 max-h-[70vh] overflow-auto rounded-[var(--radius-md)] border border-line bg-surface2 p-2 shadow-xl"
          style={{
            left: align === 'end' ? Math.max(8, Math.min(pos.x + rect.width - width, window.innerWidth - width - 8)) : pos.x,
            top: Math.min(pos.y, window.innerHeight - 80),
            width,
          }}
        >
          {children(close)}
        </div>,
        // Positioned against the viewport, so it lives at the document root: an
        // ancestor with a `backdrop-filter` would otherwise become its containing
        // block — see Modal below, where that pushed the name prompt off screen.
        document.body,
      ) : null}
    </span>
  );
}

/* ── Modal / sheet ─────────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'lg',
  bare = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  bare?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Held in a ref so the effect below can depend on `open` alone. Depending on
  // `onClose` meant that every render passed a new closure, and this effect re-ran
  // with it — flipping `body { overflow }` and calling focus() on every keystroke
  // of the name box. Toggling the document's overflow throws away layout for the
  // whole page, which at full-screen sizes is exactly "a delay between every
  // letter", and focus() takes the caret out of the field being typed in.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    // Background scroll would fight the sheet on phones.
    // The document does not scroll any more — `main` does (see Shell) — so locking
    // `body` would be a no-op and the table behind the scrim would slide under a
    // finger. Lock whatever actually moves, and give it back untouched.
    const region = document.querySelector('main') as HTMLElement | null;
    const prev = document.body.style.overflow;
    const prevRegion = region?.style.overflow;
    document.body.style.overflow = 'hidden';
    if (region) region.style.overflow = 'hidden';
    // Only take focus when nothing inside already has it, so `autoFocus` on the
    // first field inside the dialog survives.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      if (region) region.style.overflow = prevRegion ?? '';
    };
  }, [open]);

  const widths = { sm: '420px', md: '560px', lg: '820px', xl: '1100px', full: '96vw' };

  // A dialog is positioned against the viewport, so it is rendered at the document
  // root instead of where it was invoked. Not tidiness: `backdrop-filter`, `filter`
  // or `transform` on any ancestor becomes the containing block for
  // `position: fixed`, and the app's header carries a blur. Rendered in place, the
  // first-run name prompt was centred inside that 47px strip — its title above the
  // top of the screen, its dim only covering the header, and every keystroke
  // repainting inside a blurred region.
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <div
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className={cx(
              'relative flex max-h-[92vh] w-full flex-col overflow-hidden border border-line bg-surface shadow-2xl outline-none',
              'rounded-t-[var(--radius-lg)] sm:rounded-[var(--radius-lg)]',
              'sm:max-w-[min(96vw,var(--modal-w))]',
            )}
            style={{ ['--modal-w' as string]: widths[width] }}
            initial={{ y: 24, opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            // In on a spring, out on a clock. Left to inherit the spring the panel
            // stays in the tree for the better part of a second after being
            // dismissed, and its full-screen scrim is still the topmost element
            // under the finger for that whole time — measured ~700ms of swallowed
            // taps after Escape on the name box. A dialog that has gone should stop
            // being in the way at once.
            exit={{ y: 16, opacity: 0, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface2 px-3 py-2">
              <div className="min-w-[10rem] flex-1">
                {/* Not truncated: a dialog title is the question being asked, and
                    "How much of 2026-09-18-01 came…" on a phone stops being a
                    question. Two lines of heading cost nothing; a clipped one does. */}
                <h2 className="text-title font-650">{title}</h2>
                {subtitle ? <p className="text-xs text-ink3">{subtitle}</p> : null}
              </div>
              <IconButton icon="close" label="Close" onClick={onClose} />
            </header>
            <div className={cx('min-h-0 flex-1 overflow-auto', bare ? '' : 'p-3')}>{children}</div>
            {footer ? (
              // The safe area is the phone's home strip. The tab bar reserves it;
              // a sheet that ends at the viewport edge puts its buttons under it.
              <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface2 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/* ── Toasts ────────────────────────────────────────────────────────────────── */

export interface ToastItem {
  id: string;
  tone: Tone;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({ items: [...s.items, { ...t, id }] }));
    // Auto-dismiss, except for errors which stay until acknowledged.
    if (t.tone !== 'short') setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), 5000);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export function toast(tone: Tone, title: string, body?: string, action?: ToastItem['action']): void {
  useToasts.getState().push({ tone, title, body, action });
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  // Toasts are the app's "something happened" channel, and a channel nobody
  // announces is a channel a screen-reader user does not have. A live region
  // rather than role="status" on purpose: screens already use that role for their
  // own inline messages, and two status regions on one page mean an assertion —
  // or a person — cannot tell which one is speaking.
  return (
    <div
      data-toaster
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-16 z-[60] flex flex-col items-center gap-1.5 px-2 sm:bottom-4 sm:right-4 sm:left-auto sm:items-end"
    >
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className={cx(
              // Click-through on purpose, apart from its own two controls below.
              // The table on Data sources now reaches the bottom of the window, and
              // a toast that swallowed a pointer there would be sitting on the
              // reason the screen is open — a resize handle that refuses to drag
              // reads as a broken table, not as a message in the way.
              'flex w-full max-w-md items-start gap-2 rounded-[var(--radius-md)] border bg-surface2 px-3 py-2 shadow-lg',
              t.tone === 'short' ? 'border-short/50' : 'border-line',
            )}
          >
            <span className={cx('mt-0.5', TONE_TEXT[t.tone === 'neutral' ? 'info' : t.tone])}>
              <Icon name={t.tone === 'short' ? 'alert' : 'info'} size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-600">{t.title}</p>
              {t.body ? <p className="text-xs text-ink2">{t.body}</p> : null}
            </div>
            {t.action ? (
              <Button size="sm" variant="ghost" className="pointer-events-auto" onClick={() => t.action?.run()}>
                {t.action.label}
              </Button>
            ) : null}
            <IconButton
              icon="close"
              label="Dismiss"
              size={14}
              className="pointer-events-auto"
              onClick={() => dismiss(t.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * A card that keeps its content out of the way until it is asked for.
 *
 * Screens like Data sources have a table that is the reason for the visit and a
 * handful of facts and settings that are not. Stacking everything at full height
 * pushed the table below the screen, so the important thing needed a scroll to
 * arrive and another one to move through. A closed disclosure costs one line.
 *
 * The content is not rendered while closed. A table or a file picker sitting in a
 * closed panel would still mount, still fetch, and — in the file input's case —
 * still be findable by a test that never opened the panel, which is how a hidden
 * control becomes a lie about what the screen offers.
 */
export function Disclosure({
  title,
  detail,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
  /** Pass to own the open state from the parent; omit to let it keep its own. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const panelId = useId();
  const openIt = (): void => {
    const next = !isOpen;
    if (open === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <section className={cx('card overflow-hidden', className)}>
      <button
        type="button"
        aria-expanded={isOpen}
        // Only while the panel is actually there: a collapsed disclosure points at
        // an element that is not in the screen, and a broken aria-controls is worse
        // than a missing one.
        {...(isOpen ? { 'aria-controls': panelId } : {})}
        onClick={openIt}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface2"
      >
        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={14} className="shrink-0 text-ink3" />
        <span className="min-w-0 truncate text-title font-650">{title}</span>
        {detail ? <span className="ml-auto min-w-0 truncate pl-2 text-xs text-ink3">{detail}</span> : null}
      </button>
      {isOpen ? (
        <div id={panelId} className="border-t border-line p-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}
