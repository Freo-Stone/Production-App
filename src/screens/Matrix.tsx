import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCan } from '@/app/session';
import { navigate } from '@/app/router';
import { useView } from '@/app/useView';
import { defaultView, SCREENS } from '@/core/defaults';
import {
  cellLines,
  dueIn,
  HORIZONS,
  isHorizon,
  matrixDayKey,
  matrixDays,
  matrixRows,
  type MatrixRow,
} from '@/core/matrix';
import type { JobRow, Settings } from '@/core/types';
import { formatNumber, round, unitLabel } from '@/core/format';
import { db, getSettings, latestJobsSnapshot, latestStockSnapshot } from '@/data/db';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { ViewToolbar } from '@/ui/DataTable/ViewToolbar';
import { Icon } from '@/ui/Icon';
import {
  Button,
  Card,
  Chip,
  cx,
  EmptyState,
  Modal,
  Segmented,
  TextInput,
  Toggle,
} from '@/ui/primitives';

/**
 * The matrix — product against day, the screen the app is named after.
 *
 * Rows are the current range in the order it was arranged on the Products screen,
 * so the board and that list never disagree about what comes first. Each day column
 * is what is *promised* of that product on that day; the colour of the row is
 * whether the product is a problem at all. Those are deliberately different things:
 * MYOB's on-hand figure is already net of the open jobs, so a day cell that deducted
 * demand from stock again would call every product in the shop short. `src/core/
 * matrix.ts` holds that argument; the comment is here because this is where it is
 * read.
 *
 * A cell is a button, not a number to be read at arm's length: this board gets used
 * with one thumb, standing up, and the answer to "what is that?" is always the same
 * — the jobs behind the figure, and what is already on its way.
 */

/** Keys a view can hold. Day columns are keyed by date and are not in here: they
 *  arrive and leave with the horizon, and a saved view should not have to know. */
const STATIC_KEYS = ['code', 'description', 'unit', 'stock', 'incl', 'target', 'due', 'beyond'] as const;

const COLUMN_META: Array<{ key: string; header: string }> = [
  { key: 'code', header: 'Code' },
  { key: 'description', header: 'Product' },
  { key: 'unit', header: 'Unit' },
  { key: 'stock', header: 'In stock' },
  { key: 'incl', header: 'Incl. curing & blasted' },
  { key: 'target', header: 'To get to target' },
  { key: 'due', header: 'Due in view' },
  { key: 'beyond', header: 'Beyond the horizon' },
];

const HORIZON_OPTIONS = HORIZONS.map((w) => ({
  value: String(w),
  label: w === 1 ? '1 wk' : `${w} wks`,
  title: w === 1 ? 'The next seven days' : `The next ${w} weeks`,
}));

/** A tone is a colour and a sentence. Kept together so the legend and the cells
 *  cannot drift apart from what `productPosition` actually decided. */
const TONE_TEXT: Record<MatrixRow['tone'], string> = {
  short: 'Under target, and nothing curing closes the gap. Make more.',
  needsCuring: 'Under target, but material on the clock gets there. Wait.',
  neutral: 'At or over target.',
};

const LATE_TEXT = 'The last day a make could start and still land here has passed.';

interface Open {
  code: string;
  /** null means the row was opened, not a particular day. */
  day: number | null;
}

