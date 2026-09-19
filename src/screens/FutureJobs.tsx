import { useMemo, useState } from 'react';
import { useIsCoarsePointer } from '@/app/useMediaQuery';
import { useLiveQuery } from 'dexie-react-hooks';
import { navigate } from '@/app/router';
import { useView } from '@/app/useView';
import { dayStart, formatDayFull, formatSince } from '@/core/dates';
import { defaultView } from '@/core/defaults';
import { formatNumber, formatQty, unitLabel } from '@/core/format';
import type { ProductUnit } from '@/core/types';
import {
  buildJobLines,
  coverBreakdown,
  defaultJobFilter,
  filterJobLines,
  JOB_WINDOWS,
  summariseJobs,
  windowCounts,
  type JobFilter,
  type JobLineView,
} from '@/core/jobsBoard';
import { jobBoardSource, productForCode } from '@/data/jobRepo';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Button, Card, Chip, EmptyState, TextInput, cx } from '@/ui/primitives';

/**
 * The order book: what has been sold that we still owe.
 *
 * MYOB hands over a list of open sales-order lines. On its own that list is
 * useless to a shop floor — it says a customer is owed 8 m² and nothing about the
 * 10 m² standing in the yard, so the owner does the sum in his head while somebody
 * is waiting on the phone. This screen does the sum: every open line, and against
 * it what the shop can already point at (stock, what is on the racks, what has been
 * keyed into MYOB and not yet come back out of an export), and therefore what is
 * still genuinely owed. The rules and the one real judgement in it — who the pallet
 * belongs to when two customers want the same code — live in `core/jobsBoard`.
 *
 * It reads and never writes. Nothing here changes an order: the export is the
 * record, and the shop's own figures come from the other screens.
 *
 * **This is one of the two screens the current-range rule does not cut.** The tick on
 * Products says what the shop plans to make; this screen is about what the shop has
 * already sold, and the two lists are far apart — 414 open lines against 134 ticked
 * codes, so filtering this table by the tick would remove most of the shop's
 * obligations from the only screen built to show them. Money owed to a customer does
 * not stop being owed because a code was unticked. So every line stays, and the ones
 * outside the range are marked in the way an unknown code already was: the same column,
 * the same tone, the same "still all of it stands as owed", plus a count under the
 * table so nobody reads a covered line as a promise the shop has forgotten.
 */

/**
 * Which side of the tick a line's code sits on, and what the row says about it.
 *
 * `not current` and `not ours` are different facts — one has cover figures the shop
 * can trust, the other has none — but they get the same treatment on the board, which
 * is why they are one column and one tone rather than two new concepts beside the
 * "not one of ours" rule the screen already had.
 */
type CodeRange = 'current' | 'notCurrent' | 'unknown';

const RANGE_LABEL: Record<CodeRange, string> = {
  current: 'ours',
  notCurrent: 'not current',
  unknown: 'not ours',
};

const RANGE_HINT: Record<CodeRange, string> = {
  current: 'In the current range: ticked on Products, so the shop plans to make it.',
  notCurrent:
    'On this device but not ticked on Products, so it is not something the shop plans to make. The order is still owed, and the cover figures still count — the tick is about tomorrow, not about what has already been sold.',
  unknown:
    'This device has never seen the code, so there is nothing to compare the order against and all of it stands as owed. A bought-in item, or a code the export has and Products does not.',
};

function rangeOf(line: JobLineView): CodeRange {
  if (line.current) return 'current';
  return line.ours ? 'notCurrent' : 'unknown';
}

