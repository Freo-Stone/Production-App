import { useEffect } from 'react';
import { Shell } from '@/app/Shell';
import { Products } from '@/screens/Products';
import { Settings } from '@/screens/Settings';
import { Sources } from '@/screens/Sources';
import { navigate, useRoute } from '@/app/router';
import { seedIfEmpty } from '@/data/db';
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
      return (
        <UnderConstruction
          title="Matrix"
          icon="matrix"
          blurb="Product against day, with short/needs-curing colouring."
          steps={[
            'Product × day grid with the product and stock columns frozen',
            'Horizon picker: 1, 2, 4 or 6 weeks, plus the overflow chip',
            'Tap a cell for every job for that product on that day',
          ]}
        />
      );
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
      return (
        <UnderConstruction
          title="Daily entry"
          icon="entry"
          blurb="Log trays made per line."
          steps={[
            'One row per line for the day, entered in trays',
            'Trays × yield = quantity in the product’s unit',
            'Batches land in curing, or awaiting shotblast on that route',
          ]}
        />
      );
    case 'log':
      return (
        <UnderConstruction
          title="Production log"
          icon="log"
          blurb="Every batch and its stage history."
        />
      );
    case 'curing':
      return (
        <UnderConstruction
          title="Curing"
          icon="curing"
          blurb="Batches on the cure clock."
          steps={['Due-by-day groups', 'Move to ready, or straight to the blaster']}
        />
      );
    case 'shotblast':
      return (
        <UnderConstruction
          title="Shotblast"
          icon="blast"
          blurb="Awaiting blast, on the blaster, blasted."
          steps={['Partial blasts split a batch', 'Blasting completes the product for MYOB entry']}
        />
      );
    case 'myob':
      return (
        <UnderConstruction
          title="MYOB entry"
          icon="myob"
          blurb="The weekly run of stock to key into MYOB."
          steps={[
            'Ready stock lands on the next entry weekday, cut-off respected',
            'Copy-ready CSV/TSV/XLSX of the run',
            'Mark entered: it leaves the queue and is added back until the next export',
          ]}
        />
      );
    case 'products':
      return <Products />;
    case 'sources':
      return <Sources />;
    case 'settings':
      return <Settings />;
    default:
      return null;
  }
}

export default function App() {
  const route = useRoute();
  const screen = screenFor(route.path);

  useEffect(() => {
    void seedIfEmpty();
  }, []);

  // Unknown route: back to the matrix rather than a dead end on a phone.
  useEffect(() => {
    if (screen === null) navigate('/', { replace: true });
  }, [screen]);

  return <Shell>{screen ?? <span className="text-ink3">Opening…</span>}</Shell>;
}
