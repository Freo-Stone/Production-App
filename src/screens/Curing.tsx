import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCan } from '@/app/session';
import { useIsCoarsePointer, useIsCompact } from '@/app/useMediaQuery';
import { STAGE_LABELS } from '@/core/batches';
import { cureState, cureSummary, groupForCure, moveProblem, type CureState } from '@/core/curing';
import { formatSince, relativeDays } from '@/core/dates';
import { formatNumber, formatQty } from '@/core/format';
import type { Batch, BatchStage, ProductUnit, Settings } from '@/core/types';
import { advanceDueBatches, moveBatchStage, racksOnTheClock, readyRacks, writeOffBatch } from '@/data/batchRepo';
import { db, getSettings } from '@/data/db';
import { Button, Card, Chip, EmptyState, Field, Modal, TextInput, toast } from '@/ui/primitives';

/**
 * The cure racks — what is on the floor, and when it comes off.
 *
 * This screen answers one question twice a day: *what can I take out now?* So it
 * is ordered by when a rack becomes usable, not by when it was made, and it keeps
 * apart the two things that look alike and are not — a rack whose cure is over but
 * whose blast has not happened, and a rack that is ready and still sitting where
 * it was cured because nobody moved it.
 *
 * Nothing moves by itself. The sweep at the top is an offer, and pressing it is a
 * person's decision, because a pallet of pavers should not leave the racks on a
 * timer's say-so. Everyone can read the racks; only a maker or an owner can move
 * them, write one off, or put one back.
 */

const STAGE_TONE: Partial<Record<BatchStage, 'curing' | 'warn' | 'info' | 'neutral' | 'short'>> = {
  green: 'curing',
  curing: 'curing',
  awaiting_shotblast: 'warn',
  blasting: 'warn',
  ready: 'info',
  written_off: 'short',
};

