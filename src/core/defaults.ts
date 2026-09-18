import type { Line, Settings, ViewDef } from './types';

/**
 * Everything here is a *starting point* that the shop can change in Settings.
 * Nothing is inferred from the MYOB `Custom List #3` category — routes and the
 * baseline flag are explicitly chosen per product, because the category does not
 * encode them reliably.
 */
export const DEFAULT_SETTINGS: Settings = {
  deviceName: 'This device',
  companyName: 'Freo Stone',

  production: {
    // Placeholder until the real cure time is confirmed; per-product override wins.
    defaultCureDays: 2,
    cureTimeUnit: 'days',
    // "make - shotblast - ready. it can be shotblast during curing"
    blastingCompletesCure: true,
    autoAdvanceCuring: false,
    allowNegativeStock: true,
    requireOperator: false,
    batchNumberFormat: 'yyyy-mm-dd-nn',
  },

  myobEntry: {
    // One weekday each week, chosen in Settings. Friday is a safe default for a
    // week's worth of cured/blasted material.
    entryWeekday: 5,
    cutoffHours: 12,
    exportColumns: [
      { key: 'code', header: 'Item No.' },
      { key: 'description', header: 'Description' },
      { key: 'qty', header: 'Quantity' },
      { key: 'unit', header: 'Unit' },
      { key: 'memo', header: 'Memo' },
    ],
    memoTemplate: 'Cured/blasted production {runDate}',
  },

  planning: {
    defaultHorizonWeeks: 4,
    bufferDays: 0,
    farFutureMonths: 12,
    // A large share of the open job lines carry this placeholder promised date.
    placeholderYears: [2040],
    horizonBandDays: 14,
    blastHandlingDays: 1,
  },

  sources: {
    // The sheet's `HQ STOCK` column counts HQ only; widen this in Settings.
    stockLocations: ['HQ'],
    // Freight/pallet/discount codes appear as sale lines with real quantities.
    excludedShipVia: [],
    countsReadyAsAvailable: true,
    exports: {
      // The mirror in `docs/power-automate.md` writes these two paths. The app
      // reads them and stops; it never writes to `exports/`.
      autoImport: true,
      intervalMinutes: 15,
      locationPath: 'exports/location.xlsx',
      futurePath: 'exports/future.xlsx',
    },
  },

  sync: {
    // Where the shop's *data* lives — not where the app is served from. Those are
    // two repositories on purpose: the built app is published on GitHub Pages from
    // the public `Freo-Stone/Production-App`, because Pages on a private
    // organisation repository is not available, while this one stays private and
    // holds `state/state.json` and the mirrored MYOB exports. A device needs only
    // a token to join it, and the app refuses to write a repository that reports
    // itself public (`testConnection` in data/auth.ts).
    githubOwner: 'Freo-Stone',
    githubRepo: 'Production-App-Data',
    githubBranch: 'main',
    autoPush: true,
    lastPulledAt: null,
    lastPushedAt: null,
  },

  appearance: {
    theme: 'dark',
    colourShort: '',
    colourNeedsCuring: '',
  },
};

export const DEFAULT_LINES: Array<Omit<Line, 'updatedAt'>> = [
  { id: 'line-1', name: 'Line 1', kind: 'standard', active: true, rank: 1000, deleted: false },
  { id: 'line-2', name: 'Line 2', kind: 'standard', active: true, rank: 2000, deleted: false },
  { id: 'line-3', name: 'Line 3', kind: 'standard', active: true, rank: 3000, deleted: false },
  { id: 'line-handmade', name: 'Handmade', kind: 'handmade', active: true, rank: 4000, deleted: false },
  { id: 'line-shotblast', name: 'Shotblast', kind: 'shotblast', active: true, rank: 5000, deleted: false },
];

/**
 * Targets recovered from the current spreadsheet: `HQ STOCK INCL CURING &
 * BLASTED + TO GET TO TARGET` lands on a round number for every one of these
 * rows, which is what identifies them as deliberate stock targets. Seeded so the
 * first run reproduces the sheet instead of starting empty.
 */
export const SEED_TARGETS: Record<string, number> = {
  S3: 4752,
  S4: 1500,
  SL4: 1900,
  I3: 4158,
  IL4: 3864,
  G3: 3564,
  GL4: 2900,
  C3: 1512,
  C6: 100,
  A6: 300,
  AL3: 1650,
  AL6: 300,
  M3: 1000,
  M6: 200,
  ML6: 100,
};

/** Rows visible in the sheet with no shortfall figure, i.e. target not set. */
export const SEED_TARGETS_UNSET: string[] = ['S6', 'I4', 'I6', 'G4', 'G6', 'A3', 'ML3'];

/** Baseline pre-tick suggestion. A *suggestion only*: `>= 10000` misclassifies a
 *  short item such as M6 (9790.23 → -209.77), so it can never be the rule. */
export const BASELINE_SUGGEST_MIN = 10_000;

export const SCREENS = {
  matrix: 'matrix',
  jobs: 'jobs',
  products: 'products',
  productionLog: 'productionLog',
  curing: 'curing',
  shotblast: 'shotblast',
  myobList: 'myobList',
  schedule: 'schedule',
} as const;

export type ScreenKey = (typeof SCREENS)[keyof typeof SCREENS];

export function defaultView(screen: string, columns: string[]): ViewDef {
  return {
    screen,
    columns: columns.map((key, i) => ({
      key,
      visible: true,
      width: null,
      order: i,
    })),
    sort: [],
    sortMode: 'column',
    groupBy: null,
    density: 'normal',
    stickyFirstColumn: true,
    showTotals: true,
    horizonWeeks: 4,
    filters: {},
    formatRules: [],
    mobileColumns: null,
    updatedAt: 0,
  };
}
