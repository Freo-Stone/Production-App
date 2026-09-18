/**
 * Domain model.
 *
 * Everything here is persisted to IndexedDB and mirrored to the shared GitHub
 * state document, so every record carries `updatedAt` (last-write-wins merge key)
 * and, where deletion must survive a merge, a `deleted` tombstone.
 */

/* ── Products ──────────────────────────────────────────────────────────────── */

/** Manufacturing route. `'unset'` deliberately keeps a product out of planning
 *  until someone has chosen a route — nothing is assumed from the MYOB category. */
export type ProductRoute = 'unset' | 'manufacture' | 'shotblast';

export type ProductUnit = 'm2' | 'lm' | 'pieces' | (string & {});

export interface Product {
  /** MYOB item number, e.g. `S3`. Immutable identity — also the merge key. */
  code: string;
  description: string;
  /** Only enabled products appear in the matrix or in planning maths. */
  enabled: boolean;
  route: ProductRoute;
  /**
   * MYOB holds some items as `actual + 10000`. When true the app subtracts
   * 10000, which can legitimately go negative (M6: 9790.23 → -209.77 = short).
   */
  usesBaseline10000: boolean;
  /** Stock/order unit. Cannot be inferred from the MYOB exports. */
  unit: ProductUnit;
  /**
   * Yield of one tray, expressed in `unit`. Entry happens in trays on the floor;
   * qty = trays * trayYield is what goes to MYOB.
   */
  trayYield: number;
  /** Target stock level in `unit`. Drives TO GET TO TARGET. */
  target: number;
  /** Days of cure before the product is available (shotblast items are exempt by default). */
  cureDays: number;
  notes: string;
  /** Manual row order (drag-and-drop). Float; rebalanced when gaps get too tight. */
  rank: number;
  /** Present when the code only exists in the sales export (no stock row). */
  seenInJobs: boolean;
  updatedAt: number;
  deleted?: boolean;
}

/* ── Lines ─────────────────────────────────────────────────────────────────── */

export type LineKind = 'standard' | 'handmade' | 'shotblast';

export interface Line {
  id: string;
  name: string;
  kind: LineKind;
  active: boolean;
  rank: number;
  updatedAt: number;
  deleted?: boolean;
}

/* ── Batches (production records) ──────────────────────────────────────────── */

/**
 * Stage machine. Note that `awaiting_shotblast`/`blasting` run *parallel* to
 * curing — a piece may be shotblasted while it is still curing — so stage is
 * one field and cure-completion is derived from `cureDueAt`, never encoded as
 * a stage that blasting has to wait for.
 */
export type BatchStage =
  | 'green'
  | 'curing'
  | 'awaiting_shotblast'
  | 'blasting'
  | 'ready'
  | 'entered_myob'
  | 'written_off';

export interface Batch {
  id: string;
  /** Human-facing number, e.g. `2026-09-17-03`. */
  batchNo: string;
  code: string;
  lineId: string;
  /** What was keyed on the floor. */
  trays: number;
  /**
   * Quantity in the product's unit at time of making. Snapshot of trayYield is
   * implied by trays * yield; an explicit override is recorded so a later change
   * to product.trayYield can never rewrite history.
   */
  qty: number;
  qtyOverridden: boolean;
  routeSnapshot: Exclude<ProductRoute, 'unset'>;
  stage: BatchStage;
  madeAt: number;
  cureDaysSnapshot: number;
  cureDueAt: number;
  /** Shotblast products only. Partial blasting splits the batch, so <= qty. */
  blastedQty: number;
  blastedAt: number | null;
  /** Which weekly MYOB entry run this landed on (epoch ms of that weekday). */
  myobRunDate: number | null;
  enteredAt: number | null;
  enteredRef: string;
  operator: string;
  note: string;
  rank: number;
  /** Set when a partial move/split created this batch. */
  parentBatchId: string | null;
  updatedAt: number;
  deleted?: boolean;
}

/* ── Read-only mirrors of the MYOB exports ─────────────────────────────────── */

export interface StockRow {
  code: string;
  /** Location group from the export, e.g. `HQ`, `GW`. */
  location: string;
  /** Raw Units On Hand, exactly as exported (may include the phantom 10000). */
  qtyOnHandRaw: number;
  category: string;
}

/** One parsed export. The app always renders the newest capture and keeps its age. */
export interface StockSnapshot {
  id: string;
  capturedAt: number;
  /** Provenance: file name / repo path the bytes came from. */
  source: string;
  rows: StockRow[];
  /** Raw sheet dimensions and parse diagnostics, for the Sources panel. */
  diagnostics: ParseDiagnostics;
}

/** A future job line: one product on one sales order, on one promised date. */
export interface JobRow {
  /** Deterministic: `${itemCode}|${orderNo}` — the export has repeated combos. */
  id: string;
  itemCode: string;
  itemDescription: string;
  customer: string;
  orderNo: string;
  /** Order date, parsed from `d/mm/yyyy` text. */
  orderDate: number | null;
  promisedDate: number;
  /** Positive = demand, negative = credit/return. */
  qty: number;
  shipVia: string;
  salesperson: string;
  rank: number;
}

