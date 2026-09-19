import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brand } from '@/app/Brand';
import { navigate, routeIsActive, useRoute } from '@/app/router';
import { signOutLocally, useCan, useSession } from '@/app/session';
import { useTheme } from '@/app/theme';
import { NAV, MOBILE_TAB_PATHS, navByPath, NAV_GROUPS, navVisible, type NavItem } from '@/app/nav';
import { useUi } from '@/app/uiState';
import { accountFailureText, setPasscode, signOut } from '@/data/accounts';
import { isCurrentProduct } from '@/core/currentRange';
import { passcodeAdvice, passcodeAccepted } from '@/core/passcode';
import { ROLE_LABEL } from '@/core/roles';
import { db } from '@/data/db';
import { Icon, type IconName } from '@/ui/Icon';
import { Button, Chip, cx, Field, IconButton, Modal, TextInput, toast } from '@/ui/primitives';
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
      // The collapsed rail shows three letters and says the whole name. With no
      // picture left to draw, a button whose only visible text is "MAT" still has to
      // be read out as the screen it goes to.
      aria-label={collapsed ? item.label : undefined}
      title={collapsed || mobile ? item.label : undefined}
      className={cx(
        'relative flex items-center rounded-[var(--radius-md)] font-600 transition-colors',
        mobile
          ? 'h-full w-full justify-center px-1 text-[0.72rem]'
          : collapsed
            ? 'h-9 w-9 justify-center text-[0.66rem] tracking-wide'
            : 'h-8 px-2 text-[0.85rem]',
        active ? 'bg-surface3 text-ink' : 'text-ink2 hover:bg-surface2 hover:text-ink',
      )}
    >
      {
        mobile ? (
          <span className="truncate">{item.short}</span>
        ) : collapsed ? (
          // Three letters of the short name. The tooltip and the accessible name
          // both carry the full one.
          <span className="text-ink2">{item.short.slice(0, 3).toUpperCase()}</span>
        ) : (
          <span className="truncate">{item.label}</span>
        )
      }
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
  // A viewer has no reason to be offered Settings or People, so they are not in the
  // list at all. What they may *do* is settled underneath the buttons.
  const navRole = useSession((s) => s.role);

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
        const items = NAV.filter((n) => n.group === group.key && navVisible(n, navRole));
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
  const navRole = useSession((s) => s.role);
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
            'flex h-full w-full items-center justify-center px-1 text-[0.72rem] font-600',
            moreActive ? 'bg-surface3 text-ink' : 'text-ink2',
          )}
        >
          More
        </button>
      </nav>

      <Modal open={more} onClose={() => setMore(false)} title="All screens" width="sm">
        <div className="flex flex-col gap-3">
          {NAV_GROUPS.map((group) => {
            const items = NAV.filter((n) => n.group === group.key && navVisible(n, navRole));
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
                        'block rounded-[var(--radius-md)] border px-3 py-2.5 text-left',
                        routeIsActive(item.path, path) ? 'border-accent/50 bg-surface3' : 'border-line bg-surface2',
                      )}
                    >
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

/**
 * Who is signed in, on this device, right now.
 *
 * This used to be a box you typed a name into. It is now the account the passcode
 * checked out, and the only way to change it is to sign in as somebody else — which
 * is the point of having accounts at all.
 */
function AccountMenu() {
  const name = useSession((s) => s.name);
  const role = useSession((s) => s.role);
  const userId = useSession((s) => s.userId);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const canPeople = useCan('people.manage');

  const initial = name.trim().slice(0, 1).toUpperCase() || '?';

  async function savePasscode(): Promise<void> {
    if (userId === null) return;
    setBusy(true);
    try {
      const result = await setPasscode(userId, code);
      if (!result.ok) {
        setNotice(accountFailureText(result.reason));
        return;
      }
      setNotice('');
      setCode('');
      setConfirm('');
      setOpen(false);
      toast('info', 'Passcode changed');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  const advice = passcodeAdvice(code);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNotice('');
          setOpen(true);
        }}
        title={`Signed in as ${name}`}
        // The visible label is just an initial and a first name, which is not enough
        // for a screen reader or a test to know what the button is for.
        aria-label={`Account: ${name}`}
        className="btn btn-ghost !px-1.5"
      >
        <span className="grid size-6 place-items-center rounded-full border border-line bg-surface3 text-[0.7rem] font-700">
          {initial}
        </span>
        {name !== '' ? <span className="hidden max-w-24 truncate sm:inline">{name}</span> : null}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Your account"
        subtitle={`${name} — ${role === null ? 'no role' : ROLE_LABEL[role]}`}
        width="sm"
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {canPeople ? (
              <Button
                icon="user"
                onClick={() => {
                  setOpen(false);
                  navigate('/people');
                }}
              >
                People and devices
              </Button>
            ) : null}
            <Button
              icon="cloudOff"
              onClick={() => {
                // Both halves: the ledger entry and the principal (data layer), then
                // the remembered session, so the app falls back to the sign-in screen.
                void signOut().then(() => {
                  signOutLocally();
                  setOpen(false);
                });
              }}
            >
              Sign out
            </Button>
            <Button
              variant="primary"
              disabled={busy || code !== confirm || !passcodeAccepted(code)}
              onClick={() => void savePasscode()}
            >
              Change passcode
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-ink3">
            Your name and what you are allowed to do are set by the owner. This device stays signed in
            until you sign out or the owner takes it off the list.
          </p>
          <Field
            label="New passcode"
            hint={advice ?? 'At least four characters. Something you can type with wet gloves on.'}
          >
            <TextInput
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="••••••"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Type it again">
            <TextInput
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••"
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code === confirm && passcodeAccepted(code)) void savePasscode();
              }}
            />
          </Field>
          {notice !== '' ? <p className="text-xs text-short">{notice}</p> : null}
        </div>
      </Modal>
    </>
  );
}

function FirstRunBanner() {
  const route = useRoute();
  // The same predicate the boards use: the banner is asking "has anyone decided what
  // we make yet?", which is one question with one answer, not two that can drift.
  const products = useLiveQuery(() => db.products.filter(isCurrentProduct).count(), [], 0);
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
    <div className="flex h-dvh flex-col bg-canvas text-ink">
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
              <AccountMenu />
            </div>
          </header>

          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2 pb-20 sm:p-3 lg:pb-4">{children}</main>
        </div>
      </div>

      <MobileTabs path={route.path} />
    </div>
  );
}
