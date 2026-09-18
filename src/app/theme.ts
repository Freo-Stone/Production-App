import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePreference = 'dark' | 'light' | 'system';

/** Dark is the default: the yard screen is read in daylight and at night. */
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

interface ThemeState {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  cycle: () => void;
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function isDarkFor(preference: ThemePreference): boolean {
  return preference === 'dark' || (preference === 'system' && prefersDark());
}

/**
 * Theming is one attribute on <html>. Every colour in theme.css is a custom
 * property, so flipping `data-theme` repaints the whole app without re-render.
 */
export function applyTheme(preference: ThemePreference): void {
  const dark = isDarkFor(preference);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0d1117' : '#f4f6f8');
}

const ORDER: ThemePreference[] = ['dark', 'light', 'system'];

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      preference: DEFAULT_PREFERENCE,
      setPreference: (preference) => {
        set({ preference });
        applyTheme(preference);
      },
      cycle: () => {
        const next = ORDER[(ORDER.indexOf(get().preference) + 1) % ORDER.length] ?? 'dark';
        get().setPreference(next);
      },
    }),
    {
      name: 'freo.theme',
      // Re-apply after the stored preference is read back in.
      onRehydrateStorage: () => (state) => applyTheme(state?.preference ?? DEFAULT_PREFERENCE),
    },
  ),
);

/** Call once at startup. Keeps 'system' honest when the OS flips at sunset. */
export function watchSystemTheme(): () => void {
  applyTheme(useTheme.getState().preference);
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const onChange = () => {
    if (useTheme.getState().preference === 'system') applyTheme('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
