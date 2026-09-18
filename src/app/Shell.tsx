import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { navigate, routeIsActive, useRoute } from '@/app/router';
import { useSession } from '@/app/session';
import { useTheme } from '@/app/theme';
import { NAV, MOBILE_TAB_PATHS, navByPath, NAV_GROUPS, type NavItem } from '@/app/nav';
import { useUi } from '@/app/uiState';
import { db } from '@/data/db';
import { Icon, type IconName } from '@/ui/Icon';
import { Button, Chip, cx, Field, IconButton, Modal, TextInput, Toaster } from '@/ui/primitives';
import type { BatchStage } from '@/core/types';

/* ── Small hooks ───────────────────────────────────────────────────────────── */

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** Stage counts for the nav badges. Curing counts green batches too. */
function useNavBadges(): Partial<Record<NonNullable<NavItem['badge']>, number>> {
  return (
    useLiveQuery(async () => {
      const open = await db.batches.filter((b) => !b.deleted).toArray();
      const count = (stages: BatchStage[]) =>
        open.reduce((n, b) => (stages.includes(b.stage) ? n + 1 : n), 0);
      return {
        curing: count(['green', 'curing']),
        shotblast: count(['awaiting_shotblast', 'blasting']),
        myob: count(['ready']),
      } satisfies Partial<Record<NonNullable<NavItem['badge']>, number>>;
    }, []) ?? {}
  );
}

function ageLabel(capturedAt: number | null | undefined): { text: string; tone: 'curing' | 'warn' | 'short' } {
  if (capturedAt == null) return { text: 'No import yet', tone: 'short' };
  const mins = Math.max(0, Math.round((Date.now() - capturedAt) / 60_000));
  if (mins < 60) return { text: `Data ${mins}m ago`, tone: 'curing' };
  const hours = Math.round(mins / 60);
  if (hours < 48) return { text: `Data ${hours}h ago`, tone: hours > 24 ? 'warn' : 'curing' };
  return { text: `Data ${Math.round(hours / 24)}d ago`, tone: 'warn' };
}

/* ── Pieces ────────────────────────────────────────────────────────────────── */

function Brand({ compact }: { compact: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-accent text-[0.78rem] font-800 text-accentink">
        FS
      </span>
      {!compact ? (
        <span className="min-w-0">
          <span className="block truncate text-[0.86rem] font-700 leading-tight">Freo Stone</span>
          <span className="block truncate text-[0.68rem] text-ink3 leading-tight">Production</span>
        </span>
      ) : null}
    </div>
  );
}

