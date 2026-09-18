import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRoute, setQueryParam } from '@/app/router';
import { useCan } from '@/app/session';
import { entryTotals, resolveEntryRows, canUndo, STAGE_LABELS, type EntryDraft } from '@/core/batches';
import { addDays, dayStart, formatDayFull, isSameDay, relativeDays } from '@/core/dates';
import { formatQty } from '@/core/format';
import { uid } from '@/core/ids';
import type { BatchStage } from '@/core/types';
import { batchesOnDay, EntryRefusedError, recordEntry, undoEntry } from '@/data/batchRepo';
import { db } from '@/data/db';
import { Button, Card, Chip, EmptyState, NumberInput, Select, toast, type Tone } from '@/ui/primitives';

/**
 * Daily entry — the floor's own screen, and the only place a number becomes a rack.
 *
 * The sheet is deliberately narrow: one line, one day, as many product rows as
 * that line ran. A floor person is not choosing between five lines at once, and
 * every extra thing on this screen is a thing they have to look past with wet
 * gloves on.
 *
 * The quantity is never typed. Trays are counted, and trays × that product's
 * tray yield is the quantity that goes into MYOB — so the same twelve trays that
 * fill a rack fill the ledger the same way, whatever the product is. The one
 * number the floor types is the one number it can actually count.
 */

/** Which line this device was last logging on, so the next shift lands in the right place. */
const LINE_KEY = 'freo.entry.line';

const STAGE_TONE: Partial<Record<BatchStage, Tone>> = {
  curing: 'curing',
  green: 'curing',
  awaiting_shotblast: 'warn',
  blasting: 'warn',
  ready: 'info',
  entered_myob: 'neutral',
  written_off: 'short',
};

function blankRow(): EntryDraft {
  return { key: uid('row'), code: '', trays: null };
}

/** Is a row worth showing a message for? A spare empty row at the bottom is not. */
function isUsed(row: EntryDraft): boolean {
  return row.code !== '' || (row.trays ?? 0) > 0;
}