export function Matrix() {
  const [search, setSearch] = useState('');
  const [onlyShort, setOnlyShort] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);

  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted).sortBy('rank'), []);
  const stock = useLiveQuery(() => latestStockSnapshot(), []);
  const jobs = useLiveQuery(() => latestJobsSnapshot(), []);
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const settings = useLiveQuery(() => getSettings(), []);


  const fallback = useMemo(
    () => defaultView(SCREENS.matrix, [...STATIC_KEYS]),
    [],
  );
  const view = useView(SCREENS.matrix, fallback);

  const weeks: (typeof HORIZONS)[number] = isHorizon(view.view.horizonWeeks) ? view.view.horizonWeeks : 4;
  const days = useMemo(() => matrixDays(weeks), [weeks]);

  const rows = useMemo<MatrixRow[]>(() => {
    if (!products || !settings || days.length === 0) return [];
    const enabled = products.filter((p) => p.enabled);
    const out = matrixRows({
      products: enabled,
      jobs: jobs?.rows ?? [],
      stockRows: stock?.rows ?? [],
      batches: batches ?? [],
      stockCapturedAt: stock?.capturedAt ?? null,
      settings,
      days,
    });
    const q = search.trim().toLowerCase();
    let filtered = q
      ? out.filter((r) => `${r.code} ${r.description}`.toLowerCase().includes(q))
      : out;
    if (onlyShort) filtered = filtered.filter((r) => r.tone === 'short');
    return filtered;
  }, [products, settings, jobs, stock, batches, days, search, onlyShort]);

  const openCell = useCallback((code: string, day: number | null) => setOpen({ code, day }), []);

  const columns = useMemo<MatrixRowColumn[]>(
    () => columnsFor((code, day) => openCell(code, day)),
    [openCell],
  );

  const dayColumns = useMemo<MatrixRowColumn[]>(
    () =>
      days.map((d) => dayColumn(d.day, d.today, d.weekend, (code, day) => openCell(code, day))),
    [days, openCell],
  );

  const allColumns = useMemo(() => [...columns, ...dayColumns], [columns, dayColumns]);

  // On a phone the saved short list wins. Until someone makes one, the board shows
  // the product, where it stands, and the next few days — 40 columns sideways on a
  // 390px screen is not a board, it is a scrolling accident.
  const phoneView = useMemo(() => {
    if (view.view.mobileColumns) return view.view;
    const firstDays = days.slice(0, 4).map((d) => matrixDayKey(d.day));
    return { ...view.view, mobileColumns: [...STATIC_KEYS.slice(0, 6), ...firstDays] };
  }, [view.view, days]);

  const totals = useMemo(() => {
    let short = 0;
    let needsCuring = 0;
    for (const r of rows) {
      if (r.tone === 'short') short++;
      else if (r.tone === 'needsCuring') needsCuring++;
    }
    return { short, needsCuring };
  }, [rows]);

  const nothingImported = (stock?.rows.length ?? 0) === 0 && (jobs?.rows.length ?? 0) === 0;
  const nothingEnabled = (products ?? []).filter((p) => p.enabled && !p.deleted).length === 0;

  const selected = open ? rows.find((r) => r.code === open.code) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Card
        className="flex min-h-0 flex-1 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col"
        padded={false}
        title="Matrix"
        subtitle="What is promised of each product, day by day, over where the stock actually stands."
        actions={
          <>
            <Segmented
              size="sm"
              value={String(weeks)}
              onChange={(next) => {
                const w = Number(next);
                if (isHorizon(w)) view.patch({ horizonWeeks: w });
              }}
              options={HORIZON_OPTIONS}
            />
            <Chip tone="short" title={TONE_TEXT.short}>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-short" />
                Short
              </span>
            </Chip>
            <Chip tone="curing" title={TONE_TEXT.needsCuring}>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-curing" />
                Needs curing
              </span>
            </Chip>
            <Chip tone="warn" title={LATE_TEXT}>
              <span className="flex items-center gap-1.5">
                <span className="font-700 text-warn">!</span>
                Past start date
              </span>
            </Chip>
          </>
        }
      >
        <div className="border-b border-line px-2 py-2">
          <ViewToolbar
            view={phoneView}
            patch={view.patch}
            columns={COLUMN_META}
            isPersonal={view.isPersonal}
            hasShared={view.hasShared}
            onResetToShared={view.resetToShared}
            onPublishDefault={view.publishAsDefault}
            extra={
              <>
                <TextInput
                  placeholder="Filter code or product…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-56"
                />
                <Toggle
                  checked={onlyShort}
                  onChange={setOnlyShort}
                  label="Only short"
                  hint="Hide everything that is at or over target"
                />
                <Chip tone="info" title="Demand promised after the last column, placeholder dates left out.">
                  {formatNumber(totals.short, 0)} short · {formatNumber(totals.needsCuring, 0)} curing
                </Chip>
              </>
            }
          />
        </div>

        <div className="flex min-h-[240px] flex-1 flex-col">
          <DataTable
            rows={rows}
            columns={allColumns}
            view={phoneView}
            onViewChange={view.patch}
            getRowId={(r) => r.code}
            rankOf={(r) => r.rank}
            selectedId={open?.code ?? null}
            onRowClick={(r) => openCell(r.code, null)}
            loading={products === undefined || settings === undefined}
            rowClassName={(r) => (r.tone === 'short' ? 'bg-short/[0.05]' : undefined)}
            empty={
              nothingImported ? (
                <EmptyState
                  icon="sources"
                  title="Nothing imported yet"
                  body="The matrix reads the two MYOB exports: what is in stock, and what the open jobs promise. Import them and the board fills in."
                  action={
                    <Button size="sm" onClick={() => navigate('/sources')}>
                      Go to Data sources
                    </Button>
                  }
                />
              ) : nothingEnabled ? (
                <EmptyState
                  icon="products"
                  title="No products are in the current range"
                  body="The stock export holds a couple of thousand codes, most of them freight and pallets. Tick the ones you make on the Products screen and they appear here."
                  action={
                    <Button size="sm" onClick={() => navigate('/products')}>
                      Go to Products
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon="matrix"
                  title={onlyShort ? 'Nothing is short in the current range' : 'Nothing matches this filter'}
                  body={
                    onlyShort
                      ? 'Every product in the range is at or over its target, or has enough curing to get there. Turn "Only short" off to see the whole board.'
                      : 'Clear the filter above to see the rest of the range.'
                  }
                />
              )
            }
          />
        </div>
      </Card>

      <CellDialog
        row={selected}
        day={open?.day ?? null}
        jobs={jobs?.rows ?? []}
        settings={settings}
        weeks={weeks}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/* ── Columns ───────────────────────────────────────────────────────────────── */

type MatrixRowColumn = ColumnDef<MatrixRow>;

const TONE_CELL: Record<MatrixRow['tone'], string> = {
  short: 'text-short',
  needsCuring: 'text-curing',
  neutral: '',
};

function columnsFor(onCell: (code: string, day: number | null) => void): MatrixRowColumn[] {
  return [
    {
      key: 'code',
      header: 'Code',
      value: (r) => r.code,
      format: 'code',
      width: 78,
      sticky: true,
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCell(r.code, null);
          }}
          className="w-full text-left font-600 text-ink hover:text-accent"
        >
          {r.code}
        </button>
      ),
    },
    {
      key: 'description',
      header: 'Product',
      value: (r) => r.description,
      format: 'text',
      width: 232,
      minWidth: 120,
      sticky: true,
      wrap: false,
      render: (r) => (
        <span className="flex items-center gap-1.5 truncate">
          {r.description || <span className="text-ink3">no description</span>}
          {r.target <= 0 ? (
            <span title="No target set, so this row can never be judged short. Set one on Products.">
              <Icon name="alert" size={13} className="text-ink3" />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'unit',
      header: 'Unit',
      value: (r) => r.unit,
      format: 'text',
      width: 68,
      render: (r) => <span className="text-ink3">{unitLabel(r.unit)}</span>,
    },
    {
      key: 'stock',
      header: 'In stock',
      value: (r) => r.stockReal,
      format: 'qty',
      width: 104,
      unit: (r) => r.unit,
      totals: 'sum',
      tone: (r) => (r.tone === 'short' ? 'short' : null),
      headerHint: 'MYOB on-hand for the chosen locations, with the phantom 10000 removed where it applies.',
    },
    {
      key: 'incl',
      header: 'Incl. curing & blasted',
      value: (r) => r.inclCuringBlasted,
      format: 'qty',
      width: 132,
      unit: (r) => r.unit,
      totals: 'sum',
      tone: (r) => (r.tone === 'needsCuring' ? 'curing' : null),
      headerHint: 'On-hand plus everything made and not yet keyed into MYOB.',
    },
    {
      key: 'target',
      header: 'To get to target',
      value: (r) => r.toGetToTarget,
      format: 'qty',
      width: 118,
      unit: (r) => r.unit,
      totals: 'sum',
      tone: (r) => (r.toGetToTarget > 0 ? 'short' : null),
      headerHint: 'What has to be made to reach the target on the Products screen.',
    },
    {
      key: 'due',
      header: 'Due in view',
      value: (r) => r.due,
      format: 'qty',
      width: 104,
      unit: (r) => r.unit,
      totals: 'sum',
      headerHint: 'Total promised inside the day columns on screen.',
    },
    {
      key: 'beyond',
      header: 'Beyond',
      value: (r) => r.beyond,
      format: 'qty',
      width: 92,
      unit: (r) => r.unit,
      totals: 'sum',
      tone: (r) => (r.beyond > 0 ? 'info' : null),
      headerHint: 'Promised after the last column. Placeholder dates (4/04/2040) are not counted here.',
    },
  ];
}

/** One day. Keyed by the date so a saved width stays with the day it was set for. */
function dayColumn(
  day: number,
  today: boolean,
  weekend: boolean,
  onCell: (code: string, day: number) => void,
): MatrixRowColumn {
  const d = new Date(day);
  return {
    key: matrixDayKey(day),
    header: `${WEEKDAY[d.getDay()] ?? ''} ${d.getDate()}`,
    headerHint: new Date(day).toDateString(),
    value: (r) => netOf(r, day),
    format: 'number',
    decimals: 2,
    width: 88,
    minWidth: 56,
    align: 'right',
    totals: 'sum',
    tone: (r) => (r.tone === 'short' ? 'short' : r.tone === 'needsCuring' ? 'curing' : null),
    render: (r) => {
      const cell = r.cells.get(day);
      const net = netOf(r, day);
      return (
        <button
          type="button"
          title={`${r.code} · ${formatNumber(net, 2)}${cell ? ` · ${cell.lines} job${cell.lines === 1 ? '' : 's'}` : ' · nothing promised'}`}
          onClick={(e) => {
            e.stopPropagation();
            onCell(r.code, day);
          }}
          className={cx(
            '-mx-1 flex h-full w-[calc(100%+0.5rem)] items-center justify-end gap-1 rounded px-1',
            'num hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none',
            TONE_CELL[r.tone],
            weekend && 'bg-surface2/60',
            today && 'ring-1 ring-inset ring-accent/40',
          )}
        >
          {cell?.late ? (
            <span className="font-700 text-warn" title={LATE_TEXT}>
              !
            </span>
          ) : null}
          {net === 0 ? (
            <span className="text-ink3/40">·</span>
          ) : (
            <span>{formatNumber(net, decimalsFor(net))}</span>
          )}
        </button>
      );
    },
  };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function netOf(row: MatrixRow, day: number): number {
  const cell = row.cells.get(day);
  return cell ? round(cell.gross + cell.credits, 4) : 0;
}

/** A board of whole numbers reads better without decimals on every cell. */
function decimalsFor(value: number): number {
  return Number.isInteger(value) ? 0 : 2;
}

/* ── The popup ─────────────────────────────────────────────────────────────── */

function CellDialog({
  row,
  day,
  jobs,
  settings,
  weeks,
  onClose,
}: {
  row: MatrixRow | null;
  day: number | null;
  jobs: JobRow[];
  settings: Settings | undefined;
  weeks: number;
  onClose: () => void;
}) {
  // Someone looking at a shortfall should be able to act on it from where they
  // are standing. A viewer gets the Products link only, because entry would refuse them.
  const canLog = useCan('production.record');
  const open = row != null;
  const lines = row && day != null && settings ? cellLines(jobs, row.code, day, settings) : [];
  const title = row ? `${row.code}${day != null ? ` · ${new Date(day).toDateString()}` : ''}` : '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="md"
      title={title}
      subtitle={
        row ? (
          <span className="flex flex-wrap items-center gap-2">
            <span>{row.description}</span>
            <Chip tone={row.tone === 'short' ? 'short' : row.tone === 'needsCuring' ? 'curing' : 'info'}>
              {TONE_TEXT[row.tone]}
            </Chip>
            {row.oversold ? <Chip tone="short">Oversold — on-hand is negative</Chip> : null}
          </span>
        ) : null
      }
      footer={
        row ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink3">
              {day != null ? `Promised ${dueIn(day)}` : `Every day in the next ${weeks} weeks`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {canLog ? (
                <Button size="sm" variant="primary" onClick={() => navigate(`/entry?code=${row.code}`)}>
                  Log making of this
                </Button>
              ) : null}
              <Button size="sm" onClick={() => navigate(`/products?code=${row.code}`)}>
                Open in Products
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {row ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Fact label="In stock" value={formatNumber(row.stockReal, 2)} unit={row.unit} tone={row.tone === 'short' ? 'short' : undefined} />
            <Fact label="Curing" value={formatNumber(row.curing, 2)} unit={row.unit} />
            <Fact label="Awaiting blast" value={formatNumber(row.awaitingBlast, 2)} unit={row.unit} />
            <Fact label="Blasting" value={formatNumber(row.blasting, 2)} unit={row.unit} />
            <Fact label="Ready, not entered" value={formatNumber(row.ready, 2)} unit={row.unit} />
            <Fact
              label="Incl. curing & blasted"
              value={formatNumber(row.inclCuringBlasted, 2)}
              unit={row.unit}
              tone={row.tone === 'needsCuring' ? 'curing' : undefined}
            />
            <Fact label="Target" value={formatNumber(row.target, 2)} unit={row.unit} />
            <Fact
              label="To get to target"
              value={formatNumber(row.toGetToTarget, 2)}
              unit={row.unit}
              tone={row.toGetToTarget > 0 ? 'short' : undefined}
            />
            <Fact label="Beyond this view" value={formatNumber(row.beyond, 2)} unit={row.unit} />
          </dl>

          {day == null ? (
            <HorizonList row={row} />
          ) : lines.length === 0 ? (
            <p className="rounded border border-line bg-surface2 p-3 text-sm text-ink3">
              Nothing is promised of {row.code} on this day. The figures above are where the product
              stands right now.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded border border-line">
              {lines.map((line) => (
                <li key={`${line.id}-${line.rank}`} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{line.customer}</span>
                    <span className="block truncate text-xs text-ink3">
                      Order {line.orderNo} · {line.shipVia || 'no ship via'}
                      {line.qty < 0 ? ' · credit' : ''}
                    </span>
                  </span>
                  <span className={cx('num shrink-0 text-sm', line.qty < 0 ? 'text-curing' : 'text-ink')}>
                    {formatNumber(line.qty, 2)}
                    <span className="text-ink3"> {unitLabel(row.unit)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {day != null && lines.length > 0 ? (
            <p className="text-xs text-ink3">
              The day's figure is these lines added together. Credits are included, which is why a day
              can read negative.
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

/** The row popup: every day inside the horizon that carries a promise. */
function HorizonList({ row }: { row: MatrixRow }): ReactElement {
  const entries = [...row.cells.entries()]
    .map(([day, cell]) => ({ day, net: round(cell.gross + cell.credits, 4), lines: cell.lines, late: cell.late }))
    .filter((e) => e.net !== 0)
    .sort((a, b) => a.day - b.day);

  if (entries.length === 0) {
    return (
      <p className="rounded border border-line bg-surface2 p-3 text-sm text-ink3">
        Nothing inside this view. There may still be demand beyond it — {formatNumber(row.beyond, 2)}{' '}
        {unitLabel(row.unit)} across {row.beyondLines} lines is.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line overflow-hidden rounded border border-line">
      {entries.map((e) => (
        <li key={e.day} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <span className="text-sm text-ink2">
            {new Date(e.day).toDateString()} <span className="text-xs text-ink3">· {dueIn(e.day)}</span>
          </span>
          <span className="num flex items-center gap-2 text-sm">
            {e.late ? (
              <span className="font-700 text-warn" title={LATE_TEXT}>
                !
              </span>
            ) : null}
            {formatNumber(e.net, 2)}
            <span className="text-xs text-ink3">
              {e.lines} line{e.lines === 1 ? '' : 's'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Fact({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  tone?: 'short' | 'curing';
}): ReactElement {
  return (
    <div>
      <dt className="text-[0.68rem] tracking-wide text-ink3 uppercase">{label}</dt>
      <dd
        className={cx(
          'num text-sm',
          tone === 'short' ? 'text-short' : tone === 'curing' ? 'text-curing' : 'text-ink',
        )}
      >
        {value}
        <span className="text-xs text-ink3"> {unitLabel(unit)}</span>
      </dd>
    </div>
  );
}

