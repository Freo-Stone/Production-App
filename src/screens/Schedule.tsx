import { useMemo, useState } from 'react';
import { useIsCoarsePointer } from '@/app/useMediaQuery';
import { useLiveQuery } from 'dexie-react-hooks';
import { navigate } from '@/app/router';
import { useCan } from '@/app/session';
import { useView } from '@/app/useView';
import { buildJobLines } from '@/core/jobsBoard';
import { formatDayFull, formatSince } from '@/core/dates';
import { defaultView } from '@/core/defaults';
import { formatNumber, formatQty, unitLabel } from '@/core/format';
import {
  buildSchedule,
  bucketCounts,
  defaultScheduleFilter,
  filterSchedule,
  isFiltering,
  PLAN_BUCKETS,
  summariseSchedule,
  type ScheduleFilter,
  type ScheduleLine,
} from '@/core/schedule';
import { productForCode } from '@/data/jobRepo';
import { addPlanItem, cancelPlanItem, scheduleSource, startPlanItem } from '@/data/planRepo';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Button, Card, Chip, EmptyState, Field, Modal, TextInput, toast } from '@/ui/primitives';

/**
 * The plan: what has to be made, and the latest day it can start.
 *
 * The order book says what the shop owes. This says what that means on the floor —
 * the shortfalls, turned into makes, dated backwards from the promise through the
 * cure and the blaster. Rows come from `core/schedule`, which works off the same
 * shortfall figures the order book shows, so the two screens cannot disagree about
 * what is owed and this one never has to be updated by hand.
 *
 * Two kinds of row, and the screen says which is which on every row. A **promise
 * with nothing behind it** is the book asking for something nobody has written down
 * yet — one press puts it on the plan. A **plan line** is the shop's own record, and
 * it says which order lines it answers, or says plainly that nothing is waiting on
 * it.
 *
 * Nothing here makes anything. Putting a line on the plan is a decision written down;
 * the racks themselves are logged on Daily entry, and the order book starts counting
 * them the moment they exist.
 */

const COLUMNS: ColumnDef<ScheduleLine>[] = [
  {
    key: 'latestStart',
    header: 'Start by',
    value: (r) => r.latestStart,
    format: 'date',
    sticky: true,
    width: 108,
    totals: 'none',
    tone: (r) => (r.bucket === 'behind' ? 'short' : null),
    headerHint:
      'The latest day this make can start and still reach its promise: the promise less the cure days, less a blasting day when the route goes through the blaster, less the planning buffer in Settings. Same arithmetic the Matrix uses.',
  },
  {
    key: 'daysToStart',
    header: 'Days to start',
    value: (r) => r.daysToStart,
    format: 'number',
    decimals: 0,
    width: 122,
    totals: 'none',
    tone: (r) => (r.daysToStart === null ? null : r.daysToStart < 0 ? 'short' : r.daysToStart === 0 ? 'warn' : null),
    headerHint: 'Today is 0. A minus means the day it had to start has already gone.',
  },
  { key: 'code', header: 'Item No.', value: (r) => r.code, format: 'code', width: 96 },
  { key: 'description', header: 'Description', value: (r) => r.description, width: 220, wrap: true },
  {
    key: 'qty',
    header: 'To make',
    value: (r) => r.qty,
    format: 'qty',
    width: 116,
    totals: 'sum',
    unit: (r) => (r.unit ? unitLabel(r.unit) : undefined),
    headerHint:
      'What this row has to make, in the item’s own unit. The total adds every row on screen whatever the unit — read it for one code, not for the whole plan.',
  },
  { key: 'promisedFor', header: 'Promised', value: (r) => r.promisedFor, format: 'date', width: 108, totals: 'none' },
  {
    key: 'customers',
    header: 'For',
    value: (r) =>
      r.customers.length === 0
        ? ''
        : r.customers.length <= 2
          ? r.customers.join(', ')
          : `${r.customers.slice(0, 2).join(', ')} +${formatNumber(r.customers.length - 2, 0)}`,
    width: 190,
    totals: 'none',
    wrap: true,
    headerHint: 'Who is waiting on this row. A row can answer several orders promised for the same day.',
  },
  {
    key: 'status',
    header: 'On the plan',
    value: (r) => (r.origin === 'gap' ? 'not yet' : r.status === 'started' ? 'being made' : 'planned'),
    width: 118,
    totals: 'none',
    tone: (r) => (r.origin === 'gap' ? 'warn' : r.status === 'started' ? 'curing' : 'info'),
    headerHint: 'Whether anybody has written this make down yet.',
  },
  {
    key: 'route',
    header: 'Route',
    value: (r) => (r.route === null ? '' : r.route === 'shotblast' ? 'shotblast' : 'make'),
    width: 92,
    totals: 'none',
    headerHint: 'From the product. It decides whether a blasting day comes off the promise date.',
  },
  {
    key: 'note',
    header: 'Why',
    value: (r) => r.note,
    width: 280,
    totals: 'none',
    wrap: true,
    headerHint: 'What the row is answering, in words — including when a plan line makes more than the promises ask for.',
  },
];

