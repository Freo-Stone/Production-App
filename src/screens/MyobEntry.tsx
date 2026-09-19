import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCan } from '@/app/session';
import { useIsCompact, useIsCoarsePointer } from '@/app/useMediaQuery';
import { readyAt } from '@/core/calc';
import { STAGE_LABELS } from '@/core/batches';
import { dayStart, formatDayFull, formatSince, isoDate, relativeDays, weekdayLong, weekdayName } from '@/core/dates';
import { formatNumber, formatQty, unitLabel } from '@/core/format';
import {
  copyOutCsv,
  copyOutTsv,
  entryQueue,
  entryRuns,
  exportCell,
  groupForExport,
  heldBack,
  keyedSince,
  runTotals,
} from '@/core/myobQueue';
import type { Batch, ProductUnit } from '@/core/types';
import { keyedRacks, markEntered, readyRacks, stockCapturedAt, unmarkEntered } from '@/data/batchRepo';
import { db, getSettings } from '@/data/db';
import { Icon } from '@/ui/Icon';
import { Button, Card, Chip, EmptyState, Field, Modal, TextInput, toast } from '@/ui/primitives';

/**
 * The weekly MYOB run.
 *
 * Once a week somebody sits down with everything that has come off the racks and
 * keys it into MYOB. The app cannot do that typing — MYOB is a desktop program on
 * another machine — so this screen's job is to make the run unambiguous: which
 * racks belong to this week and which to next week, what the totals are per item
 * code, what to paste, and then to take them off the shop's books once they have
 * been keyed.
 *
 * **The run date is worked out, not remembered.** Each rack belongs to the entry
 * weekday that follows the moment it came ready, rolled a week if it came ready
 * after that day's cut-off. Nothing here writes a date until the racks are keyed,
 * because a date remembered from last week is exactly what goes stale when a cure
 * day is corrected or a blast is recorded late.
 *
 * **The tick is the only per-rack decision.** Everything ready is in the run by
 * default; unticking is for the week one order goes out ahead of the rest. What is
 * copied out and what gets marked entered both follow the ticks, so the two can
 * never disagree about what the run was.
 */

