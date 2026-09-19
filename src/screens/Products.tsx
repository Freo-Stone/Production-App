import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRoute } from '@/app/router';
import { useCan } from '@/app/session';
import { useLiveQuery } from 'dexie-react-hooks';
import { useView } from '@/app/useView';
import { demandByProduct, productPosition } from '@/core/calc';
import { currentProducts, isCurrentProduct } from '@/core/currentRange';
import { defaultView, SCREENS } from '@/core/defaults';
import { formatNumber, unitLabel } from '@/core/format';
import type { Product, ProductRoute } from '@/core/types';
import { db, getSettings, latestJobsSnapshot, latestStockSnapshot } from '@/data/db';
import {
  applyCsvUpdates,
  bulkPatchProducts,
  CSV_HEADER,
  moveProductInList,
  parseProductsCsv,
  patchProduct,
  productsToCsv,
  ROUTE_LABELS,
  UNIT_OPTIONS,
  type ProductPatch,
} from '@/data/productRepo';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { ViewToolbar } from '@/ui/DataTable/ViewToolbar';
import { CellCheck, CellNumber, CellSelect, CellStatic, CellText } from '@/ui/cellEditors';
import { Icon } from '@/ui/Icon';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  NumberInput,
  Select,
  TextInput,
  toast,
} from '@/ui/primitives';
import { ProductDrawer } from '@/screens/ProductDrawer';

/**
 * Product settings.
 *
 * The stock export carries a couple of thousand codes, most of them freight,
 * pallets and things last made years ago. Which of them are the current range —
 * how each is made, what it is counted in, what a tray holds and what to aim at
 * — is not in MYOB anywhere. This screen is where that gets decided, once.
 */
interface Row extends Product {
  stockReal: number;
  inclCuringBlasted: number;
  toGetToTarget: number;
  demand: number;
  lines: number;
}

type Filter = 'due' | 'current' | 'needs' | 'shotblast' | 'all';

/**
 * The default view is what is on order, not the whole MYOB code list: the
 * current range is chosen from the codes people are actually buying, out of a
 * couple of thousand rows that also contain freight, pallets and last decade.
 */
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'due', label: 'In open jobs' },
  { value: 'current', label: 'Current range' },
  { value: 'needs', label: 'Needs setting' },
  { value: 'shotblast', label: 'Shotblast' },
  { value: 'all', label: 'All codes' },
];

/** What still has to be decided before a product can be planned. */
export function missingSetup(p: Product): string[] {
  const out: string[] = [];
  if (p.route === 'unset') out.push('route');
  if (!p.unit) out.push('unit');
  if (p.trayYield <= 0) out.push('tray yield');
  return out;
}