export function Curing() {
  const canRecord = useCan('production.record');
  // Gloved hands on a phone: the two actions a person aims at get the 44px target,
  // and a mouse on a desk keeps the compact row. Both hooks are called on every
  // render — `useIsCompact() || useIsCoarsePointer()` reads tidier and is a bug:
  // once compact is true the second hook is never called, and React tears the
  // whole screen down ("Rendered fewer hooks than expected").
  const compact = useIsCompact();
  const coarse = useIsCoarsePointer();
  const touch = compact || coarse;
  const [busy, setBusy] = useState(false);
  const [writingOff, setWritingOff] = useState<Batch | null>(null);
  const [reason, setReason] = useState('');

  const racks = useLiveQuery(() => racksOnTheClock(), []);
  const takenOff = useLiveQuery(() => readyRacks(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const lines = useLiveQuery(() => db.lines.filter((l) => !l.deleted).sortBy('rank'), []);
  // Same shape the Daily entry screen uses — `sortBy('rank')` rather than a bare
  // `toArray()`, which is the form Dexie's live query can re-run on a change.
  // Whole range on purpose: this is a code -> description/unit lookup for racks that
  // exist, not a list of what we plan to make. A rack made under a code that is off
  // the range today still has to read properly here. See `core/currentRange`.
  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted).sortBy('rank'), []);

  const byCode = useMemo(() => new Map((products ?? []).map((p) => [p.code, p])), [products]);
  const lineName = useMemo(() => new Map((lines ?? []).map((l) => [l.id, l.name])), [lines]);

  const live = racks ?? [];
  const off = takenOff ?? [];
  // Every lookup in before any row is drawn. The racks are a quick query and the
  // 2,691 products are not, so without this the list flashes bare codes and then
  // fills in — a rack that reads "GL4" for half a second reads as broken data.
  const ready = settings !== undefined && lines !== undefined && products !== undefined;
  const shown = settings === undefined ? [] : groupForCure(live, settings);
  const summary = settings === undefined ? null : cureSummary(live, settings);

  async function sweep() {
    setBusy(true);
    try {
      const { moved, refused } = await advanceDueBatches();
      if (moved.length > 0) {
        const trays = moved.reduce((s, b) => s + b.trays, 0);
        toast(
          'info',
          `${moved.length} rack${moved.length === 1 ? '' : 's'} off the racks`,
          `${formatNumber(trays, 0)} trays are ready for the next MYOB run.`,
        );
      }
      for (const refusal of refused) toast('warn', `${refusal.batchNo} stayed where it was`, refusal.problem);
      if (moved.length === 0 && refused.length === 0) toast('info', 'Nothing was due', 'The racks have not finished curing yet.');
    } catch (error) {
      toast('short', 'Nothing was moved', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function move(batch: Batch, to: BatchStage) {
    try {
      await moveBatchStage(batch.id, to);
      toast(
        'info',
        `${batch.batchNo} is ${STAGE_LABELS[to].toLowerCase()}`,
        to === 'ready' ? 'It is on the ready pile for the next MYOB run.' : 'Back on the cure clock, with its own due date.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast('short', 'Cannot move that rack', message);
    }
  }

  async function confirmWriteOff() {
    if (writingOff === null) return;
    try {
      await writeOffBatch(writingOff.id, reason);
      toast('info', `${writingOff.batchNo} written off`, 'The rack stays in the record with the reason you gave.');
      setWritingOff(null);
      setReason('');
    } catch (error) {
      toast('short', 'Cannot write that off', error instanceof Error ? error.message : String(error));
    }
  }

  // Nothing on the racks and nothing waiting to be entered: that is the whole
  // screen, and saying so plainly beats showing two empty cards.
  if (ready && live.length === 0 && off.length === 0) {
    return (
      <Card title="The racks" subtitle="Nothing is on the racks and nothing is waiting to be entered.">
        <EmptyState
          icon="curing"
          title="No racks on the clock"
          body="When a day's making is logged on Daily entry, the racks appear here with the day each one comes off the cure."
        />
      </Card>
    );
  }

  // Whether there is anything worth listing above the ready pile.
  const showRacks = !ready || live.length > 0;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* Two empty cards under a heading that says "0 racks" tell nobody anything.
          When the racks are clear and the only thing left is the ready pile, show
          the pile. */}
      {showRacks ? (
        <>
          <Card
            title="On the racks"
            subtitle={
              summary === null
                ? 'Counting what is curing.'
                : `${summary.racks} rack${summary.racks === 1 ? '' : 's'} · ${formatNumber(summary.trays, 0)} trays${
                    summary.due > 0 ? ` · ${summary.due} off the cure and not moved` : ''
                  }`
            }
            actions={
              <>
                {summary !== null && summary.awaitingBlast > 0 ? (
                  <Chip tone="warn" title="Curing and waiting for the blaster at the same time.">
                    {summary.awaitingBlast} needs a blast
                  </Chip>
                ) : null}
                {/* Short on purpose: these two sit beside a heading on a phone, and the
                offer below says how long the oldest one has waited. */}
                {summary !== null && summary.due > 0 ? (
                  <Chip tone="info" title="The cure is done. Somebody has to decide they are ready.">
                    {summary.due} to move
                  </Chip>
                ) : null}
              </>
            }
          >
            {summary !== null && summary.due > 0 ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-panel2/60 px-3 py-2"
                data-curing-offer
              >
                <p className="min-w-[16rem] flex-1 text-sm text-ink2">
                  {summary.due} rack{summary.due === 1 ? '' : 's'} {summary.due === 1 ? 'has' : 'have'} come off the cure
                  {summary.overdueDays > 0
                    ? `, and the oldest has sat there ${summary.overdueDays} day${summary.overdueDays === 1 ? '' : 's'}`
                    : ''}
                  .{canRecord ? ' Moving them to Ready puts them in the way of the next MYOB run.' : ''}
                </p>
                {canRecord ? (
                  <Button variant="primary" size={touch ? 'touch' : 'sm'} loading={busy} onClick={() => void sweep()} data-curing-sweep>
                    Move them to Ready
                  </Button>
                ) : (
                  <p className="text-xs text-ink3">Moving them takes a maker or owner sign-in.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink3">
                Nothing is due. Each rack keeps the cure date it was made with, so these dates do not move when a product’s cure days
                change.
              </p>
            )}
          </Card>

          <Card padded={false} title="The racks" subtitle={`${summary?.racks ?? live.length} on the clock, soonest first.`}>
            {!ready ? (
              <p className="px-3 py-3 text-sm text-ink3">Reading the racks…</p>
            ) : (
              <div className="divide-y divide-line">
                {shown.map((group) => (
                  <section key={group.bucket} data-curing-bucket={group.bucket}>
                    <h3 className="bg-panel2/50 px-3 py-1.5 text-eyebrow font-700 uppercase tracking-wide text-ink3">
                      {group.label}
                      <span className="ml-2 font-500 normal-case">
                        {group.rows.length} rack
                        {group.rows.length === 1 ? '' : 's'}
                      </span>
                    </h3>
                    <ul>
                      {group.rows.map((batch) => (
                        <Rack
                          key={batch.id}
                          batch={batch}
                          state={cureState(batch, settings)}
                          description={byCode.get(batch.code)?.description ?? ''}
                          unit={byCode.get(batch.code)?.unit}
                          line={lineName.get(batch.lineId) ?? 'off the lines'}
                          settings={settings}
                          canMove={canRecord}
                          touch={touch}
                          onMove={(to) => void move(batch, to)}
                          onWriteOff={() => {
                            setReason('');
                            setWritingOff(batch);
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Card>
        </>
      ) : null}

      {/* The other half of the rack story. A rack that has come off the cure is on
          the ready pile, waiting for someone to key it into MYOB — and if it came
          off by mistake, this is where it goes back. Without it, a wrong button on
          the list above would strand stock in a place nobody can see. */}
      {ready && off.length > 0 ? (
        <Card
          padded={false}
          title="Off the racks, not entered yet"
          subtitle="Ready, waiting to be keyed into MYOB."
        >
          <ul className="divide-y divide-line">
            {off.map((batch) => (
              <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-3 py-2" data-curing-offrack={batch.batchNo} key={batch.id}>
                <span className="w-[13ch] shrink-0 font-mono text-xs text-ink3">{batch.batchNo}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-650">{batch.code}</span>
                  <span className="text-ink3"> {byCode.get(batch.code)?.description ?? ''}</span>
                </span>
                <span className="text-sm tabular-nums">
                  {formatNumber(batch.trays, 0)} trays
                  <span className="text-ink3"> · {formatQty(batch.qty, byCode.get(batch.code)?.unit)}</span>
                </span>
                <span className="text-xs text-ink3">off the racks {formatSince(batch.updatedAt)}</span>
                {canRecord ? (
                  <Button
                    variant="ghost"
                    size={touch ? 'touch' : 'sm'}
                    className="ml-auto"
                    onClick={() => void move(batch, 'curing')}
                    data-curing-putback={batch.batchNo}
                  >
                    Put it back
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Modal
        open={writingOff !== null}
        onClose={() => setWritingOff(null)}
        width="sm"
        title={`Write ${writingOff?.batchNo ?? ''} off`}
        subtitle="The rack stays in the record, with the reason, so the stock and the story both add up afterwards."
        footer={
          <>
            <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={() => setWritingOff(null)}>
              Leave it on the racks
            </Button>
            <Button variant="primary" size={touch ? 'touch' : 'md'} disabled={reason.trim() === ''} onClick={() => void confirmWriteOff()}>
              Write it off
            </Button>
          </>
        }
      >
        <Field label="What happened to it" hint="Cracked in the sling, reworked, scrapped — the words you would say out loud.">
          <TextInput
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Cracked in the sling"
            aria-label="Why this rack is being written off"
          />
        </Field>
        {writingOff !== null ? (
          <p className="mt-3 text-xs text-ink3">
            {formatNumber(writingOff.trays, 0)} trays · {formatQty(writingOff.qty, byCode.get(writingOff.code)?.unit)} · on the racks since{' '}
            {relativeDays(writingOff.madeAt)}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

function Rack({
  batch,
  state,
  description,
  unit,
  line,
  settings,
  canMove,
  touch,
  onMove,
  onWriteOff,
}: {
  batch: Batch;
  state: CureState;
  description: string;
  unit: ProductUnit | undefined;
  line: string;
  settings: Settings;
  canMove: boolean;
  touch: boolean;
  onMove: (to: BatchStage) => void;
  onWriteOff: () => void;
}) {
  // The same rule the writer uses, asked here, so a button that appears can only
  // be refused for something that happened after it was drawn.
  const refusal = moveProblem(batch, 'ready', settings);
  const when =
    state.planDate === null ? 'waits for its blast' : state.ready ? 'off the cure now' : `due ${relativeDays(state.planDate, Date.now())}`;

  // Two lines, at every width. A rack carries five facts and a decision: on one
  // line they clip each other on a phone and read as a spreadsheet on a desktop.
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2" data-curing-rack={batch.batchNo}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-[13ch] shrink-0 font-mono text-xs text-ink3">{batch.batchNo}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-650">{batch.code}</span>
          <span className="text-ink3"> {description}</span>
        </span>
        {/* Only when the stage chip does not already say it: a rack sitting in the
            blaster's queue does not need to be told twice. */}
        {state.needsBlast && batch.stage !== 'awaiting_shotblast' && batch.stage !== 'blasting' ? (
          <Chip tone="warn" title="The cure is running, and the blaster has not had this one yet.">
            Needs blast
          </Chip>
        ) : null}
        <Chip tone={STAGE_TONE[batch.stage] ?? 'neutral'} title="Where it is in the shop.">
          {STAGE_LABELS[batch.stage]}
        </Chip>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-ink3">{line}</span>
        <span className="text-sm tabular-nums">
          {formatNumber(batch.trays, 0)} trays
          <span className="text-ink3"> · {formatQty(batch.qty, unit)}</span>
        </span>
        {/* A fixed bar, not `flex-1`: stretched across the page it stops meaning
            anything, and the row's own numbers are what a person reads. */}
        <span className="flex w-[12rem] shrink-0 items-center gap-2" data-curing-bar>
          <span className="h-1 w-[4.5rem] shrink-0 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </span>
          <span className="whitespace-nowrap text-xs text-ink2">{when}</span>
        </span>
        {canMove ? (
          <span className="ml-auto flex items-center gap-1.5">
            {refusal === null ? (
              <Button variant="primary" size={touch ? 'touch' : 'sm'} onClick={() => onMove('ready')} data-curing-move={batch.batchNo}>
                Take it off
              </Button>
            ) : null}
            <Button variant="ghost" size={touch ? 'touch' : 'sm'} onClick={onWriteOff} data-curing-writeoff={batch.batchNo}>
              Write off
            </Button>
          </span>
        ) : null}
      </div>

      {/* Why this row has no button, in the row's own words. Kept out of the button
          column, where a sentence this long pushed the buttons off a phone screen. */}
      {canMove && refusal !== null ? (
        <p className="text-xs text-ink3" data-curing-problem={batch.batchNo}>
          {refusal}
        </p>
      ) : null}
    </li>
  );
}