export function MyobEntry() {
  const canEnter = useCan('myob.enter');
  // Gloved hands on a phone. Both hooks are called every render — a short-circuit
  // here unmounts the screen. See the note in Curing.tsx.
  const compact = useIsCompact();
  const coarse = useIsCoarsePointer();
  const touch = compact || coarse;

  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);

  const queue = useLiveQuery(() => readyRacks(), []);
  const keyed = useLiveQuery(() => keyedRacks(), []);
  const captured = useLiveQuery(() => stockCapturedAt(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const lines = useLiveQuery(() => db.lines.filter((l) => !l.deleted).sortBy('rank'), []);
  // Every code this device knows, and deliberately not narrowed to the current range.
  // This queue is work the shop has already made and has to be paid for: a rack cured
  // under a code that is off the range today still gets keyed into MYOB, and filtering
  // it here would turn finished work into stock nobody can invoice. Planning screens
  // filter by the tick (`core/currentRange`); the log and the queue do not.
  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted).sortBy('rank'), []);

  const byCode = useMemo(() => new Map((products ?? []).map((p) => [p.code, p])), [products]);
  const lineName = useMemo(() => new Map((lines ?? []).map((l) => [l.id, l.name])), [lines]);
  const unitOf = (code: string): ProductUnit => byCode.get(code)?.unit ?? 'pieces';

  // One narrowing point: below this, settings, lines and products all have values,
  // so no call has to invent a fallback for a shop whose settings have not loaded.
  if (settings === undefined || lines === undefined || products === undefined) {
    return <Card title="The MYOB run" subtitle="Reading the ready pile." />;
  }

  const rows = entryQueue(queue ?? [], settings);
  const runs = entryRuns(rows);
  const pickedRows = rows.filter((r) => !unticked.has(r.batch.id));
  const pickedRuns = entryRuns(pickedRows);
  const totals = runTotals(pickedRows, unitOf);
  const allRows = runTotals(rows, unitOf);
  const laterRacks = runs.slice(1).reduce((n, run) => n + run.rows.length, 0);
  // A run date in the past is not a mistake: it is a rack that came ready in a week
  // nobody keyed, and it has to be shouted about rather than filed under "this run".
  const today = dayStart(Date.now());
  const overdue = rows.reduce((n, r) => n + (r.runDate < today ? 1 : 0), 0);
  // On the ready pile but not ready — an imported row, a corrected cure day. They
  // cannot be keyed, so they are not in the run, and they are named rather than
  // silently dropped: the count on this screen has to be explainable.
  const waiting = heldBack(queue ?? [], settings);

  const columns = settings?.myobEntry.exportColumns ?? [];
  const exportLines = pickedRuns.flatMap((run) => groupForExport(run.rows, products, settings, run.runDate));
  const tsv = copyOutTsv(exportLines, columns);
  const keyedPile = keyedSince(keyed ?? [], captured ?? null);

  function toggle(id: string): void {
    setUnticked((current) => {
      const next = new Set(current);
      if (next.delete(id)) return next;
      next.add(id);
      return next;
    });
  }

  async function copyOut(): Promise<void> {
    if (await copyText(tsv)) {
      toast('info', `${exportLines.length} line${exportLines.length === 1 ? '' : 's'} copied`, 'Paste it into the MYOB grid. Nothing has been marked entered yet.');
    } else {
      setShowText(true);
      toast('short', 'The browser would not let the app copy', 'The text is below the table. Select it and copy it yourself.');
    }
  }

  function downloadCsv(): void {
    // Not every browser lets a page hand out a file. Say so rather than let the
    // press disappear — the copy-out above still works in that browser.
    if (typeof URL.createObjectURL !== 'function') {
      toast('short', 'This browser will not write a file', 'Use Copy for MYOB instead, or copy the text out of the table.');
      return;
    }
    const url = URL.createObjectURL(new Blob([copyOutCsv(exportLines, columns)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `freo-myob-run-${pickedRuns[0] === undefined ? isoDate(Date.now()) : isoDate(pickedRuns[0].runDate)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('info', 'Run written out', 'Nothing has been marked entered yet.');
  }

  async function confirmEntry(): Promise<void> {
    if (pickedRows.length === 0) return;
    setBusy(true);
    try {
      const { entered, refused } = await markEntered(pickedRows.map((r) => r.batch.id), ref);
      const qty = runTotals(entered.map((batch) => ({ batch, runDate: batch.myobRunDate ?? Date.now() })), unitOf);
      const words = qty.byUnit.map((u) => formatQty(u.qty, u.unit)).join(' · ');
      if (entered.length > 0) {
        toast('info', `${entered.length} rack${entered.length === 1 ? '' : 's'} keyed into MYOB`, `${words} off the books${ref.trim() === '' ? '' : ` · ref ${ref.trim()}`}.`);
      }
      for (const problem of refused.slice(0, 3)) {
        toast('short', 'Left in the queue', problem.reason);
      }
      if (refused.length > 3) {
        toast('short', 'Left in the queue', `${refused.length - 3} more racks were refused. The list will say why.`);
      }
      setConfirming(false);
      setRef('');
      setUnticked(new Set());
    } catch (error) {
      toast('short', 'Cannot mark the run entered', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function takeBack(batch: Batch): Promise<void> {
    try {
      await unmarkEntered(batch.id);
      toast('info', `${batch.batchNo} is back in the queue`, 'It was not keyed after all — both records say so.');
    } catch (error) {
      toast('short', 'Cannot take that rack back', error instanceof Error ? error.message : String(error));
    }
  }

  const description = (code: string): string => byCode.get(code)?.description ?? '';
  const lineFor = (id: string): string => lineName.get(id) ?? 'another line';

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-col gap-3">
        <Card title="The MYOB run" subtitle="Nothing is waiting to be keyed.">
          <EmptyState
            icon="myob"
            title="Nothing to key this week"
            body={
              waiting.length === 0
                ? 'Racks come here when they come off the cure — and after their blast, if they need one. Whatever has been keyed already is underneath, until the next MYOB export arrives.'
                : `${waiting.length} ${waiting.length === 1 ? 'rack is' : 'racks are'} on the ready pile but still curing, so ${waiting.length === 1 ? 'it is' : 'they are'} not in the run yet: ${waiting.slice(0, 3).map((b) => b.batchNo).join(', ')}${waiting.length > 3 ? `, and ${waiting.length - 3} more` : ''}.`
            }
          />
        </Card>
        {keyedPile.length > 0 ? <KeyedPile rows={keyedPile} captured={captured ?? null} canEnter={canEnter} touch={touch} onTakeBack={(b) => void takeBack(b)} description={description} /> : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Card
        title="The MYOB run"
        subtitle={
          unticked.size === 0
            ? `${allRows.racks} racks · ${formatRunQty(allRows)}`
            : `${totals.racks} of ${allRows.racks} racks ticked · ${formatRunQty(totals)}`
        }
        actions={
          <>
            {waiting.length > 0 ? (
              <Chip tone="warn" title="Their stage says ready; their cure says otherwise. They join the run when the cure is done.">
                {waiting.length} still curing
              </Chip>
            ) : null}
            {overdue > 0 ? (
              <Chip tone="warn" title="These came ready in a week that has already been keyed. They go in with the next run.">
                {overdue} {overdue === 1 ? 'rack is' : 'racks are'} overdue a run
              </Chip>
            ) : null}
            {laterRacks > 0 ? (
              <Chip tone="info" title="These belong to a later run — they came ready after this week's cut-off.">
                {laterRacks} for a later run
              </Chip>
            ) : null}
            {unticked.size > 0 ? (
              <Chip tone="warn" title="Unticked racks stay in the queue. Nothing is copied out or marked entered for them.">
                {unticked.size} left out
              </Chip>
            ) : null}
          </>
        }
      >
        <p className="text-sm text-ink2">
          {`${weekdayLong(settings.myobEntry.entryWeekday)} is the day the shop keys stock into MYOB. Anything that comes ready after ${formatClockHour(settings.myobEntry.cutoffHours)} that day goes into the following week’s run.`}
          {waiting.length > 0
            ? ` ${waiting.length} ${waiting.length === 1 ? 'rack is' : 'racks are'} on the ready pile but still curing — ${waiting.slice(0, 3).map((b) => b.batchNo).join(', ')}${waiting.length > 3 ? ', and more' : ''} — so ${waiting.length === 1 ? 'it is' : 'they are'} not in the run.`
            : ''}
          {unticked.size > 0 ? ' Only the ticked racks are copied out or marked entered.' : ''}
          {!canEnter ? ' Reading the run is open to everyone. Marking it entered takes a maker or owner sign-in.' : ''}
        </p>
      </Card>

      {runs.length > 0 ? (
        <Card padded={false} title="Ready to key" subtitle="Off the racks, in MYOB’s item order. Untick anything that is not going in this run.">
          {runs.map((run) => {
            const runTot = runTotals(run.rows, unitOf);
            return (
              <section key={run.runDate} data-myob-run={isoDate(run.runDate)}>
                <h3 className="flex flex-wrap items-baseline gap-x-2 bg-surface2/50 px-3 py-1.5 text-eyebrow font-700 uppercase tracking-wide text-ink3">
                  {runLabel(run.runDate, runs[0]?.runDate ?? run.runDate, today)}
                  <span className="font-500 normal-case tracking-normal text-ink3">
                    {runTot.racks} {runTot.racks === 1 ? 'rack' : 'racks'} · {formatRunQty(runTot)}
                  </span>
                </h3>
                <ul className="divide-y divide-line">
                  {run.rows.map((row) => (
                    <EntryRow
                      key={row.batch.id}
                      batch={row.batch}
                      description={description(row.batch.code)}
                      unit={unitOf(row.batch.code)}
                      line={lineFor(row.batch.lineId)}
                      ready={readyAt(row.batch, settings) ?? row.batch.cureDueAt}
                      picked={!unticked.has(row.batch.id)}
                      onToggle={() => toggle(row.batch.id)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </Card>
      ) : null}

      {rows.length > 0 ? (
        <Card
          title="What gets copied out"
          subtitle="One line per item code. This is what you paste into MYOB — copying it changes nothing."
          actions={
            canEnter ? (
              <>
                <Button size={touch ? 'touch' : 'sm'} onClick={() => void copyOut()} disabled={exportLines.length === 0}>
                  Copy for MYOB
                </Button>
                <Button size={touch ? 'touch' : 'sm'} icon="download" onClick={downloadCsv} disabled={exportLines.length === 0}>
                  CSV
                </Button>
                <Button variant="primary" size={touch ? 'touch' : 'sm'} onClick={() => setConfirming(true)} disabled={pickedRows.length === 0}>
                  Mark entered
                </Button>
              </>
            ) : null
          }
        >
          {exportLines.length === 0 ? (
            <p className="text-sm text-ink2">Every rack in the queue is unticked, so there is nothing to copy out. Tick what is going in.</p>
          ) : (
            <>
              <div className="-mx-3 overflow-x-auto px-3">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c.key} className="border-b border-line px-2 py-1.5 text-left text-eyebrow font-700 uppercase tracking-wide text-ink3">
                          {c.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exportLines.map((line) => (
                      <tr key={`${line.code}-${line.memo}`} data-myob-line={line.code}>
                        {/* One cell per configured column, from the same list the
                            headers come from. A shop that reorders or drops a column
                            in Settings must not end up reading a quantity under a
                            Description heading — the copy-out already works this way,
                            so the table has to agree with what gets pasted. */}
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className={
                              c.key === 'qty'
                                ? 'px-2 py-1.5 tabular-nums'
                                : c.key === 'code'
                                  ? 'px-2 py-1.5 font-600'
                                  : 'px-2 py-1.5 text-ink2'
                            }
                          >
                            {c.key === 'qty'
                              ? formatNumber(line.qty)
                              : c.key === 'unit'
                                ? unitLabel(line.unit)
                                : exportCell(line, c.key)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="pt-2 text-xs text-ink3">
                {exportLines.length} {exportLines.length === 1 ? 'line' : 'lines'} from {totals.racks} {totals.racks === 1 ? 'rack' : 'racks'}.
                {columns.length === 0 ? ' No columns are configured — set them in Settings.' : ''}
              </p>
              {showText ? (
                <textarea
                  data-myob-copytext
                  readOnly
                  value={tsv}
                  rows={Math.min(12, exportLines.length + 1)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-2 w-full resize-y rounded-[var(--radius-md)] border border-line bg-surface2 p-2 font-mono text-xs"
                />
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      {keyedPile.length > 0 ? (
        <KeyedPile rows={keyedPile} captured={captured ?? null} canEnter={canEnter} touch={touch} onTakeBack={(b) => void takeBack(b)} description={description} />
      ) : null}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        width="sm"
        title={`Mark ${totals.racks} ${totals.racks === 1 ? 'rack' : 'racks'} entered`}
        subtitle="This says they are in MYOB. It does not type anything in for you."
        footer={
          <>
            <Button size={touch ? 'touch' : 'sm'} onClick={() => setConfirming(false)}>
              Not yet
            </Button>
            <Button variant="primary" size={touch ? 'touch' : 'sm'} onClick={() => void confirmEntry()} disabled={busy || pickedRows.length === 0}>
              They are in MYOB
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink2">
            {formatRunQty(totals)} across {totals.codes} {totals.codes === 1 ? 'item code' : 'item codes'}. They leave the queue and turn up under
            <em> Keyed, not in the export yet</em> until the next MYOB export arrives.
          </p>
          <Field label="MYOB reference" hint="The invoice or batch number you keyed it under. Optional, and it goes in the ledger.">
            <TextInput
              data-myob-ref
              autoFocus
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="INV-0000"
              onKeyUp={(e) => {
                if (e.key === 'Enter') void confirmEntry();
              }}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/* ── Pieces ────────────────────────────────────────────────────────────────── */

function EntryRow({
  batch,
  description,
  unit,
  line,
  ready,
  picked,
  onToggle,
}: {
  batch: Batch;
  description: string;
  unit: ProductUnit;
  line: string;
  ready: number;
  picked: boolean;
  onToggle: () => void;
}) {
  return (
    <li data-myob-rack={batch.batchNo} data-myob-picked={picked ? 'yes' : 'no'}>
      {/* The whole row is the tick: on a phone, a 20px box at the edge of a list is
          a miss every time, and the only decision on a rack here is in or out. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={picked}
        aria-label={`${picked ? 'Leave out' : 'Put in'} this run: ${batch.batchNo}, ${description || batch.code}`}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface2"
      >
        <span
          className={
            picked
              ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-curing/40 bg-curingbg text-curing'
              : 'flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-line bg-surface2 text-transparent'
          }
          aria-hidden="true"
        >
          <Icon name="check" size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs text-ink2">{batch.batchNo}</span>
            <span className="text-sm font-650">{batch.code}</span>
            <span className="truncate text-xs text-ink3">{description}</span>
            {batch.blastedQty > 0 ? <Chip tone="curing">Blasted</Chip> : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-ink3">
            <span>{line}</span>
            <span>
              <span className="text-ink tabular-nums">{formatNumber(batch.trays, 0)} trays</span>
              <span className="px-1" aria-hidden="true">
                ·
              </span>
              {formatQty(batch.qty, unit)}
            </span>
            <span>ready {relativeDays(ready)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function KeyedPile({
  rows,
  captured,
  canEnter,
  touch,
  onTakeBack,
  description,
}: {
  rows: Batch[];
  captured: number | null;
  canEnter: boolean;
  touch: boolean;
  onTakeBack: (batch: Batch) => void;
  description: (code: string) => string;
}) {
  return (
    <Card
      padded={false}
      title="Keyed, not in the export yet"
      subtitle={
        captured === null
          ? 'Keyed into MYOB since there was last an export on this device.'
          : `Keyed since the MYOB export on ${formatDayFull(captured)}. Until a new export arrives, they are missing from every stock figure.`
      }
    >
      <ul className="divide-y divide-line">
        {rows.map((batch) => (
          <li key={batch.id} data-myob-keyed={batch.batchNo} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs text-ink2">{batch.batchNo}</span>
                <span className="text-sm font-650">{batch.code}</span>
                <span className="truncate text-xs text-ink3">{description(batch.code)}</span>
              </span>
              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-ink3">
                <span>keyed {formatSince(batch.enteredAt)}</span>
                {batch.enteredRef === '' ? null : <span>ref {batch.enteredRef}</span>}
                {batch.myobRunDate === null ? null : <span>run {formatDayFull(batch.myobRunDate)}</span>}
                <span className="text-ink3">{STAGE_LABELS[batch.stage]}</span>
              </span>
            </span>
            {canEnter ? (
              <Button variant="ghost" size={touch ? 'touch' : 'sm'} onClick={() => onTakeBack(batch)} data-myob-takeback={batch.batchNo}>
                It was not keyed
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ── Words ─────────────────────────────────────────────────────────────────── */

/**
 * Which run a heading is. The earliest one on screen is "this run" — the rest are
 * counted in weeks from it, because "25/09/2026" does not tell you whether it is
 * next week or the one after.
 */
function runLabel(runDate: number, firstRun: number, today: number): string {
  const words = `${weekdayName(new Date(runDate).getDay())} ${formatDayFull(runDate)}`;
  if (runDate < today) return `Overdue — ${words}`;
  if (runDate === firstRun) return `This run — ${words}`;
  const weeks = Math.round((runDate - firstRun) / (7 * 86_400_000));
  return weeks === 1 ? `Next run — ${words}` : `In ${weeks} weeks — ${words}`;
}

function formatRunQty(totals: { byUnit: Array<{ unit: ProductUnit; qty: number }>; trays: number }): string {
  const qty = totals.byUnit.map((u) => formatQty(u.qty, u.unit)).join(' · ');
  return `${formatNumber(totals.trays, 0)} trays · ${qty === '' ? 'nothing' : qty}`;
}

function formatClockHour(hours: number): string {
  if (hours >= 24) return 'midnight the following day';
  if (hours === 12) return 'midday';
  if (hours === 0) return 'midnight';
  const h = hours > 12 ? hours - 12 : hours;
  const suffix = hours >= 12 ? 'pm' : 'am';
  return `${h}:00${suffix}`;
}

/**
 * The clipboard, with a way out.
 *
 * `navigator.clipboard` is missing outright on plain-http origins, and it rejects
 * when the page is not focused — both of which happen on a shop floor tablet. When
 * it fails the text is put on the screen to select by hand rather than the press
 * quietly doing nothing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the old way, then to showing the text.
  }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', 'true');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch {
    return false;
  }
}