export function Products() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('due');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [openCode, setOpenCode] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // `#/products?code=S3` arrives from the matrix popup. The row is picked out of
  // whatever filter is showing, so the drawer opens even if the code is currently
  // hidden by the filter — a link that lands on a blank screen is a broken link.
  const wantedCode = useRoute().query.get('code');
  useEffect(() => {
    if (wantedCode) setOpenCode(wantedCode);
  }, [wantedCode]);
  // Who is reading this board. Everything write-shaped is withheld, and the writes
  // themselves are refused in src/data/productRepo.ts, so a viewer cannot edit the
  // range from a console either.
  const canEdit = useCan('products.edit');

  // Rank order, not code order: a drag writes a rank between its *displayed*
  // neighbours, so the list on screen has to be the rank order it is editing.
  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted).sortBy('rank'), []);
  const stock = useLiveQuery(() => latestStockSnapshot(), []);
  const jobs = useLiveQuery(() => latestJobsSnapshot(), []);
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const settings = useLiveQuery(() => getSettings(), []);


  const view = useView(
    SCREENS.products,
    useMemo(() => defaultView(SCREENS.products, COLUMN_META.map((c) => c.key)), []),
  );

  const rows = useMemo<Row[]>(() => {
    if (!products || !settings) return [];
    const demand = demandByProduct(jobs?.rows ?? [], settings);
    return products.map((p) => {
      const pos = productPosition({
        product: p,
        stockRows: stock?.rows ?? [],
        batches: batches ?? [],
        stockCapturedAt: stock?.capturedAt ?? null,
        settings,
      });
      const d = demand.get(p.code);
      return {
        ...p,
        stockReal: pos.stockReal,
        inclCuringBlasted: pos.inclCuringBlasted,
        toGetToTarget: pos.toGetToTarget,
        demand: d?.demand ?? 0,
        lines: d?.lines ?? 0,
      };
    });
  }, [products, stock, batches, jobs, settings]);

  const shown = useMemo(() => {
    let out = rows;
    if (filter === 'due') out = out.filter((r) => r.seenInJobs || r.lines > 0);
    // Asked through the predicate, so the list called "Current range" here is the
    // same set of codes every planning screen plans. The default filter stays what it
    // was — what is on order — because this is the screen that sets the tick, and a
    // list filtered by the tick is a code you cannot untick again.
    if (filter === 'current') out = out.filter((r) => isCurrentProduct(r));
    if (filter === 'needs') out = out.filter((r) => isCurrentProduct(r) && missingSetup(r).length > 0);
    if (filter === 'shotblast') out = out.filter((r) => r.route === 'shotblast');
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((r) => `${r.code} ${r.description} ${r.notes}`.toLowerCase().includes(q));
    return out;
  }, [rows, filter, search]);

  const counts = useMemo(
    () => ({
      total: rows.length,
      // Same predicate as the boards, so the number beside this screen's name is the
      // number the Matrix and the plan are working from.
      current: currentProducts(rows).length,
      needs: rows.filter((r) => isCurrentProduct(r) && missingSetup(r).length > 0).length,
      idle: rows.filter((r) => isCurrentProduct(r) && r.lines === 0).length,
    }),
    [rows],
  );

  const write = useCallback(async (code: string, patch: ProductPatch): Promise<void> => {
    const after = await patchProduct(code, patch);
    if (after) toast('info', `${code} updated`, describePatch(patch));
  }, []);

  const togglePick = useCallback((code: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const columns = useMemo(
    () => columnsFor({ write, isPicked: (c) => picked.has(c), togglePick, readOnly: !canEdit }),
    [write, picked, togglePick, canEdit],
  );

  const open = openCode ? (rows.find((r) => r.code === openCode) ?? null) : null;

  const applyBulk = useCallback(async (patch: ProductPatch): Promise<void> => {
    const codes = [...picked];
    if (codes.length === 0) return;
    const { updated } = await bulkPatchProducts(codes, patch);
    toast('info', `${updated} product${updated === 1 ? '' : 's'} updated`, describePatch(patch));
    setPicked(new Set());
  }, [picked]);

  const exportCsv = (): void => {
    const url = URL.createObjectURL(new Blob([productsToCsv(shown)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'freo-products.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast('info', `${shown.length} products exported`, 'Settings only — stock figures stay in MYOB.');
  };

  const importCsv = async (file: File): Promise<void> => {
    const parsed = parseProductsCsv(await file.text());
    const { updated, unknown } = await applyCsvUpdates(parsed.updates);
    const notes = [
      unknown.length > 0 ? `${unknown.length} unknown code${unknown.length === 1 ? '' : 's'} skipped` : '',
      parsed.issues.length > 0 ? `${parsed.issues.length} row${parsed.issues.length === 1 ? '' : 's'} with problems` : '',
    ].filter(Boolean);
    toast('info', `${updated} products updated`, notes.join(' · ') || undefined);
    for (const issue of parsed.issues.slice(0, 4)) toast('warn', `Line ${issue.line}`, issue.message);
  };

  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.code));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* No counts above the board. The filter says what you are looking at and
          the line under the table says how many of them are on screen; a row of
          numbers nobody asked for was the first thing on the screen for no reason.
          `counts` still drives the empty states and that footer. */}
      <Card
        padded={false}
        title="Products"
        className="flex min-h-0 flex-1 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col"
        subtitle="Tick what belongs in the current range, then set how each one is made and counted."
        actions={
          <>
            <Button size="sm" icon="download" onClick={exportCsv}>
              Export CSV
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void importCsv(file);
              }}
            />
            {/* A viewer reads the range; the sheet that changes it is not offered. */}
            {canEdit ? (
              <Button size="sm" icon="upload" onClick={() => fileInput.current?.click()}>
                Import CSV
              </Button>
            ) : null}
          </>
        }
      >
        <div className="border-b border-line px-3 py-2">
          <ViewToolbar
            view={view.view}
            patch={view.patch}
            columns={COLUMN_META}
            isPersonal={view.isPersonal}
            hasShared={view.hasShared}
            onResetToShared={view.resetToShared}
            onPublishDefault={view.publishAsDefault}
            allowManualOrder
            extra={
              <>
                <TextInput
                  placeholder="Filter code, description or note…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-64"
                />
                <Select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as Filter)}
                  options={FILTERS}
                  className="w-40"
                />
                {/* Picking exists to feed the bulk edit, so it is a writer's control —
                    and it appears only when there is something to pick. The rows of
                    this board arrive from four separate live queries, and for a
                    moment after the screen opens they are not all in yet: a button
                    that reads "Pick all 0" and then quietly picks nothing is a
                    button that lies, so it is not offered until the board is
                    actually on screen. */}
                {canEdit && shown.length > 0 ? (
                  <Button
                    size="sm"
                    variant={allShownPicked ? 'primary' : 'default'}
                    onClick={() =>
                      setPicked(allShownPicked ? new Set() : new Set(shown.map((r) => r.code)))
                    }
                  >
                    {allShownPicked ? 'Unpick all' : `Pick all ${formatNumber(shown.length, 0)}`}
                  </Button>
                ) : null}
                <Chip tone="info" title="Baseline items have the phantom 10000 removed from on-hand.">
                  {formatNumber(shown.length, 0)} of {formatNumber(counts.total, 0)} shown
                </Chip>
                {canEdit ? null : (
                  <Chip tone="warn" title="Only the owner and makers change the range.">
                    Read only
                  </Chip>
                )}
              </>
            }
          />
        </div>

        {/* A viewer reads this board: the picking controls and the bulk bar are not
            offered at all, and the writes underneath refuse as well. */}
        {canEdit && picked.size > 0 ? <BulkBar pickedCount={picked.size} onApply={(p) => void applyBulk(p)} /> : null}

        {/* Down to the bottom of the window, whatever is sitting above it. The
            gap is the footnote underneath and, below 640px, the shell's bottom
            padding that keeps content clear of the phone's nav. */}
        <div className="flex min-h-[240px] flex-1 flex-col">
          <DataTable
            rows={shown}
            columns={columns}
            view={view.view}
            onViewChange={view.patch}
            getRowId={(r) => r.code}
            rankOf={(r) => r.rank}
            selectedId={openCode}
            onRowClick={(r) => setOpenCode(r.code)}
            {...(canEdit
              ? { onReorder: (code: string, to: number) => void moveProductInList(code, to, shown) }
              : {})}
            // Four live queries feed this board. Until all four have answered the
            // grid is legitimately empty, and an empty grid with no spinner reads
            // as "there is nothing here" to the person who just imported 2,365
            // codes. The spinner is the honest answer while they are in flight.
            loading={
              products === undefined || settings === undefined || stock === undefined || jobs === undefined
            }
            rowClassName={(r) => (picked.has(r.code) ? 'bg-accent/[0.07]' : undefined)}
            empty={
              <EmptyState
                icon="products"
                title={counts.total === 0 ? 'No product codes yet' : 'Nothing matches this filter'}
                body={
                  counts.total === 0
                    ? 'Import the MYOB exports on the Data sources screen — the codes arrive with them.'
                    : counts.current === 0
                      ? "Nothing is in the current range yet. Switch to In open jobs, pick the rows and tick Current — everything else stays out of the matrix."
                      : 'Change the filter above, or clear the search, to see the rest of the codes.'
                }
              />
            }
          />
        </div>
      </Card>

      {settings ? (
        <ProductDrawer
          readOnly={!canEdit}
          product={open}
          position={
            open
              ? {
                  stockReal: open.stockReal,
                  inclCuringBlasted: open.inclCuringBlasted,
                  toGetToTarget: open.toGetToTarget,
                  demand: open.demand,
                  lines: open.lines,
                  // Not computed yet: the first day this code could be ready needs
                  // curing maths over open batches and open job lines. It stays
                  // null until that exists rather than showing a guessed date.
                  earliest: null,
                }
              : null
          }
          defaultCureDays={settings.production.defaultCureDays}
          onClose={() => setOpenCode(null)}
        />
      ) : null}

      <p className="flex max-w-[70ch] items-start gap-1.5 text-xs text-ink3">
        <Icon name="info" size={13} className="mt-0.5 shrink-0" />
        <span>
          Tick <b>Current</b> for anything you make: everything else stays listed but out of the matrix, so an old MYOB
          code cannot show up as a hole in the plan. Settings round-trip as CSV with the columns{' '}
          <code className="text-ink2">{CSV_HEADER}</code>.
        </span>
      </p>
    </div>
  );
}