const ROUTE_WORDS: Record<string, string> = {
  manufacture: 'It is made on the line.',
  shotblast: 'It goes through the blaster.',
};

export function Schedule() {
  const canRecord = useCan('production.record');
  const touch = useIsCoarsePointer();

  const [filter, setFilter] = useState<ScheduleFilter>(defaultScheduleFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<ScheduleLine | null>(null);
  const [reason, setReason] = useState('');

  const source = useLiveQuery(() => scheduleSource(), []);
  const view = useView(
    'schedule.board',
    useMemo(() => defaultView('schedule.board', COLUMNS.map((c) => c.key)), []),
  );

  const rows = useMemo<ScheduleLine[] | null>(() => {
    if (!source) return null;
    return buildSchedule({
      // The plan is built on the order book's own shortfalls, so the two screens
      // cannot end up with different ideas of what is owed.
      lines: buildJobLines({
        jobs: source.jobs,
        products: source.products,
        stockRows: source.stockRows,
        batches: source.batches,
        stockCapturedAt: source.stockCapturedAt,
        settings: source.settings,
      }),
      planItems: source.planItems,
      products: source.products,
      settings: source.settings,
    });
  }, [source]);

  // The plan is only ever about the current range, and this is the single place that
  // fact is applied. `core/schedule` tags each row with `current` — the answer of
  // `isCurrentProduct`, the one predicate — and here the rows are cut and every
  // figure after it is reduced over the cut list: the chips (`counts`), the header
  // and chip figures (`totals`), and the table itself (`shown`) all read the same
  // rows. Reducing the totals over the unfiltered list is how a plan gets a footer
  // that adds up work its own table refuses to show.
  //
  // What the rule takes out is counted and said out loud below the toolbar, because a
  // plan that quietly gets shorter is indistinguishable from a shop that got busy.
  const planned = useMemo(() => (rows ? rows.filter((r) => r.current) : null), [rows]);
  const offRange = rows && planned ? rows.length - planned.length : 0;

  const totals = useMemo(() => (planned ? summariseSchedule(planned) : null), [planned]);
  const counts = useMemo(() => (planned ? bucketCounts(planned) : null), [planned]);
  const shown = useMemo(() => (planned ? filterSchedule(planned, filter) : []), [planned, filter]);

  const selected = useMemo(
    () => (selectedId === null ? null : (shown.find((r) => r.id === selectedId) ?? null)),
    [shown, selectedId],
  );

  /** The order lines behind the selected row, as the export said them. */
  const detail = useMemo(() => {
    if (!selected || !source) return null;
    const product = productForCode(source.products, selected.code);
    const jobs = selected.jobIds
      .map((id) => source.jobs.find((j) => j.id === id) ?? null)
      .filter((j): j is NonNullable<typeof j> => j !== null);
    return { product, jobs };
  }, [selected, source]);

  if (!source || !rows || !totals || !counts) {
    return (
      <Card title="The making plan">
        <p className="text-sm text-ink2">Working out what has to be made.</p>
      </Card>
    );
  }

  const filtering = isFiltering(filter);
  const patch = (over: Partial<ScheduleFilter>) => setFilter((f) => ({ ...f, ...over }));
  const clear = () => setFilter(defaultScheduleFilter());

  const head = () => {
    if (source.jobs.length === 0) return 'Nothing has been sold on this device yet.';
    const parts = [
      `${formatNumber(totals.rows, 0)} ${totals.rows === 1 ? 'row' : 'rows'}`,
      `${formatNumber(totals.codes, 0)} ${totals.codes === 1 ? 'code' : 'codes'}`,
      totals.unplanned > 0
        ? `${formatNumber(totals.unplanned, 0)} ${totals.unplanned === 1 ? 'promise' : 'promises'} not planned`
        : 'nothing left unplanned',
    ];
    if (source.jobsCapturedAt !== null) parts.push(`order book read ${formatSince(source.jobsCapturedAt)}`);
    return parts.join(' · ');
  };

  async function addToPlan(row: ScheduleLine): Promise<void> {
    setBusy(true);
    try {
      const item = await addPlanItem({
        code: row.code,
        qty: row.qty,
        promisedFor: row.promisedFor,
        linkedJobIds: row.jobIds,
      });
      setSelectedId(null);
      toast(
        'info',
        `${row.code} is on the plan`,
        `${formatQty(row.qty, productForCode(source?.products ?? [], row.code)?.unit ?? 'each')} — ${
          item.latestStartDate === null ? 'no start date yet' : `start by ${formatDayFull(item.latestStartDate)}`
        }.`,
      );
    } catch (error) {
      toast('short', 'Cannot put that on the plan', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function markStarted(row: ScheduleLine): Promise<void> {
    if (row.plan === null) return;
    setBusy(true);
    try {
      await startPlanItem(row.plan.id);
      toast('info', `${row.code} marked started`, 'The racks themselves go in on Daily entry.');
    } catch (error) {
      toast('short', 'Cannot start that plan line', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCancel(): Promise<void> {
    const row = cancelling;
    if (row?.plan == null) return;
    setBusy(true);
    try {
      await cancelPlanItem(row.plan.id, reason);
      setCancelling(null);
      setReason('');
      setSelectedId(null);
      toast('info', `${row.code} taken off the plan`, 'The line stays in the record with the reason.');
    } catch (error) {
      toast('short', 'Cannot take it off the plan', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (source.jobs.length === 0) {
    return (
      <Card
        title="The making plan"
        subtitle="What the order book says is still owed, turned into makes and dated back from the promise."
      >
        <EmptyState
          icon="jobs"
          title="No promises to plan against"
          body="The Sales [Item Detail] export from MYOB has not been read on this device, so nothing can be worked out from it. Put it on Data sources, or let the automatic import pick it up when it lands in the data repository. Plan lines the shop writes itself still show up once they exist."
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
        title="The making plan"
        subtitle={head()}
        actions={
          <>
            {totals.behind > 0 ? (
              <Chip tone="short" title="Makes whose latest start day has gone. They will not reach their promise date unless something gives.">
                {formatNumber(totals.behind, 0)} {totals.behind === 1 ? 'is' : 'are'} already behind
              </Chip>
            ) : (
              <Chip tone="info" title="Every make on the plan still has its start day ahead of it.">
                nothing behind yet
              </Chip>
            )}
            {totals.unplanned > 0 ? (
              <Chip tone="warn" title="Promises the order book says are short, with no plan line behind them yet.">
                {formatNumber(totals.unplanned, 0)} {totals.unplanned === 1 ? 'has' : 'have'} nothing planned
              </Chip>
            ) : null}
            <Button
              size={touch ? 'touch' : 'sm'}
              icon="jobs"
              onClick={() => navigate('/jobs')}
              title="What the shop owes, line by line, and what it can already point at."
            >
              Order book
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="sr-only">Search the plan</span>
            <TextInput
              data-schedule-search
              value={filter.query}
              onChange={(e) => patch({ query: e.target.value })}
              placeholder="An item code, a customer, an order number"
              className="w-full"
            />
          </label>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="When it has to start">
            {PLAN_BUCKETS.map((bucket) => (
              <Button
                key={bucket.key}
                data-schedule-bucket={bucket.key}
                size={touch ? 'touch' : 'sm'}
                active={filter.bucket === bucket.key}
                aria-pressed={filter.bucket === bucket.key}
                title={bucket.hint}
                onClick={() => patch({ bucket: bucket.key })}
              >
                {bucket.label}
                <span className="text-ink3 tabular-nums">{counts[bucket.key]}</span>
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="What to leave out">
            <Button
              data-schedule-unplanned
              size={touch ? 'touch' : 'sm'}
              active={filter.unplannedOnly}
              aria-pressed={filter.unplannedOnly}
              title="Only the promises nobody has put a make against yet. This is the list that turns into tomorrow's work."
              onClick={() => patch({ unplannedOnly: !filter.unplannedOnly })}
            >
              Nobody has planned it
              <span className="text-ink3 tabular-nums">{formatNumber(totals.unplanned, 0)}</span>
            </Button>
            {totals.making > 0 ? (
              <Button
                data-schedule-making
                size={touch ? 'touch' : 'sm'}
                active={filter.bucket === 'making'}
                aria-pressed={filter.bucket === 'making'}
                title="Plan lines somebody has already started. Their racks show as work in progress on the order book."
                onClick={() => patch({ bucket: filter.bucket === 'making' ? 'all' : 'making' })}
              >
                On the floor
                <span className="text-ink3 tabular-nums">{formatNumber(totals.making, 0)}</span>
              </Button>
            ) : null}
            {filtering ? (
              <Button data-schedule-clear size={touch ? 'touch' : 'sm'} icon="undo" onClick={clear}>
                Clear
              </Button>
            ) : null}
          </div>

          {offRange > 0 ? (
            // The plan is a statement about what the shop makes. The promises this
            // rule left out are still money the shop owes, so they are named, counted
            // and pointed at the screen that holds them rather than disappearing.
            <p data-schedule-offrange className="text-xs text-ink3">
              {formatNumber(offRange, 0)} {offRange === 1 ? 'row' : 'rows'} for codes that are not in the
              current range are not planned here. They are on the order book, still owed — the tick says
              what we make, not what we have sold.
            </p>
          ) : null}

          {filtering ? (
            <p data-schedule-filtered className="text-xs text-ink2">
              {formatNumber(shown.length, 0)} of {formatNumber(planned?.length ?? 0, 0)} rows
              {totals.undated > 0 && filter.bucket === 'all' && !filter.unplannedOnly
                ? ` · ${formatNumber(totals.undated, 0)} with no start date sort after every dated row`
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
              title={
                planned && planned.length === 0 && offRange > 0
                  ? 'Nothing in the current range has to be made'
                  : (planned?.length ?? 0) === 0
                    ? 'Nothing has to be made'
                    : 'No row matches'
              }
              body={
                planned && planned.length === 0 && offRange > 0
                  ? `The order book has ${formatNumber(offRange, 0)} ${offRange === 1 ? 'row' : 'rows'} short, but every one of them is a code that is not ticked on Products. Ticking a code says the shop makes it — until then nothing is planned for it, and the promises stay on the order book.`
                  : (planned?.length ?? 0) === 0
                    ? 'Every promise the export has for the current range is covered by stock or by work already on the racks, and the shop has not put anything on the plan itself. The moment something goes short it appears here.'
                    : filter.query.trim() !== ''
                      ? `Nothing on the plan matches “${filter.query.trim()}”. The plan only holds what the order book says is short, and what the shop has written down.`
                      : 'The filter has taken everything out. Clear it to see the whole plan again.'
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
        Start dates are worked out from the cure days and route on Products, plus the blasting handling days and the
        planning buffer in Settings — the same arithmetic the Matrix tones use, so a row that says
        <span className="font-600"> already behind</span> is late on both screens. A plan line is something the shop
        commits to: it does not log a rack. Racks go in on Daily entry, and the order book starts counting them as
        cover the moment they are logged.
      </p>

      {selected && detail ? (
        <Card
          // The code and the day lead, because a card heading is truncated on a phone
          // and both are short. Who is waiting is written out in the body instead.
          title={`${selected.code} · ${selected.origin === 'gap' ? 'nothing planned yet' : selected.status === 'started' ? 'being made' : 'on the plan'}`}
          subtitle={
            selected.description === ''
              ? `${selected.code} is not a product on this device`
              : `${selected.code} — ${selected.description}`
          }
          actions={
            <Button size={touch ? 'touch' : 'sm'} icon="close" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          }
        >
          <div className="flex flex-col gap-3" data-schedule-detail>
            <p className="text-sm text-ink2" data-schedule-detail-when>
              {selected.latestStart === null ? (
                <>
                  There is <span className="font-600">no start date</span> for{' '}
                  <span className="font-600">{selected.code}</span> to work from
                  {selected.ours
                    ? '.'
                    : ', because the code is not one of our products on this device and the cure time is unknown.'}
                </>
              ) : (
                <>
                  <span className="font-600">{selected.code}</span> has to have started by{' '}
                  <span className="font-600">{formatDayFull(selected.latestStart)}</span>
                  {selected.promisedFor === null
                    ? ', which is the date the shop wrote on the line.'
                    : ` to be ready for ${formatDayFull(selected.promisedFor)}.`}{' '}
                  {selected.daysToStart !== null && selected.daysToStart < 0
                    ? `That day went by ${Math.abs(selected.daysToStart)} ${
                        Math.abs(selected.daysToStart) === 1 ? 'day' : 'days'
                      } ago.`
                    : selected.daysToStart === 0
                      ? 'That is today.'
                      : `That is ${selected.daysToStart} ${
                          selected.daysToStart === 1 ? 'day' : 'days'
                        } from today.`}
                </>
              )}
            </p>

            {detail.product !== null ? (
              <p className="text-xs text-ink3" data-schedule-detail-lead>
                Lead time {leadDays(detail.product.cureDays, selected.route, source.settings.planning.blastHandlingDays, source.settings.planning.bufferDays)}{' '}
                — {detail.product.cureDays} {detail.product.cureDays === 1 ? 'day of cure' : 'days of cure'},{' '}
                {selected.route === 'shotblast'
                  ? `${source.settings.planning.blastHandlingDays} ${
                      source.settings.planning.blastHandlingDays === 1 ? 'day' : 'days'
                    } off the blaster`
                  : selected.route === null
                    ? 'no blasting day counted'
                    : 'no blasting day'}
                {source.settings.planning.bufferDays > 0
                  ? `, and ${source.settings.planning.bufferDays} ${
                      source.settings.planning.bufferDays === 1 ? 'day' : 'days'
                    } of buffer`
                  : ', and no buffer'}
                . {ROUTE_WORDS[selected.route ?? ''] ?? 'No route is set on Products, so the plan does not know whether to leave a blasting day out.'}
              </p>
            ) : null}

            {/* A tray yield of 1 is what an imported item arrives with, not a fact
                    about the shop's trays — so the equivalent is only said when the
                    yield is one the shop actually set. */}
            {selected.trays !== null && detail.product !== null && detail.product.trayYield !== 1 ? (
              <p className="text-sm text-ink2" data-schedule-detail-trays>
                At {formatNumber(detail.product.trayYield, 2)} {unitLabel(detail.product.unit)} a tray that is about{' '}
                <span className="font-600">{formatNumber(selected.trays, 0)} trays</span> on the floor.
              </p>
            ) : null}

            {detail.jobs.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm" data-schedule-detail-lines>
                {detail.jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-600">{job.orderNo}</span>
                    <span className="text-ink2">{job.customer}</span>
                    <span className="tabular-nums">
                      {formatQty(job.qty, productForCode(source.products, job.itemCode)?.unit ?? 'each')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="text-sm text-ink2" data-schedule-detail-why>
              {selected.origin === 'gap'
                ? `Nothing has been written down for this yet. ${
                    detail.jobs.length > 0
                      ? `Putting it on the plan writes ${formatQty(selected.qty, selected.unit ?? 'each')} against ${
                          detail.jobs.length === 1 ? detail.jobs[0]?.orderNo ?? 'the order' : `${detail.jobs.length} orders`
                        }, and the order book keeps counting stock and racks against it.`
                      : ''
                  }`
                : selected.note}
              {selected.origin === 'plan' && selected.surplus > 0
                ? ` ${formatNumber(selected.surplus, 2)} more than the promises it answers.`
                : ''}
            </p>

            <div className="flex flex-wrap gap-2" data-schedule-detail-actions>
              {!canRecord ? (
                <p className="text-xs text-ink3">Putting things on the plan takes a maker or owner sign-in.</p>
              ) : selected.origin === 'gap' ? (
                selected.ours ? (
                  <Button
                    data-schedule-add
                    variant="primary"
                    size={touch ? 'touch' : 'sm'}
                    loading={busy}
                    disabled={busy}
                    onClick={() => void addToPlan(selected)}
                  >
                    Put {formatQty(selected.qty, selected.unit ?? 'each')} on the plan
                  </Button>
                ) : (
                  <p className="text-xs text-ink3">
                    {selected.code} has to be a product on this device before a make can be planned around it — it has
                    no cure time or route yet.
                  </p>
                )
              ) : (
                <>
                  {selected.status === 'planned' ? (
                    <Button
                      data-schedule-start
                      variant="primary"
                      size={touch ? 'touch' : 'sm'}
                      loading={busy}
                      disabled={busy}
                      onClick={() => void markStarted(selected)}
                    >
                      Started making it
                    </Button>
                  ) : (
                    <p className="text-xs text-ink3">
                      Being made. The racks are logged on Daily entry, and the order book counts them from then.
                    </p>
                  )}
                  <Button
                    data-schedule-cancel
                    size={touch ? 'touch' : 'sm'}
                    onClick={() => {
                      setReason('');
                      setCancelling(selected);
                    }}
                  >
                    Take it off the plan
                  </Button>
                </>
              )}
              {selected.origin === 'plan' ? (
                <Button size={touch ? 'touch' : 'sm'} icon="jobs" onClick={() => navigate('/entry')}>
                  Log the racks
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      <Modal
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        width="sm"
        title={`Take ${cancelling?.code ?? ''} off the plan`}
        subtitle="The line stays in the record, with the reason, so the plan and the story both add up afterwards."
        footer={
          <>
            <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={() => setCancelling(null)}>
              Leave it on the plan
            </Button>
            <Button
              variant="primary"
              size={touch ? 'touch' : 'md'}
              disabled={reason.trim() === '' || busy}
              loading={busy}
              onClick={() => void confirmCancel()}
            >
              Take it off
            </Button>
          </>
        }
      >
        <Field label="Why is it coming off" hint="The customer took it back, made by somebody else, no longer wanted — the words you would say out loud.">
          <TextInput
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Customer took the order back"
          />
        </Field>
      </Modal>
    </div>
  );
}

/**
 * The lead time in days, spelled out the way `latestStartDate` works it. Kept as a
 * label only — the arithmetic itself stays in one place in `core/calc`, so this can
 * never disagree with the date on the row.
 */
function leadDays(cureDays: number, route: string | null, blastDays: number, bufferDays: number): string {
  const days = cureDays + (route === 'shotblast' ? blastDays : 0) + bufferDays;
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