export function Entry() {
  const route = useRoute();
  const canRecord = useCan('production.record');
  const today = dayStart(Date.now());

  const [day, setDay] = useState(today);
  const [lineId, setLineId] = useState<string>(() => localStorage.getItem(LINE_KEY) ?? '');
  const [rows, setRows] = useState<EntryDraft[]>(() => [blankRow()]);
  const [saving, setSaving] = useState(false);

  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted).sortBy('rank'), []);
  const lines = useLiveQuery(() => db.lines.filter((l) => !l.deleted).sortBy('rank'), []);
  const logged = useLiveQuery(() => batchesOnDay(day), [day]);

  // The Matrix sends a person here with a code when they tap "Log making of this",
  // and the code has to leave the address afterwards: a bookmark should not keep
  // offering the same product next Tuesday.
  useEffect(() => {
    const code = route.query.get('code');
    const line = route.query.get('line');
    if (code === null && line === null) return;
    if (code !== null) setRows([{ key: uid('row'), code, trays: null }]);
    if (line !== null) setLineId(line);
    setQueryParam('code', null);
    setQueryParam('line', null);
  }, [route]);

  const activeLines = useMemo(() => (lines ?? []).filter((l) => l.active), [lines]);
  const line = activeLines.find((l) => l.id === lineId) ?? activeLines[0];

  // Remember the line this device logs on, so the next shift lands in the right
  // place instead of asking which machine ran today.
  useEffect(() => {
    if (line !== undefined) localStorage.setItem(LINE_KEY, line.id);
  }, [line?.id]);

  const byCode = useMemo(() => new Map((products ?? []).map((p) => [p.code, p])), [products]);
  const pickable = useMemo(() => (products ?? []).filter((p) => p.enabled), [products]);

  const used = rows.filter(isUsed);
  const resolved = useMemo(() => resolveEntryRows(used, pickable), [used, pickable]);
  const totals = entryTotals(resolved);
  const blockedBy = resolved.find((l) => l.problem !== null);

  const onLine = (logged ?? []).filter((b) => line !== undefined && b.lineId === line.id);
  const onLineQty = onLine.reduce((sum, b) => sum + b.qty, 0);
  // Same rule for the day's total: the unit only appears when every rack on the
  // line shares it. The per-rack rows carry their own unit either way.
  const onLineUnits = new Set(onLine.map((b) => byCode.get(b.code)?.unit));
  const onLineUnit = onLineUnits.size === 1 ? [...onLineUnits][0] : undefined;

  // A line's total is only in one unit if everything on it is. A paver line and a
  // retaining-wall line running side by side is mixed, and adding m² to lm is a
  // number nobody can check, so it is left off rather than shown wrong.
  const usable = resolved.filter((l) => l.problem === null);
  const units = new Set(usable.map((l) => l.product?.unit));
  const totalUnit = units.size === 1 ? [...units][0] : undefined;
  const totalText =
    totals.trays > 0
      ? `${totals.trays} tray${totals.trays === 1 ? '' : 's'} · ${formatQty(totals.qty, totalUnit, 2)}`
      : 'Nothing counted yet';

  // Back-dating is allowed because a night shift writes it up the next morning.
  // Then the make is timed to midday: the cure is measured in days, and the hour
  // nobody remembers must not be the thing that decides when a rack is due.
  const madeAt = isSameDay(day, Date.now()) ? Date.now() : dayStart(day) + 12 * 3_600_000;

  const patchRow = useCallback((key: string, patch: Partial<EntryDraft>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  async function submit() {
    if (line === undefined || used.length === 0) return;
    setSaving(true);
    try {
      const receipt = await recordEntry({ lineId: line.id, madeAt, rows: used });
      if (receipt.created.length > 0) {
        const qty = receipt.created.reduce((s, b) => s + b.qty, 0);
        const unit = byCode.get(receipt.created[0]?.code ?? '')?.unit;
        toast(
          'info',
          `Logged ${receipt.created.length} rack${receipt.created.length === 1 ? '' : 's'} on ${line.name}`,
          `${formatQty(qty, unit)} onto the cure clock · ${receipt.created.map((b) => b.batchNo).join(', ')}`,
        );
        // The sheet clears because the day's list below is now the record of it.
        setRows([blankRow()]);
      }
      for (const refusal of receipt.refused) toast('warn', 'Row not logged', refusal.problem);
    } catch (error) {
      toast('short', 'Nothing was logged', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function takeBack(batchId: string, batchNo: string) {
    try {
      await undoEntry(batchId);
      toast('info', `${batchNo} taken back`, 'It is off the day, and the log says who took it back.');
    } catch (error) {
      const message = error instanceof EntryRefusedError || error instanceof Error ? error.message : String(error);
      toast('short', 'Cannot take that back', message);
    }
  }

  if (pickable.length === 0) {
    return (
      <Card title="Daily entry" subtitle="Log trays made per line.">
        <EmptyState
          icon="products"
          title="No product codes are yours yet"
          body="Entry lists the codes you have switched on in Products. Switch the ones you make on, and they will appear here."
        />
      </Card>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Card
        // The shell header already says "Daily entry", and the day is in the stepper
        // beside this heading — repeating it here only made the title truncate on a
        // phone, which is how a person ends up counting for the wrong line.
        title={line?.name ?? 'No line'}
        subtitle="Count the trays. Trays × this product’s yield is what goes into MYOB."
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon="chevronLeft"
              aria-label="The day before"
              onClick={() => setDay(addDays(day, -1))}
            />
            <span className="min-w-[13ch] text-center text-[0.82rem] font-650" data-entry-day>
              {formatDayFull(day)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon="chevronRight"
              aria-label="The day after"
              disabled={isSameDay(day, today)}
              title={isSameDay(day, today) ? 'You cannot log a day that has not happened.' : undefined}
              onClick={() => setDay(addDays(day, 1))}
            />
            {!isSameDay(day, today) ? (
              <Button size="sm" onClick={() => setDay(today)}>
                Today
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          {activeLines.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which line ran">
              {activeLines.map((l) => (
                <Button
                  key={l.id}
                  size="sm"
                  active={line?.id === l.id}
                  aria-pressed={line?.id === l.id}
                  onClick={() => setLineId(l.id)}
                  data-entry-line={l.id}
                >
                  {l.name}
                </Button>
              ))}
            </div>
          ) : null}

          {!isSameDay(day, today) ? (
            <p className="text-xs text-warn" data-entry-backdate>
              You are logging {relativeDays(day)} — timed to midday, which is what the cure date works from.
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5" data-entry-rows>
            {rows.map((row) => {
              const entry = resolved.find((l) => l.draft.key === row.key);
              const product = entry?.product ?? byCode.get(row.code);
              return (
                <div
                  key={row.key}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface2 p-2"
                  data-entry-row={row.key}
                >
                  <Select
                    aria-label="Product"
                    className="min-w-[16rem] flex-1"
                    value={row.code}
                    onChange={(e) => patchRow(row.key, { code: e.target.value })}
                    options={[
                      { value: '', label: 'Choose a product…' },
                      ...pickable.map((p) => ({ value: p.code, label: `${p.code} — ${p.description}` })),
                    ]}
                  />
                  <NumberInput
                    aria-label="Trays"
                    className="w-24"
                    unit="trays"
                    min={1}
                    step={1}
                    value={row.trays}
                    onValueChange={(n) => patchRow(row.key, { trays: n })}
                  />
                  <span className="min-w-[9ch] text-right text-sm tabular-nums" data-entry-qty={row.key}>
                    {entry && entry.problem === null ? formatQty(entry.qty, product?.unit, 2) : '—'}
                  </span>
                  {row.code !== '' || rows.length > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="close"
                      aria-label="Remove this row"
                      onClick={() => setRows((prev) => (prev.length === 1 ? [blankRow()] : prev.filter((r) => r.key !== row.key)))}
                    />
                  ) : null}
                  {entry && entry.problem !== null ? (
                    <p className="w-full text-xs text-warn" data-entry-problem={row.key}>
                      {entry.problem}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2">
              <Button
                icon="plus"
                onClick={() => setRows((prev) => [...prev, blankRow()])}
                disabled={!canRecord}
              >
                Another product
              </Button>
              <Chip tone={totals.problems > 0 ? 'warn' : 'info'} data-entry-totals>
                {totalText}
                {units.size > 1 ? ' · mixed units' : ''}
              </Chip>
            </div>
            <Button
              variant="primary"
              size="touch"
              loading={saving}
              disabled={!canRecord || saving || totals.trays <= 0 || totals.problems > 0}
              onClick={() => void submit()}
              title={
                blockedBy
                  ? `Fix this first: ${blockedBy.problem}`
                  : canRecord
                    ? undefined
                    : 'Logging production needs a maker or owner sign-in.'
              }
              data-entry-submit
            >
              Log {totals.trays > 0 ? `${totals.trays} trays` : 'the day'}
              {line ? ` on ${line.name}` : ''}
            </Button>
          </div>

          {!canRecord ? (
            <p className="text-xs text-ink3">
              You can read what has been logged. Logging it takes a maker or owner sign-in.
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        padded={false}
        title="What was logged"
        subtitle={
          onLine.length === 0
            ? 'Nothing logged on this line for this day yet.'
            : `${onLine.length} rack${onLine.length === 1 ? '' : 's'} · ${formatQty(onLineQty, onLineUnit, 2)} logged${
                onLineUnit === undefined ? ' across mixed units' : ''
              }`
        }
        actions={
          (logged ?? []).length > onLine.length ? (
            <Chip tone="neutral" title="Everything logged today, on every line.">
              {(logged ?? []).length} across the shop
            </Chip>
          ) : null
        }
      >
        {onLine.length === 0 ? (
          <EmptyState
            icon="entry"
            title="Nothing logged yet"
            body="Count the trays above and log them. The racks appear here with the day they come off the cure."
          />
        ) : (
          <ul className="divide-y divide-line">
            {onLine.map((b) => {
              const product = byCode.get(b.code);
              const undoable = canRecord && canUndo(b);
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-logged-batch={b.batchNo}>
                  <span className="w-[13ch] shrink-0 font-mono text-xs text-ink3">{b.batchNo}</span>
                  <span className="min-w-[10rem] flex-1 truncate text-sm">
                    <span className="font-650">{b.code}</span>
                    <span className="text-ink3"> {product?.description ?? ''}</span>
                  </span>
                  <span className="text-sm tabular-nums" title="Trays counted, and the quantity they make">
                    {b.trays} trays · {formatQty(b.qty, product?.unit, 2)}
                  </span>
                  <Chip tone={STAGE_TONE[b.stage] ?? 'neutral'}>{STAGE_LABELS[b.stage]}</Chip>
                  <span className="text-xs text-ink3" title="The day the cure is due">
                    due {relativeDays(b.cureDueAt)}
                  </span>
                  {undoable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="undo"
                      onClick={() => void takeBack(b.id, b.batchNo)}
                      data-undo-batch={b.batchNo}
                    >
                      Take back
                    </Button>
                  ) : canRecord ? (
                    <span
                      className="text-xs text-ink3"
                      title="It has been blasted, put on a MYOB run, or keyed in. Correct it by writing it off."
                    >
                      past taking back
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