/* ── Bulk edit ─────────────────────────────────────────────────────────────── */

function BulkBar({ pickedCount, onApply }: { pickedCount: number; onApply: (patch: ProductPatch) => void }) {
  const [route, setRoute] = useState<ProductRoute | ''>('');
  const [unit, setUnit] = useState('');
  const [cureDays, setCureDays] = useState<number | null>(null);

  const apply = (): void => {
    const patch: ProductPatch = {};
    if (route !== '') patch.route = route;
    if (unit !== '') patch.unit = unit;
    if (cureDays != null) patch.cureDays = cureDays;
    if (Object.keys(patch).length > 0) onApply(patch);
  };

  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-line bg-surface2 px-2.5 py-2">
      <span className="flex items-center gap-1.5 pb-1 text-sm font-600">
        <Icon name="check" size={14} className="text-accent" />
        {pickedCount} picked
      </span>
      <Field label="Made how">
        <Select
          aria-label="Set the route of the picked products"
          value={route}
          onChange={(e) => setRoute(e.target.value as ProductRoute | '')}
          options={[
            { value: '', label: 'Choose…' },
            ...(Object.keys(ROUTE_LABELS) as ProductRoute[]).map((r) => ({ value: r, label: ROUTE_LABELS[r] })),
          ]}
          className="w-36"
        />
      </Field>
      <Field label="Unit">
        <Select
          aria-label="Set the unit of the picked products"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          options={[{ value: '', label: 'Choose…' }, ...UNIT_OPTIONS]}
          className="w-28"
        />
      </Field>
      <Field label="Cure days">
        <NumberInput
          aria-label="Set the cure days of the picked products"
          value={cureDays}
          min={0}
          onValueChange={setCureDays}
          className="w-24"
        />
      </Field>
      <Button size="sm" variant="primary" onClick={apply} disabled={route === '' && unit === '' && cureDays == null}>
        Apply to picked
      </Button>
      <Button size="sm" onClick={() => onApply({ enabled: true })}>
        Mark current
      </Button>
      <Button size="sm" onClick={() => onApply({ enabled: false })}>
        Mark not current
      </Button>
    </div>
  );
}

