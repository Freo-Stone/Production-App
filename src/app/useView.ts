import { useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ownerKey, useSession, viewKey } from '@/app/session';
import type { ViewDef } from '@/core/types';
import { db } from '@/data/db';
import { logEvent } from '@/data/events';
import { reconcileColumns } from '@/ui/DataTable/viewPrefs';

/**
 * One shared default, then a private copy per person.
 *
 * The owner sets the default view once; anyone happy with it stores nothing at
 * all. The first time they resize a column or change sorting it is copied to
 * their own record, so their change can never overwrite a colleague's layout —
 * the requirement that everyone has the same access but keeps their own view.
 */
export interface UseView {
  /** The view to render: personal override, else shared default, else built-in. */
  view: ViewDef;
  /** True when the rendered view is this person's own saved copy. */
  isPersonal: boolean;
  /** True when a shared default exists for this screen. */
  hasShared: boolean;
  /** Save a change as this person's own view (never touches the shared default). */
  patch: (patch: Partial<ViewDef>) => void;
  /** Drop the personal copy and follow the shared default again. */
  resetToShared: () => void;
  /** Publish this person's layout as the default everyone else sees. */
  publishAsDefault: () => void;
  loading: boolean;
}

export function useView(screen: string, fallback: ViewDef): UseView {
  const name = useSession((s) => s.name);
  const owner = ownerKey(name);
  const personalKey = viewKey(screen, owner);
  const sharedKey = viewKey(screen, 'shared');

  // The declared columns of the screen are stable, so reconciliation is safe here.
  const declared = useMemo(() => fallback.columns.map((c) => c.key), [fallback]);

  const personal = useLiveQuery(() => db.views.get(personalKey), [personalKey]);
  const shared = useLiveQuery(() => db.views.get(sharedKey), [sharedKey]);

  const loading = personal === undefined || shared === undefined;
  const isPersonal = personal != null;
  const base = personal ?? shared ?? fallback;
  const view = useMemo(() => reconcileColumns({ ...base, screen }, declared), [base, screen, declared]);

  const patch = useCallback(
    (partial: Partial<ViewDef>) => {
      const next: ViewDef = { ...view, ...partial, screen, updatedAt: Date.now() };
      // First change materialises the personal copy; reading never writes.
      void db.views.put({ ...next, key: personalKey, screen, owner, isDefault: false });
    },
    [view, screen, personalKey, owner],
  );

  const resetToShared = useCallback(() => {
    void db.views.delete(personalKey);
  }, [personalKey]);

  const publishAsDefault = useCallback(() => {
    void db.views.put({ ...view, key: sharedKey, screen, owner: 'shared', isDefault: true, updatedAt: Date.now() });
    void logEvent('view.setDefault', { detail: `${screen} default view published by ${owner}` });
  }, [view, sharedKey, screen, owner]);

  return { view, isPersonal, hasShared: shared != null, patch, resetToShared, publishAsDefault, loading };
}
