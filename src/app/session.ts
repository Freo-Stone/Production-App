import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { deviceStorageKey } from '@/core/ids';

/**
 * Identity, not authentication.
 *
 * Everyone has identical access, so there is no role to store. The name still
 * matters because table layouts are personal: a shared default view exists, and
 * each person's own changes are stored against their name so they cannot
 * overwrite anyone else's.
 */
interface SessionState {
  name: string;
  deviceId: string;
  setName: (name: string) => void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      name: '',
      deviceId: deviceStorageKey(),
      setName: (name) => set({ name: name.trim() }),
    }),
    { name: 'freo.session' },
  ),
);

/**
 * View ownership key. Unnamed sessions read the shared default rather than
 * silently creating a throwaway view under a random device id.
 */
export function ownerKey(name = useSession.getState().name): 'shared' | string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug === '' ? 'shared' : slug;
}

export function viewKey(screen: string, owner: string): string {
  return `${screen}|${owner}`;
}