/* ── Columns ───────────────────────────────────────────────────────────────── */

const COLUMN_META: Array<{ key: string; header: string }> = [
  { key: 'pick', header: '' },
  { key: 'code', header: 'Item No.' },
  { key: 'enabled', header: 'Current' },
  { key: 'description', header: 'Description' },
  { key: 'route', header: 'Made how' },
  { key: 'unit', header: 'Unit' },
  { key: 'usesBaseline10000', header: 'Baseline' },
  { key: 'trayYield', header: 'Per tray' },
  { key: 'target', header: 'Target' },
  { key: 'cureDays', header: 'Cure (d)' },
  { key: 'stockReal', header: 'On hand' },
  { key: 'inclCuringBlasted', header: 'Incl curing & blasted' },
  { key: 'toGetToTarget', header: 'To get to target' },
  { key: 'demand', header: 'Open jobs' },
  { key: 'lines', header: 'Lines' },
  { key: 'notes', header: 'Notes' },
];

interface Handlers {
  write: (code: string, patch: ProductPatch) => Promise<void>;
  isPicked: (code: string) => boolean;
  togglePick: (code: string) => void;
  readOnly: boolean;
}

/** The tick a writer sees, minus the button underneath it. */
function ReadCheck({ on }: { on: boolean }): ReactNode {
  return (
    <CellStatic className="justify-center">
      {on ? (
        <Icon name="check" size={12} className="text-curing" />
      ) : (
        <span className="text-eyebrow text-ink3">—</span>
      )}
    </CellStatic>
  );
}