const COLUMNS: ColumnDef<JobLineView>[] = [
  {
    key: 'promisedDate',
    header: 'Promised',
    value: (r) => r.promisedDate,
    format: 'date',
    sticky: true,
    width: 108,
    totals: 'none',
    tone: (r) => (r.pastDue ? 'short' : null),
    headerHint: 'The date on the sales order. Lines the export has never dated are left out unless you ask for them.',
  },
  {
    key: 'daysToGo',
    header: 'Days to go',
    value: (r) => r.daysToGo,
    format: 'number',
    decimals: 0,
    width: 92,
    totals: 'none',
    tone: (r) => (r.daysToGo < 0 ? 'short' : null),
    headerHint: 'Today is 0. A minus means the promise date has passed and the line is still open.',
  },
  { key: 'customer', header: 'Customer', value: (r) => r.customer, width: 200 },
  { key: 'orderNo', header: 'Order No.', value: (r) => r.orderNo, format: 'code', width: 104 },
  { key: 'itemCode', header: 'Item No.', value: (r) => r.itemCode, format: 'code', width: 96 },
  { key: 'itemDescription', header: 'Description', value: (r) => r.itemDescription, width: 240, wrap: true },
  {
    key: 'qty',
    header: 'Sold',
    value: (r) => r.qty,
    format: 'number',
    width: 112,
    totals: 'sum',
    unit: (r) => (r.unit ? unitLabel(r.unit) : undefined),
    headerHint:
      'As exported. Negative lines are credits and returns. The total adds every line on screen whatever its unit — read it for one customer or one code, not across the whole book.',
  },
  {
    key: 'covered',
    header: 'Covered',
    value: (r) => r.covered,
    format: 'number',
    width: 104,
    totals: 'sum',
    headerHint:
      'What this line can point at on this device. Where a code is promised to more than one customer, the earliest promise is covered first — a pallet cannot answer two orders.',
  },
  {
    key: 'short',
    header: 'Still needed',
    value: (r) => r.short,
    format: 'number',
    width: 118,
    totals: 'sum',
    tone: (r) => (r.short > 0 ? 'short' : null),
    headerHint: 'Sold minus covered. Zero means the shop already has it, or is making it.',
  },
  {
    key: 'available',
    header: 'Whole shop',
    value: (r) => r.available,
    format: 'number',
    width: 112,
    totals: 'none',
    headerHint:
      'Everything this code has to point at: stock on hand from the last export, what is on the racks, and what has been keyed into MYOB but not exported yet. It belongs to the code, not to one line.',
  },
  {
    key: 'ours',
    header: 'Ours?',
    // Three words, two of them marked. Sorting is on the word, so `not current` and
    // `not ours` sort apart — a shop that wants the unticked ones in a pile can get
    // them with one press on the header.
    value: (r) => RANGE_LABEL[rangeOf(r)],
    width: 104,
    totals: 'none',
    tone: (r) => (r.current ? null : 'warn'),
    render: (r) => {
      const range = rangeOf(r);
      return <span title={RANGE_HINT[range]}>{RANGE_LABEL[range]}</span>;
    },
    headerHint:
      'Whether the code is in the current range. A code that is not one of ours has nothing to compare against, and one that is ours but is not ticked is not something we plan to make — either way the line stays on this screen, because it has been sold and is still owed.',
  },
  { key: 'shipVia', header: 'Ship via', value: (r) => r.shipVia, width: 110 },
  { key: 'salesperson', header: 'Sales', value: (r) => r.salesperson, width: 120 },
];

