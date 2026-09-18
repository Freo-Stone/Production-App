import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Device-local UI state: never synced, never shared between people. */
interface UiState {
  railCollapsed: boolean;
  toggleRail: () => void;
  /** Last screen per group, so the rail can remember where you were. */
  lastPath: string;
  rememberPath: (path: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      railCollapsed: false,
      toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
      lastPath: '/',
      rememberPath: (path) => set({ lastPath: path }),
    }),
    { name: 'freo.ui' },
  ),
);