/**
 * A viewer's board is the same board with nothing to click.
 *
 * Dropping `render` from a column hands the cell back to the engine, which draws the
 * column's own `value` through its `format` — the identical text a writer sees in an
 * unedited cell. Only the four columns whose writer state is not plain text need a
 * substitute. The pick column is not in the list because it is removed outright: it
 * exists to feed the bulk edit.
 */
const READ_ONLY_RENDER: Partial<Record<string, (row: Row) => ReactNode>> = {
  enabled: (r) => <ReadCheck on={r.enabled} />,
  usesBaseline10000: (r) => <ReadCheck on={r.usesBaseline10000} />,
  route: (r) => <CellStatic>{ROUTE_LABELS[r.route]}</CellStatic>,
  unit: (r) => <CellStatic>{unitLabel(r.unit)}</CellStatic>,
};

function columnsFor({ write, isPicked, togglePick, readOnly }: Handlers): ColumnDef<Row>[] {
  const edit = (code: string) => (patch: ProductPatch): void => {
    // Nobody should be able to reach this from a read-only board, and the data layer
    // would refuse it anyway. Both are true, so both are written down.
    if (readOnly) return;
    void write(code, patch);
  };

  const columns: ColumnDef<Row>[] = [
    {
      key: 'pick',
      header: '',
      value: (r) => isPicked(r.code),
      width: 40,
      minWidth: 40,
      sortable: false,
      headerHint: 'Tick products to change several at once',
      render: (r) => (
        <CellCheck checked={isPicked(r.code)} onCommit={() => togglePick(r.code)} label={`Pick ${r.code}`} />
      ),
    },
    { key: 'code', header: 'Item No.', value: (r) => r.code, format: 'code', sticky: true, width: 104 },
    {
      key: 'enabled',
      header: 'Current',
      value: (r) => r.enabled,
      width: 84,
      minWidth: 64,
      align: 'center',
      headerHint: 'Only current products are planned or shown in the matrix',
      render: (r) => (
        <CellCheck
          checked={r.enabled}
          onCommit={(enabled) => edit(r.code)({ enabled })}
          label={`${r.code} is a current product`}
        />
      ),
    },
    { key: 'description', header: 'Description', value: (r) => r.description, width: 240 },
    {
      key: 'route',
      header: 'Made how',
      value: (r) => ROUTE_LABELS[r.route],
      format: 'status',
      width: 134,
      tone: (r) => (r.enabled && r.route === 'unset' ? 'warn' : null),
      render: (r) => (
        <CellSelect
          value={r.route}
          options={(Object.keys(ROUTE_LABELS) as ProductRoute[]).map((k) => ({ value: k, label: ROUTE_LABELS[k] }))}
          onCommit={(route) => edit(r.code)({ route })}
        />
      ),
    },
    {
      key: 'unit',
      header: 'Unit',
      value: (r) => unitLabel(r.unit),
      width: 96,
      align: 'center',
      tone: (r) => (r.enabled && !r.unit ? 'warn' : null),
      render: (r) => {
        const known = UNIT_OPTIONS.some((u) => u.value === r.unit);
        return (
          <CellSelect
            value={r.unit}
            options={known ? UNIT_OPTIONS : [...UNIT_OPTIONS, { value: r.unit, label: unitLabel(r.unit) }]}
            onCommit={(unit) => edit(r.code)({ unit })}
          />
        );
      },
    },
    {
      key: 'usesBaseline10000',
      header: 'Baseline',
      value: (r) => r.usesBaseline10000,
      width: 84,
      minWidth: 64,
      align: 'center',
      headerHint: 'MYOB holds these as actual + 10000, so 10000 comes off once',
      render: (r) => (
        <CellCheck
          checked={r.usesBaseline10000}
          onCommit={(usesBaseline10000) => edit(r.code)({ usesBaseline10000 })}
          label={`${r.code} carries the phantom 10000 in MYOB`}
        />
      ),
    },
    {
      key: 'trayYield',
      header: 'Per tray',
      value: (r) => r.trayYield,
      format: 'number',
      decimals: 3,
      width: 104,
      headerHint: 'What one tray makes, in the product’s unit',
      tone: (r) => (r.enabled && r.trayYield <= 0 ? 'warn' : null),
      render: (r) => (
        <CellNumber value={r.trayYield} decimals={3} onCommit={(trayYield) => edit(r.code)({ trayYield: trayYield ?? 0 })} />
      ),
    },
    {
      key: 'target',
      header: 'Target',
      value: (r) => r.target,
      format: 'number',
      width: 108,
      totals: 'sum',
      headerHint: 'What to hold. Drives TO GET TO TARGET.',
      render: (r) => <CellNumber value={r.target} onCommit={(target) => edit(r.code)({ target: target ?? 0 })} />,
    },
    {
      key: 'cureDays',
      header: 'Cure (d)',
      value: (r) => r.cureDays,
      format: 'number',
      decimals: 0,
      width: 84,
      render: (r) => <CellNumber value={r.cureDays} decimals={0} onCommit={(cureDays) => edit(r.code)({ cureDays: cureDays ?? 0 })} />,
    },
    {
      key: 'stockReal',
      header: 'On hand',
      value: (r) => r.stockReal,
      format: 'number',
      width: 112,
      totals: 'sum',
      tone: (r) => (r.stockReal < 0 ? 'short' : null),
      headerHint: 'Chosen locations, baseline removed',
    },
    {
      key: 'inclCuringBlasted',
      header: 'Incl curing & blasted',
      value: (r) => r.inclCuringBlasted,
      format: 'number',
      width: 154,
      headerHint: 'On hand plus everything made and not yet keyed into MYOB',
    },
    {
      key: 'toGetToTarget',
      header: 'To get to target',
      value: (r) => r.toGetToTarget,
      format: 'number',
      width: 132,
      totals: 'sum',
      tone: (r) => (r.toGetToTarget > 0 ? 'short' : null),
    },
    {
      key: 'demand',
      header: 'Open jobs',
      value: (r) => r.demand,
      format: 'number',
      width: 112,
      totals: 'sum',
      headerHint: 'Near-term demand from the sales export; placeholder dates excluded',
    },
    { key: 'lines', header: 'Lines', value: (r) => r.lines, format: 'number', decimals: 0, width: 76 },
    {
      key: 'notes',
      header: 'Notes',
      value: (r) => r.notes,
      width: 220,
      render: (r) => <CellText value={r.notes} onCommit={(notes) => edit(r.code)({ notes })} />,
    },
  ];

  if (!readOnly) return columns;
  return columns
    .filter((c) => c.key !== 'pick')
    .map(({ render: _render, ...rest }) => {
      const asText = READ_ONLY_RENDER[rest.key];
      return asText ? { ...rest, render: asText } : rest;
    });
}

function describePatch(patch: ProductPatch): string {
  const bits: string[] = [];
  if (patch.enabled !== undefined) bits.push(patch.enabled ? 'current' : 'not current');
  if (patch.route !== undefined) bits.push(ROUTE_LABELS[patch.route]);
  if (patch.unit !== undefined) bits.push(unitLabel(patch.unit));
  if (patch.cureDays !== undefined) bits.push(`${patch.cureDays} day cure`);
  if (patch.usesBaseline10000 !== undefined) bits.push(patch.usesBaseline10000 ? 'baseline on' : 'baseline off');
  if (patch.trayYield !== undefined) bits.push(`${patch.trayYield} per tray`);
  if (patch.target !== undefined) bits.push(`target ${patch.target}`);
  if (patch.notes !== undefined) bits.push('notes');
  return bits.join(' · ');
}