export interface JobsSnapshot {
  id: string;
  capturedAt: number;
  source: string;
  /** Report period header, e.g. 1/01/2026 To 17/09/2026. */
  periodFrom: number | null;
  periodTo: number | null;
  rows: JobRow[];
  diagnostics: ParseDiagnostics;
}

export interface ParseDiagnostics {
  sheetName: string;
  reportTitle: string;
  headerRow: number | null;
  rowsRead: number;
  rowsUsed: number;
  totalRowsSkipped: number;
  groupRowsSkipped: number;
  unparsed: Array<{ row: number; reason: string; raw: unknown[] }>;
}

/* ── Planning ──────────────────────────────────────────────────────────────── */

export interface PlanItem {
  id: string;
  code: string;
  qty: number;
  /** Latest date the make can start and still land in time. */
  latestStartDate: number | null;
  promisedFor: number | null;
  route: Exclude<ProductRoute, 'unset'>;
  status: 'planned' | 'started' | 'cancelled';
  linkedJobIds: string[];
  note: string;
  rank: number;
  updatedAt: number;
  deleted?: boolean;
}

/* ── Audit ledger ──────────────────────────────────────────────────────────── */

export type EventAction =
  | 'batch.create'
  | 'batch.move'
  | 'batch.split'
  | 'batch.blast'
  | 'batch.enterMyob'
  | 'batch.writeOff'
  | 'batch.undo'
  | 'plan.add'
  | 'plan.start'
  | 'plan.cancel'
  | 'rank.change'
  | 'product.update'
  | 'import.commit'
  | 'view.setDefault'
  | 'sync.conflict'
  | 'account.create'
  | 'account.update'
  | 'account.disable'
  | 'account.enable'
  | 'account.passcode'
  | 'account.delete'
  | 'auth.signin'
  | 'auth.signout'
  | 'device.label'
  | 'device.revoke'
  | 'export.import'
  | 'export.publish'
  | 'export.failed';

/** Who did it: the account's name, and its id so a rename does not rewrite history. */
export interface Actor {
  id: string;
  name: string;
}

/**
 * A passcode is stored as a digest, never as text. PBKDF2-SHA256 with a per-account
 * salt: the salt is what stops two people choosing the same passcode from producing
 * the same bytes, and the iterations are what make a stolen copy of the state
 * document expensive to guess at.
 */
export interface PasscodeDigest {
  /** base64, 16 random bytes. */
  salt: string;
  /** base64, 32 bytes. */
  hash: string;
  iterations: number;
}

/* ── Accounts and devices ──────────────────────────────────────────────────── */

/**
 * Three roles, deliberately. A shop floor does not want a permission matrix: it
 * wants the owner's word to be the only one that changes who can do what.
 *
 * - `owner` — everything, including adding, renaming, disabling and deleting people.
 * - `maker` — the work: production, curing, shotblast, and the products they make.
 * - `viewer` — reads. The board, the numbers, the jobs; changes nothing.
 *
 * `src/core/roles.ts` is the only place these are interpreted, so "what can a viewer
 * do" has one answer rather than one per screen.
 */
export type AccountRole = 'owner' | 'maker' | 'viewer';

export interface Account {
  /** Stable id. Renaming a person must not orphan the work they logged. */
  id: string;
  name: string;
  role: AccountRole;
  passcode: PasscodeDigest;
  /** A disabled account cannot sign in; its history stays. */
  disabled: boolean;
  /** Why it was disabled, for the owner's own reference. */
  note: string;
  createdAt: number;
  /** Account id that created this one, or null for the first owner. */
  createdBy: string | null;
  updatedAt: number;
  deleted?: boolean;
}

/**
 * One device that has been used to sign in. This exists so the owner can see that
 * "Sam's phone" is a thing that holds the shop's data, and can say it may not any
 * more. Revoking signs the device out at its next sync — a real sign-out on an
 * offline device is not a thing a client-only app can promise.
 */
export interface DeviceRecord {
  id: string;
  label: string;
  /** Last account to sign in here, or null if it never completed a sign-in. */
  userId: string | null;
  signedInAt: number | null;
  lastSeenAt: number;
  revoked: boolean;
  updatedAt: number;
  deleted?: boolean;
}


export interface EventLog {
  id: string;
  at: number;
  action: EventAction;
  batchId: string | null;
  code: string | null;
  fromStage: BatchStage | null;
  toStage: BatchStage | null;
  qty: number;
  trays: number;
  device: string;
  actor: string;
  /**
   * The account id behind `actor`. Optional because the ledger already has rows
   * written before accounts existed, and those must keep parsing.
   */
  actorId?: string;
  detail: string;
}

/* ── Views ─────────────────────────────────────────────────────────────────── */

export type ColumnAlign = 'left' | 'right' | 'center';
export type ColumnFormat = 'text' | 'number' | 'qty' | 'date' | 'status' | 'code';

export interface ColumnPref {
  key: string;
  visible: boolean;
  /** null = auto-size from content and viewport. */
  width: number | null;
  order: number;
  align?: ColumnAlign;
  format?: ColumnFormat;
  decimals?: number;
  wrap?: boolean;
}

