import { useEffect, useState } from 'react';
import { Shell } from '@/app/Shell';
import { Curing } from '@/screens/Curing';
import { Entry } from '@/screens/Entry';
import { Matrix } from '@/screens/Matrix';
import { People } from '@/screens/People';
import { Products } from '@/screens/Products';
import { Settings } from '@/screens/Settings';
import { MyobEntry } from '@/screens/MyobEntry';
import { Shotblast } from '@/screens/Shotblast';
import { SignIn } from '@/screens/SignIn';
import { Sources } from '@/screens/Sources';
import { navigate, useRoute } from '@/app/router';
import { useExportWatch } from '@/app/exportWatch';
import { reconcileSession, useSession } from '@/app/session';
import { can as roleAllows, ROLE_LABEL, type Capability } from '@/core/roles';
import { seedIfEmpty } from '@/data/db';
import { Icon } from '@/ui/Icon';
import { Button, Card } from '@/ui/primitives';
import { UnderConstruction } from '@/screens/UnderConstruction';

/**
 * Route table. Each entry is a screen in the build order; until a screen is
 * built it renders a placeholder rather than 404ing, so the shell can be driven
 * end to end on a phone from day one.
 */
function screenFor(path: string) {
  const root = path.split('/')[1] ?? '';
  switch (root) {
    case '':
      return <Matrix />;
    case 'jobs':
      return (
        <UnderConstruction
          title="Future jobs"
          icon="jobs"
          blurb="Open sales-order lines from the MYOB export."
          steps={[
            'Sortable, resizable table of every open line',
            'Filter by customer, product and promised date',
            'Placeholder dates (4/04/2040) held out of the near-term view',
          ]}
        />
      );
    case 'schedule':
      return (
        <UnderConstruction
          title="Schedule"
          icon="schedule"
          blurb="What needs making, and the latest day it can start."
        />
      );
    case 'entry':
      return <Entry />;
    case 'log':
      return (
        <UnderConstruction
          title="Production log"
          icon="log"
          blurb="Every batch and its stage history."
        />
      );
    case 'curing':
      return <Curing />;
    case 'shotblast':
      return <Shotblast />;
    case 'myob':
      return <MyobEntry />;
    case 'products':
      return <Products />;
    case 'sources':
      return <Sources />;
    case 'settings':
      return <Settings />;
    case 'people':
      return <People />;
    default:
      return null;
  }
}

/**
 * Screens a role may not open. The nav hides these for a viewer, but a bookmark or a
 * typed address gets this panel rather than the screen — and the buttons inside would
 * have refused anyway, because that check lives under them, not here.
 */
const GATED: Record<string, { capability: Capability; what: string }> = {
  settings: { capability: 'settings.manage', what: 'how the shop is set up' },
  sources: { capability: 'sources.import', what: 'the MYOB exports' },
  people: { capability: 'people.manage', what: 'who can sign in' },
};

export default function App() {
  const route = useRoute();
  const userId = useSession((s) => s.userId);
  const role = useSession((s) => s.role);
  // Nothing can be trusted before the session has been checked against the accounts
  // on this device: a stale claim is a stranger with a remembered name.
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Both halves have to be answered even when they fail. Seeding failing is the
    // sign-in screen's problem to show; the gate opening is not optional, or the app
    // stops at "Opening the shop…" with a rejected promise nobody is listening to.
    void seedIfEmpty().catch((error: unknown) => {
      console.error('[freo] first-run seeding failed', error);
    });
    void reconcileSession()
      .catch((error: unknown) => {
        console.error('[freo] the saved session could not be checked', error);
      })
      .finally(() => setChecked(true));
  }, []);

  // Unknown route: back to the matrix rather than a dead end on a phone.
  useEffect(() => {
    if (checked && userId !== null && screenFor(route.path) === null) navigate('/', { replace: true });
  }, [checked, route.path, userId]);

  // The MYOB exports arrive on their own while somebody signed-in has the app open.
  // It lives here rather than on the Sources screen because the point is that the
  // data turns up whether or not anyone is looking at the screen that talks about it.
  useExportWatch(checked && userId !== null);

  if (!checked) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas text-sm text-ink3">
        <span className="flex items-center gap-2">
          <Icon name="refresh" size={14} className="animate-spin" /> Opening the shop…
        </span>
      </div>
    );
  }

  if (userId === null) return <SignIn />;

  const root = route.path.split('/')[1] ?? '';
  const gate = GATED[root];
  const allowed = gate === undefined || roleAllows(role, gate.capability);
  const screen = screenFor(route.path);

  return (
    <Shell>
      {allowed ? (
        screen ?? <span className="text-ink3">Opening…</span>
      ) : (
        <GatedAway what={gate.what} role={role === null ? '' : ROLE_LABEL[role]} onBack={() => navigate('/')} />
      )}
    </Shell>
  );
}

function GatedAway({ what, role, onBack }: { what: string; role: string; onBack: () => void }): React.ReactElement {
  return (
    <Card title="Not this screen">
      <div className="space-y-3 text-sm text-ink3">
        <p>
          A {role.toLowerCase()} does not change {what}. Ask the owner if it needs changing — nothing here has
          been touched.
        </p>
        <Button icon="chevronLeft" onClick={onBack}>
          Back to the board
        </Button>
      </div>
    </Card>
  );
}