function NavLink({
  item,
  active,
  badge,
  collapsed,
  mobile,
  onPick,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  collapsed?: boolean;
  mobile?: boolean;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        navigate(item.path);
        onPick?.();
      }}
      aria-current={active ? 'page' : undefined}
      title={collapsed || mobile ? item.label : undefined}
      className={cx(
        'relative flex items-center gap-2.5 rounded-[var(--radius-md)] font-600 transition-colors',
        mobile
          ? 'h-full w-full flex-col justify-center gap-0.5 !px-1 text-[0.68rem]'
          : collapsed
            ? 'h-9 w-9 justify-center'
            : 'h-8 px-2 text-[0.85rem]',
        active ? 'bg-surface3 text-ink' : 'text-ink2 hover:bg-surface2 hover:text-ink',
      )}
    >
      <Icon name={item.icon} size={mobile ? 19 : 17} className={active ? 'text-accent' : undefined} />
      {mobile ? <span className="truncate">{item.short}</span> : collapsed ? null : <span className="truncate">{item.label}</span>}
      {badge ? (
        <span
          className={cx(
            'num rounded-full bg-accent px-1.5 text-[0.65rem] font-700 text-accentink',
            mobile ? 'absolute top-1 right-1/4' : collapsed ? 'absolute -top-0.5 -right-0.5' : 'ml-auto',
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SideRail({ path }: { path: string }) {
  const collapsed = useUi((s) => s.railCollapsed);
  const toggleRail = useUi((s) => s.toggleRail);
  const badges = useNavBadges();

  return (
    <nav
      className={cx(
        'hidden shrink-0 flex-col gap-1 border-r border-line bg-surface px-2 pt-2 pb-3 lg:flex',
        collapsed ? 'w-14 items-center' : 'w-52',
      )}
    >
      <div className={cx('flex h-9 items-center', collapsed ? 'justify-center' : 'px-2')}>
        <Brand compact={collapsed} />
      </div>

      {NAV_GROUPS.map((group) => {
        const items = NAV.filter((n) => n.group === group.key);
        return (
          <div key={group.key} className="mt-2 flex flex-col gap-0.5">
            {!collapsed ? (
              <span className="px-2 pb-0.5 text-[0.64rem] font-700 uppercase tracking-wider text-ink3">
                {group.label}
              </span>
            ) : (
              <span className="my-1 h-px w-6 bg-line" />
            )}
            {items.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                active={routeIsActive(item.path, path)}
                badge={item.badge ? badges[item.badge] : undefined}
                collapsed={collapsed}
              />
            ))}
          </div>
        );
      })}

      <div className={cx('mt-auto', collapsed ? '' : 'px-0.5')}>
        <IconButton
          icon={collapsed ? 'chevronRight' : 'chevronLeft'}
          label={collapsed ? 'Expand menu' : 'Collapse menu'}
          onClick={toggleRail}
        />
      </div>
    </nav>
  );
}

function MobileTabs({ path }: { path: string }) {
  const [more, setMore] = useState(false);
  const badges = useNavBadges();
  const tabs = useMemo(
    () => MOBILE_TAB_PATHS.map((p) => NAV.find((n) => n.path === p)).filter((n): n is NavItem => n != null),
    [],
  );
  const moreActive = !MOBILE_TAB_PATHS.includes(path);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-surface lg:hidden"
        style={{ height: 'calc(56px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {tabs.map((item) => (
          <NavLink
            key={item.path}
            item={item}
            mobile
            active={routeIsActive(item.path, path)}
            badge={item.badge ? badges[item.badge] : undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => setMore(true)}
          className={cx(
            'flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-[0.68rem] font-600',
            moreActive ? 'bg-surface3 text-ink' : 'text-ink2',
          )}
        >
          <Icon name="more" size={19} className={moreActive ? 'text-accent' : undefined} />
          <span>More</span>
        </button>
      </nav>

      <Modal open={more} onClose={() => setMore(false)} title="All screens" width="sm">
        <div className="flex flex-col gap-3">
          {NAV_GROUPS.map((group) => {
            const items = NAV.filter((n) => n.group === group.key);
            if (items.length === 0) return null;
            return (
              <div key={group.key}>
                <p className="pb-1 text-[0.65rem] font-700 uppercase tracking-wider text-ink3">{group.label}</p>
                <div className="flex flex-col gap-1">
                  {items.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => {
                        setMore(false);
                        navigate(item.path);
                      }}
                      className={cx(
                        'flex items-center gap-3 rounded-[var(--radius-md)] border px-2.5 py-2 text-left',
                        routeIsActive(item.path, path) ? 'border-accent/50 bg-surface3' : 'border-line bg-surface2',
                      )}
                    >
                      <Icon name={item.icon} size={18} className="text-accent" />
                      <span className="min-w-0">
                        <span className="block text-sm font-650">{item.label}</span>
                        <span className="block text-xs text-ink3">{item.blurb}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
}

function IdentityButton() {
  const name = useSession((s) => s.name);
  const setName = useSession((s) => s.setName);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  // First run: ask who is at the keyboard so table layouts land on the right person.
  const [nagged, setNagged] = useState(false);
  useEffect(() => {
    if (name === '' && !nagged) setOpen(true);
  }, [name, nagged]);

  const initial = name.trim().slice(0, 1).toUpperCase() || '?';

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(name);
          setOpen(true);
        }}
        title={name === '' ? 'Set your name' : `Signed in as ${name}`}
        className="btn btn-ghost !px-1.5"
      >
        <span className="grid size-6 place-items-center rounded-full border border-line bg-surface3 text-[0.7rem] font-700">
          {initial}
        </span>
        {name !== '' ? <span className="hidden max-w-24 truncate sm:inline">{name}</span> : null}
      </button>

      <Modal
        open={open}
        onClose={() => {
          setNagged(true);
          setOpen(false);
        }}
        title="Who is using this?"
        width="sm"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setName(draft);
              setNagged(true);
              setOpen(false);
            }}
          >
            Save
          </Button>
        }
      >
        <Field
          label="Your name"
          hint="No passwords — everyone has the same access. Your name only decides which saved table layout is yours, so your changes never overwrite anyone else’s."
        >
          <TextInput
            autoFocus
            value={draft}
            placeholder="e.g. Sam"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setName(draft);
                setNagged(true);
                setOpen(false);
              }
            }}
          />
        </Field>
      </Modal>
    </>
  );
}