export function FutureJobs() {
  const touch = useIsCoarsePointer();

  const [filter, setFilter] = useState<JobFilter>(defaultJobFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const source = useLiveQuery(() => jobBoardSource(), []);
  const view = useView(
    'jobs.board',
    useMemo(() => defaultView('jobs.board', COLUMNS.map((c) => c.key)), []),
  );

  const lines = useMemo<JobLineView[] | null>(() => {
    if (!source) return null;
    return buildJobLines({
      jobs: source.jobs,
      products: source.products,
      stockRows: source.stockRows,
      batches: source.batches,
      stockCapturedAt: source.stockCapturedAt,
      settings: source.settings,
    });
  }, [source]);

  const totals = useMemo(() => (lines ? summariseJobs(lines) : null), [lines]);
  const counts = useMemo(() => (lines ? windowCounts(lines) : null), [lines]);
  const shown = useMemo(() => (lines ? filterJobLines(lines, filter) : []), [lines, filter]);

  const selected = useMemo(() => shown.find((l) => l.id === selectedId) ?? null, [shown, selectedId]);

  const filtering =
    filter.window !== 'all' ||
    filter.query.trim() !== '' ||
    filter.shortOnly ||
    filter.showFarFuture ||
    filter.showExcluded;

  const patch = (over: Partial<JobFilter>) => setFilter((f) => ({ ...f, ...over }));
  const clear = () => setFilter(defaultJobFilter());

  const head = () => {
    if (!source || !totals) return 'Reading the order book.';
    if (source.jobs.length === 0) return 'Nothing has been sold on this device yet.';
    const parts = [
      `${formatNumber(totals.open, 0)} open ${totals.open === 1 ? 'line' : 'lines'}`,
      `${formatNumber(totals.codes, 0)} ${totals.codes === 1 ? 'code' : 'codes'}`,
      `${formatNumber(totals.customers, 0)} ${totals.customers === 1 ? 'customer' : 'customers'}`,
    ];
    if (source.capturedAt !== null) parts.push(`export read ${formatSince(source.capturedAt)}`);
    return parts.join(' · ');
  };

  // A line's cover, broken into the things a person can go and look at.
  const detail = useMemo(() => {
    if (!selected || !source) return null;
    const product = productForCode(source.products, selected.itemCode);
    return {
      product,
      breakdown: coverBreakdown(
        product,
        source.stockRows,
        source.batches,
        source.stockCapturedAt,
        source.settings,
      ),
    };
  }, [selected, source]);

  if (!source || !lines || !totals || !counts) {
    return (
      <Card title="The order book">
        <p className="text-sm text-ink2">Reading the order book.</p>
      </Card>
    );
  }

  if (source.jobs.length === 0) {
    return (
      <Card title="The order book" subtitle="Every open sales-order line from the MYOB export, and what the shop can already point at for it.">
        <EmptyState
          icon="jobs"
          title="No future jobs on this device"
          body="The Sales [Item Detail] export from MYOB has not been read here. Drop it on Data sources, or let the automatic import pick it up when it lands in the data repository. Nothing on this screen can be worked out without it."
          action={
            <Button size={touch ? 'touch' : 'sm'} variant="primary" onClick={() => navigate('/sources')}>
              Data sources
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Card
        className="flex min-h-0 flex-1 flex-col lg:min-h-0 lg:flex-none lg:shrink-0"
        bodyClassName="flex min-h-0 flex-1 flex-col lg:min-h-0 lg:flex-none"
        title="The order book"
        subtitle={head()}
        actions={
          <>
            {totals.shortLines > 0 ? (
              <Chip tone="warn" title="Open lines the shop cannot cover from stock and what is being made.">
                {formatNumber(totals.shortLines, 0)} still owed
              </Chip>
            ) : (
              <Chip tone="info" title="Every open line with a promise date has something behind it.">
                everything covered
              </Chip>
            )}
            {totals.outsideRange > 0 ? (
              <Chip
                tone="info"
                data-jobs-offrange-chip
                title={`${formatNumber(totals.notCurrent, 0)} of these lines are codes this device knows with the tick off on Products, and ${formatNumber(
                  totals.unknownCodes,
                  0,
                )} are codes it has never seen. They are shown because this screen is about what has been sold, not about what we plan to make.`}
              >
                {formatNumber(totals.outsideRange, 0)} outside the range
              </Chip>
            ) : null}
            {totals.pastDue > 0 ? (
              <Chip tone="short" title="Promised already and still open. The Matrix starts at today, so these are only ever seen here.">
                {formatNumber(totals.pastDue, 0)} {totals.pastDue === 1 ? 'line' : 'lines'} late
              </Chip>
            ) : null}
            <Button size={touch ? 'touch' : 'sm'} icon="sources" onClick={() => navigate('/sources')} title="Where this file comes from, and when it was last read.">
              Data sources
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="sr-only">Search the order book</span>
            <TextInput
              data-jobs-search
              value={filter.query}
              onChange={(e) => patch({ query: e.target.value })}
              placeholder="A customer, an order number, an item code"
              className="w-full"
            />
          </label>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="How near">
            {JOB_WINDOWS.map((window) => (
              <Button
                key={window.key}
                data-jobs-window={window.key}
                size={touch ? 'touch' : 'sm'}
                active={filter.window === window.key}
                aria-pressed={filter.window === window.key}
                title={window.hint}
                onClick={() => patch({ window: window.key })}
              >
                {window.label}
                <span className="text-ink3 tabular-nums">{counts[window.key]}</span>
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="What to leave out">
            <Button
              data-jobs-short-only
              size={touch ? 'touch' : 'sm'}
              active={filter.shortOnly}
              aria-pressed={filter.shortOnly}
              title="Only the lines that still need something after the shop’s own stock and work in progress."
              onClick={() => patch({ shortOnly: !filter.shortOnly })}
            >
              Still needed
              <span className="text-ink3 tabular-nums">{formatNumber(totals.shortLines, 0)}</span>
            </Button>
            <Button
              data-jobs-far-future
              size={touch ? 'touch' : 'sm'}
              active={filter.showFarFuture}
              aria-pressed={filter.showFarFuture}
              title="Lines the export has never given a real promise date — a placeholder year, or more than a year out. They are left out of the near-term views because a date the shop does not believe is not a promise."
              onClick={() => patch({ showFarFuture: !filter.showFarFuture })}
            >
              No promise date
              <span className="text-ink3 tabular-nums">{formatNumber(totals.farFuture, 0)}</span>
            </Button>
            {totals.excluded > 0 ? (
              <Button
                data-jobs-excluded
                size={touch ? 'touch' : 'sm'}
                active={filter.showExcluded}
                aria-pressed={filter.showExcluded}
                title="Lines on a ship-via the shop leaves out of demand everywhere else. Off by default, so this screen agrees with the Matrix and Products."
                onClick={() => patch({ showExcluded: !filter.showExcluded })}
              >
                Left-out ship-via
                <span className="text-ink3 tabular-nums">{formatNumber(totals.excluded, 0)}</span>
              </Button>
            ) : null}
            {filtering ? (
              <Button data-jobs-clear size={touch ? 'touch' : 'sm'} icon="undo" onClick={clear}>
                Clear
              </Button>
            ) : null}
          </div>

          {filter.showFarFuture ? (
            <p className="text-xs text-ink2">
              Undated lines are shown. They sort after every dated promise, so they cannot take stock a customer is
              actually waiting for — but a line with no believable date is not something the shop can plan a week around.
            </p>
          ) : null}

          {totals.outsideRange > 0 ? (
            // Said in the open, above the table: the marked rows are not a bug in the
            // range, and the figure next to them is not missing money.
            <p data-jobs-offrange className="text-xs text-ink3">
              {formatNumber(totals.outsideRange, 0)} of these {formatNumber(totals.lines, 0)} lines are codes
              outside the current range — {formatNumber(totals.notCurrent, 0)} ticked off on Products and{' '}
              {formatNumber(totals.unknownCodes, 0)} the export has that this device does not. They are all
              shown, and all still counted as owed: the tick decides what the shop plans to make, not what it
              has already sold.
            </p>
          ) : null}

          {filtering ? (
            <p data-jobs-filtered className="text-xs text-ink2">
              {formatNumber(shown.length, 0)} of {formatNumber(lines.length, 0)} lines
              {totals.farFuture > 0 && !filter.showFarFuture
                ? ` · ${formatNumber(totals.farFuture, 0)} with no promise date are not shown`
                : ''}
              .
            </p>
          ) : null}
        </div>
      </Card>

      <div className="flex min-h-[240px] flex-1 flex-col">
        <DataTable
          rows={shown}
          columns={COLUMNS}
          view={view.view}
          onViewChange={view.patch}
          getRowId={(r) => r.id}
          rankOf={(r) => r.rank}
          loading={false}
          selectedId={selectedId}
          onRowClick={(r) => setSelectedId((current) => (current === r.id ? null : r.id))}
          empty={
            <EmptyState
              icon="jobs"
              title="No line matches"
              body={
                filter.query.trim() !== ''
                  ? `Nothing on this device matches “${filter.query.trim()}”. The order book only holds what the last export contained.`
                  : 'The filter has taken everything out. Clear it to see the whole book again.'
              }
              action={
                filtering ? (
                  <Button size={touch ? 'touch' : 'sm'} onClick={clear}>
                    Clear the filters
                  </Button>
                ) : null
              }
            />
          }
        />
      </div>

      <p className="text-xs text-ink3">
        Both sides are in the item’s own unit — the export sells in the unit the stock is counted in, so{' '}
        <span className="font-600">Covered</span> is directly comparable with{' '}
        <span className="font-600">Sold</span>.{' '}
        {source.stockCapturedAt !== null
          ? `Cover comes from the last stock export (read ${formatSince(source.stockCapturedAt)}) and the racks on this device.`
          : 'No stock export has been read on this device, so the only cover that counts is what is on the racks.'}{' '}
        Where a code is promised to more than one customer the earliest promise is covered first, which is a rule of
        this screen and not something MYOB says.
      </p>

      {selected && detail ? (
        <Card
          // The order number leads because a card heading is truncated on a phone. The
          // customer is written out in full in the first line of the body instead, so
          // nothing a person needs only exists in a heading that gets cut off.
          title={`${selected.orderNo} · ${selected.customer}`}
          subtitle={`${selected.itemCode} — ${selected.itemDescription}`}
          actions={
            <Button size={touch ? 'touch' : 'sm'} icon="close" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          }
        >
          <div className="flex flex-col gap-3" data-jobs-detail>
            <p className="text-sm text-ink2" data-jobs-detail-when>
              <span className="font-600">{selected.customer}</span> was promised{' '}
              <span className="font-600">{formatDayFull(dayStart(selected.promisedDate))}</span>
              {selected.farFuture
                ? ' — a date the shop does not believe, so it is not counted as late.'
                : selected.pastDue
                  ? ` — ${Math.abs(selected.daysToGo)} ${Math.abs(selected.daysToGo) === 1 ? 'day' : 'days'} late.`
                  : ` — ${selected.daysToGo === 0 ? 'today' : `in ${selected.daysToGo} ${selected.daysToGo === 1 ? 'day' : 'days'}`}.`}
              {selected.excluded ? ' This line is on a ship-via the shop leaves out of demand.' : ''}
            </p>

            {detail.product === null ? (
              <p className="text-sm text-ink2" data-jobs-detail-unknown>
                <span className="font-600">{selected.itemCode}</span> is not a product on this device, so there is
                nothing to compare the order against. All {formatQty(selected.qty, selected.unit ?? 'each')} stands as
                owed. It may be a bought-in item, or a code the export has and this device has never seen.
              </p>
            ) : (
              <>
                {/* A code the shop has unticked gets the same plain statement the
                    unknown code gets: the figures below are real, and the order is
                    still owed, whatever the tick says about next month. */}
                {selected.current ? null : (
                  <p className="text-sm text-ink2" data-jobs-detail-offrange>
                    <span className="font-600">{selected.itemCode}</span> is not in the current range — it is on
                    this device with the tick off on Products, so the shop is not planning to make it. The order
                    is still owed, and the figures below still count, because the tick says what we make from now
                    on and not what was already sold.
                  </p>
                )}
                <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  <Figure label="Stock on hand" value={detail.breakdown.stock} unit={detail.product.unit} />
                  <Figure
                    label="On the racks"
                    value={detail.breakdown.curing + detail.breakdown.awaitingBlast + detail.breakdown.blasting}
                    unit={detail.product.unit}
                  />
                  <Figure
                    label="Ready to go"
                    value={detail.breakdown.ready}
                    unit={detail.product.unit}
                    hint={detail.breakdown.countedReady ? 'counted as available' : 'not counted until it is exported'}
                  />
                  <Figure
                    label="Keyed into MYOB"
                    value={detail.breakdown.keyedNotExported}
                    unit={detail.product.unit}
                    hint="entered since the last export"
                  />
                  <Figure label="Whole shop" value={detail.breakdown.available} unit={detail.product.unit} />
                  <Figure
                    label="This line takes"
                    value={selected.covered}
                    unit={detail.product.unit}
                    hint={selected.short > 0 ? `still needs ${formatNumber(selected.short, 2)}` : 'covered'}
                  />
                </ul>
              </>
            )}

            <p className="text-xs text-ink3">
              Sold {formatNumber(selected.qty, 2)}
              {selected.unit ? ` ${unitLabel(selected.unit)}` : ''} on order{' '}
              {selected.orderNo}, exported from{' '}
              <span className="font-600">{source.source === '' ? 'the MYOB export' : source.source}</span>
              {source.capturedAt !== null ? ` read ${formatSince(source.capturedAt)}` : ''}. Nothing here changes an
              order — the export is the record.
            </p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Figure({ label, value, unit, hint }: { label: string; value: number; unit: ProductUnit; hint?: string }) {
  return (
    <li className={cx('flex flex-col')}>
      <span className="text-eyebrow font-700 uppercase tracking-wide text-ink3">{label}</span>
      <span className="text-base font-600 tabular-nums">{formatQty(value, unit)}</span>
      {hint ? <span className="text-xs text-ink3">{hint}</span> : null}
    </li>
  );
}