export interface SortPref {
  key: string;
  dir: 'asc' | 'desc';
}

export interface FormatRule {
  id: string;
  /** Column key the rule paints. */
  column: string;
  when: 'above' | 'below' | 'between' | 'equals' | 'isNegative' | 'isBlank';
  value: number | null;
  value2: number | null;
  tone: 'short' | 'curing' | 'warn' | 'info' | 'none';
}

export type HorizonWeeks = 1 | 2 | 4 | 6 | 'all';

export interface ViewDef {
  screen: string;
  columns: ColumnPref[];
  sort: SortPref[];
  /** `'manual'` enables row drag-and-drop ordering. */
  sortMode: 'column' | 'manual';
  groupBy: string | null;
  density: 'compact' | 'normal' | 'roomy';
  stickyFirstColumn: boolean;
  showTotals: boolean;
  horizonWeeks: HorizonWeeks;
  filters: Record<string, unknown>;
  formatRules: FormatRule[];
  /** Column subset used on narrow screens so phones do not render 42 columns. */
  mobileColumns: string[] | null;
  updatedAt: number;
}

/* ── Settings ──────────────────────────────────────────────────────────────── */

/**
 * The automatic pull of the two MYOB exports. `path` is inside the **data**
 * repository — the mirror writes those files, the app only ever reads them, and
 * which of the two it is comes from the report title inside the workbook rather
 * than from the filename, so renaming the mirror's output cannot mix up stock
 * with jobs.
 */
export interface ExportAutoImport {
  /** Off means the shop drops the files in by hand, exactly as before. */
  autoImport: boolean;
  /** How often an open, online app asks the repository whether anything changed. */
  intervalMinutes: number;
  locationPath: string;
  futurePath: string;
  /** Watching a folder on this PC, and publishing whatever changes. */
  folder: ExportFolderWatch;
}

/**
 * The folder this computer watches, and publishes from.
 *
 * A **per-computer** choice. The handle the browser was given lives in this browser
 * only (`data/folderAccess.ts`), so a device that has never picked a folder is not
 * watching one, and no setting saved on another device can make it so. The two
 * names below are what the shop calls the files; MYOB saves whatever was typed in
 * its save box, so when these names are not in the folder the screen offers what it
 * does hold rather than failing quietly.
 */
export interface ExportFolderWatch {
  /** Off until somebody presses "Choose the folder" on this computer. */
  enabled: boolean;
  /** How often an open app looks at the folder. One minute is the floor. */
  intervalMinutes: number;
  /** The stock workbook's name in that folder. */
  locationFile: string;
  /** The jobs workbook's name in that folder. */
  futureFile: string;
  /** Older than this, it is not published as though it were current. */
  maxAgeHours: number;
}

export interface Settings {
  /** Single identity — every user has identical access. */
  deviceName: string;
  companyName: string;

  production: {
    /** Default cure time for products that do not override it. */
    defaultCureDays: number;
    cureTimeUnit: 'hours' | 'days';
    /**
     * When true (default) shotblasting makes a batch ready even if the cure is
     * not finished, matching "it can be shotblasted during curing".
     */
    blastingCompletesCure: boolean;
    /** Auto-advance eligible curing batches instead of waiting for confirmation. */
    autoAdvanceCuring: boolean;
    allowNegativeStock: boolean;
    requireOperator: boolean;
    batchNumberFormat: string;
  };

  myobEntry: {
    /** 0 = Sunday .. 6 = Saturday. The one weekday stock gets keyed into MYOB. */
    entryWeekday: number;
    /** Items becoming ready after this time roll to the following week's run. */
    cutoffHours: number;
    /** Column order/values for the paste-ready export. */
    exportColumns: Array<{ key: string; header: string }>;
    memoTemplate: string;
  };

  planning: {
    defaultHorizonWeeks: HorizonWeeks;
    /** Days of slack added when working out the latest start date. */
    bufferDays: number;
    /** Promised dates further out than this are bucketed as far-future. */
    farFutureMonths: number;
    /** Treat these Promised Date years as "no date yet" placeholders. */
    placeholderYears: number[];
    horizonBandDays: number;
    blastHandlingDays: number;
  };

  sources: {
    /** Locations that count as usable stock (export groups are discovered, not hard-coded). */
    stockLocations: string[];
    /** Ship Via values that are not real demand. */
    excludedShipVia: string[];
    /** Count cured/blasted-but-unentered stock as available. */
    countsReadyAsAvailable: boolean;
    /** Pulling the two MYOB exports out of the repository by themselves. */
    exports: ExportAutoImport;
  };

  sync: {
    githubOwner: string;
    githubRepo: string;
    githubBranch: string;
    autoPush: boolean;
    lastPulledAt: number | null;
    lastPushedAt: number | null;
  };

  appearance: {
    theme: 'dark' | 'light';
    /** Colours A/B for the matrix, editable per the plan. */
    colourShort: string;
    colourNeedsCuring: string;
  };
}