function FirstRunBanner() {
  const route = useRoute();
  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted && p.enabled).count(), [], 0);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('freo.firstRunDismissed') === '1');
  if (dismissed || products > 0 || route.path === '/sources') return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-accent/40 bg-accent/10 px-3 py-2 text-sm">
      <Icon name="sources" size={16} className="text-accent" />
      <span className="min-w-0 flex-1">
        Nothing set up yet. Drop the two MYOB exports in to load stock and future jobs.
      </span>
      <Button size="sm" variant="primary" onClick={() => navigate('/sources')}>
        Import data
      </Button>
      <IconButton
        icon="close"
        label="Dismiss"
        onClick={() => {
          sessionStorage.setItem('freo.firstRunDismissed', '1');
          setDismissed(true);
        }}
      />
    </div>
  );
}

/* ── Shell ─────────────────────────────────────────────────────────────────── */

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const item = navByPath(route.path) ?? NAV[0]!;
  const rememberPath = useUi((s) => s.rememberPath);
  const online = useOnline();
  const themePref = useTheme((s) => s.preference);
  const cycleTheme = useTheme((s) => s.cycle);
  const stockAt = useLiveQuery(async () => (await db.stockSnapshots.orderBy('capturedAt').last())?.capturedAt, []);
  const age = ageLabel(stockAt);

  useEffect(() => {
    rememberPath(route.path);
  }, [route.path, rememberPath]);

  const themeIcon: IconName = themePref === 'light' ? 'sun' : themePref === 'system' ? 'settings' : 'moon';

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <FirstRunBanner />

      <div className="flex min-h-0 flex-1">
        <SideRail path={route.path} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-canvas/95 px-2 backdrop-blur sm:px-3">
            <span className="lg:hidden">
              <Brand compact />
            </span>
            <div className="hidden min-w-0 lg:block">
              <h1 className="truncate text-[0.95rem] font-700 leading-tight">{item.label}</h1>
              <p className="truncate text-[0.7rem] text-ink3">{item.blurb}</p>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <span className="hidden sm:block">
                <Chip tone={age.tone === 'short' ? 'short' : age.tone === 'warn' ? 'warn' : 'curing'}>
                  {age.text}
                </Chip>
              </span>
              <span title={online ? 'Online' : 'Offline — changes are kept locally and sync when you reconnect'}>
                <Chip tone={online ? 'neutral' : 'warn'} icon={online ? 'cloud' : 'cloudOff'}>
                  <span className="hidden sm:inline">{online ? 'Online' : 'Offline'}</span>
                </Chip>
              </span>
              <IconButton icon={themeIcon} label={`Theme: ${themePref} (click to change)`} onClick={cycleTheme} />
              <IdentityButton />
            </div>
          </header>

          <main className="min-w-0 flex-1 p-2 pb-20 sm:p-3 lg:pb-4">{children}</main>
        </div>
      </div>

      <MobileTabs path={route.path} />
      <Toaster />
    </div>
  );
}
