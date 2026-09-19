import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCan } from '@/app/session';
import { useIsCoarsePointer, useIsCompact } from '@/app/useMediaQuery';
import { readyAt } from '@/core/calc';
import { formatNumber, formatQty } from '@/core/format';
import {
  blastCureWords,
  blastLists,
  blastPreview,
  blastProblem,
  blastSummary,
} from '@/core/shotblast';
import { blastOutstanding } from '@/core/curing';
import type { Batch, ProductUnit, Settings } from '@/core/types';
import { finishBlast, racksAwaitingBlast, startBlast } from '@/data/batchRepo';
import { db, getSettings } from '@/data/db';
import { Button, Card, Chip, EmptyState, Field, Modal, NumberInput, toast } from '@/ui/primitives';

/**
 * The shotblast queue.
 *
 * This is the booth's screen, and it asks one thing: *which racks still owe time
 * in the blaster?* Everything else about a shotblast make — how long it cures,
 * when it can be sold — is answered on the Curing screen, from the same
 * `readyAt` the board uses. This screen does not decide readiness. It records
 * what went through the machine.
 *
 * The row has two buttons and they are the physical ones: the rack goes **on the
 * blaster**, and it **comes out**. Marking it in is optional — a shop that only
 * writes down what came out can press *It's done* on the waiting list too — but
 * the machine is then a black box while it is running, which is the one thing
 * whoever is standing next to it wants to see.
 *
 * **Part of it** is the button that surprises people, so the dialog says what it
 * does before it does it: the trays that come out keep the number on the label,
 * and the rest of the rack becomes a new batch with its own number, still
 * waiting. A half-blasted pallet that keeps the old number gets read as blasted
 * next time somebody walks past it.
 */

export function Shotblast() {
  const canRecord = useCan('production.record');
  // Gloved hands on a phone. Both hooks are called on every render — short-circuit
  // the `||` and React tears the screen down. See the same note in Curing.tsx.
  const compact = useIsCompact();
  const coarse = useIsCoarsePointer();
  const touch = compact || coarse;

  const [partOf, setPartOf] = useState<Batch | null>(null);
  const [trays, setTrays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const queue = useLiveQuery(() => racksAwaitingBlast(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const lines = useLiveQuery(() => db.lines.filter((l) => !l.deleted).sortBy('rank'), []);
  // `sortBy('rank')` rather than `toArray()`: the shape Dexie's live query can
  // re-run when the products change. The racks are quick and the 2,691 products
  // are not, so rows wait for the lookups rather than flashing bare codes.
  // Whole range on purpose — a lookup for racks that exist, not the current range.
  // Nothing on this screen lists products by code: it lists racks. See `core/currentRange`.
  const products = useLiveQuery(() => db.products.filter((p) => !p.deleted).sortBy('rank'), []);

  const byCode = useMemo(() => new Map((products ?? []).map((p) => [p.code, p])), [products]);
  const lineName = useMemo(() => new Map((lines ?? []).map((l) => [l.id, l.name])), [lines]);

  const waiting = queue ?? [];
  const loaded = settings !== undefined && lines !== undefined && products !== undefined;
  const lists = blastLists(waiting);
  const summary = blastSummary(waiting);

  async function putOn(batch: Batch) {
    try {
      await startBlast(batch.id);
      toast('info', `${batch.batchNo} on the blaster`, `${formatNumber(batch.trays, 0)} trays in.`);
    } catch (error) {
      toast('short', 'Cannot start that blast', error instanceof Error ? error.message : String(error));
    }
  }

  async function comeOut(batch: Batch) {
    try {
      const { blasted } = await finishBlast(batch.id, batch.trays);
      toast('info', `${batch.batchNo} out of the blaster`, outWords(blasted, await getSettings()));
    } catch (error) {
      toast('short', 'Cannot record that blast', error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmPart() {
    if (partOf === null) return;
    setBusy(true);
    try {
      const { blasted, remainder } = await finishBlast(partOf.id, trays ?? 0);
      const now = await getSettings();
      toast(
        'info',
        `${partOf.batchNo} out with ${formatNumber(blasted.trays, 0)} of ${formatNumber(partOf.trays, 0)}`,
        remainder === null
          ? outWords(blasted, now)
          : `${formatNumber(remainder.trays, 0)} trays are ${remainder.batchNo}, still to be blasted.`,
      );
      setPartOf(null);
      setTrays(null);
    } catch (error) {
      toast('short', 'Cannot record that blast', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function openPart(batch: Batch) {
    // Deliberately empty, not pre-filled with the whole rack: the person typing it
    // is saying that *some* of it came out, and a pre-filled box records the whole
    // rack on a stray Enter.
    setTrays(null);
    setPartOf(batch);
  }

  const description = (code: string): string => byCode.get(code)?.description ?? '';
  const unit = (code: string): ProductUnit | undefined => byCode.get(code)?.unit;
  const lineFor = (id: string): string => lineName.get(id) ?? 'another line';

  if (loaded && waiting.length === 0) {
    return (
      <Card title="The blaster" subtitle="Nothing owes time in the machine.">
        <EmptyState
          icon="blast"
          title="The blaster is clear"
          body="Shotblast makes arrive here when they are logged on Daily entry. Anything that has been blasted is on the Curing screen with the rest of the racks."
        />
      </Card>
    );
  }

  // The dialog's trays box is the question, so an empty box has an answer of its
  // own: `blastProblem` reads `null` as "can this rack be blasted at all", and the
  // button must not be live before a number is in.
  const refusal = partOf === null ? null : blastProblem(partOf, trays ?? 0);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Card
        title="The blaster"
        subtitle={
          summary.onBlaster + summary.waiting === 0
            ? 'Reading the queue.'
            : `${summary.onBlaster} on the machine · ${summary.waiting} waiting · ${formatNumber(summary.trays, 0)} trays`
        }
        actions={
          <>
            {summary.urgent > 0 ? (
              <Chip tone="warn" title="The cure is finished on these. Only the blast is holding them up.">
                {summary.urgent} {summary.urgent === 1 ? 'needs' : 'need'} the blast to finish
              </Chip>
            ) : null}
            {summary.oldestDays > 0 ? (
              <Chip tone="info" title="How long the longest-waiting rack has been waiting, since its cure ended.">
                oldest {summary.oldestDays} d
              </Chip>
            ) : null}
          </>
        }
      >
        <p className="text-sm text-ink2">
          {settings?.production.blastingCompletesCure
            ? 'Blasting stands in for the rest of the cure: a rack that comes out of the machine can be taken off the racks straight away.'
            : 'Blasting runs beside the cure: a rack that comes out of the machine still waits for its cure date.'}
          {!canRecord ? ' Reading the queue is open to everyone. Recording a blast takes a maker or owner sign-in.' : ''}
        </p>
      </Card>

      {lists.blasting.length > 0 ? (
        <Card padded={false} title="On the blaster" subtitle="What is in the machine now. Say when it comes out.">
          <ul className="divide-y divide-line">
            {lists.blasting.map((batch) => (
              <BlastRow
                key={batch.id}
                batch={batch}
                description={description(batch.code)}
                unit={unit(batch.code)}
                line={lineFor(batch.lineId)}
                canRecord={canRecord}
                touch={touch}
                action="out"
                onStart={() => void putOn(batch)}
                onOut={() => void comeOut(batch)}
                onPart={() => openPart(batch)}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      {lists.cureFinished.length + lists.stillCuring.length > 0 ? (
        <Card padded={false} title="Waiting for the blaster" subtitle="The ones the machine still owes, most overdue first.">
          {lists.cureFinished.length > 0 ? (
            <section data-blast-section="cure-done">
              <h3 className="bg-panel2/50 px-3 py-1.5 text-eyebrow font-700 uppercase tracking-wide text-ink3">
                Cure is done — only the blast is left
              </h3>
              <ul className="divide-y divide-line">
                {lists.cureFinished.map((batch) => (
                  <BlastRow
                    key={batch.id}
                    batch={batch}
                    description={description(batch.code)}
                    unit={unit(batch.code)}
                    line={lineFor(batch.lineId)}
                    canRecord={canRecord}
                    touch={touch}
                    action="start"
                    onStart={() => void putOn(batch)}
                    onOut={() => void comeOut(batch)}
                    onPart={() => openPart(batch)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {lists.stillCuring.length > 0 ? (
            <section data-blast-section="still-curing">
              <h3 className="bg-panel2/50 px-3 py-1.5 text-eyebrow font-700 uppercase tracking-wide text-ink3">
                Still curing — it can be blasted beside the cure
              </h3>
              <ul className="divide-y divide-line">
                {lists.stillCuring.map((batch) => (
                  <BlastRow
                    key={batch.id}
                    batch={batch}
                    description={description(batch.code)}
                    unit={unit(batch.code)}
                    line={lineFor(batch.lineId)}
                    canRecord={canRecord}
                    touch={touch}
                    action="start"
                    onStart={() => void putOn(batch)}
                    onOut={() => void comeOut(batch)}
                    onPart={() => openPart(batch)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </Card>
      ) : null}

      <Modal
        open={partOf !== null}
        onClose={() => {
          setPartOf(null);
          setTrays(null);
        }}
        width="sm"
        title={`How much of ${partOf?.batchNo ?? ''} came out?`}
        subtitle="Count the trays that went through. Whatever is left gets its own number and waits for the next run."
        footer={
          <>
            <Button
              variant="ghost"
              size={touch ? 'touch' : 'md'}
              onClick={() => {
                setPartOf(null);
                setTrays(null);
              }}
            >
              Leave it alone
            </Button>
            <Button
              variant="primary"
              size={touch ? 'touch' : 'md'}
              disabled={refusal !== null || busy}
              onClick={() => void confirmPart()}
            >
              Out of the blaster
            </Button>
          </>
        }
      >
        {partOf !== null ? (
          <>
            <Field
              label="Trays that went through"
              hint={`${formatNumber(partOf.trays, 0)} trays · ${formatQty(partOf.qty, unit(partOf.code))} on this rack.`}
            >
              <NumberInput
                autoFocus
                value={trays}
                onValueChange={setTrays}
                min={1}
                step={1}
                inputMode="numeric"
                aria-label="How many trays went through the blaster"
                data-blast-trays=""
              />
            </Field>
            <p
              className="mt-3 text-sm"
              data-blast-outcome={refusal === null ? 'ok' : 'problem'}
            >
              {refusal === null
                ? blastPreview(partOf, trays ?? 0)
                : refusal}
            </p>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

/** What to tell the floor after a whole rack came out. */
function outWords(blasted: Batch, settings: Settings): string {
  // The same `readyAt` the Curing screen and the board read, so the toast cannot
  // promise a rack is usable when the cure screen is about to refuse to move it.
  const at = readyAt(blasted, settings);
  return at === null
    ? `All ${formatNumber(blasted.trays, 0)} trays blasted. Back on the racks to finish curing.`
    : `All ${formatNumber(blasted.trays, 0)} trays blasted. It can come off the racks now.`;
}

function BlastRow({
  batch,
  description,
  unit,
  line,
  canRecord,
  touch,
  action,
  onStart,
  onOut,
  onPart,
}: {
  batch: Batch;
  description: string;
  unit: ProductUnit | undefined;
  line: string;
  canRecord: boolean;
  touch: boolean;
  /** Which primary button this row offers: onto the machine, or off it. */
  action: 'start' | 'out';
  onStart: () => void;
  onOut: () => void;
  onPart: () => void;
}) {
  const outstanding = blastOutstanding(batch);
  const partial = batch.blastedQty > 0;

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2" data-blast-rack={batch.batchNo}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-[13ch] shrink-0 font-mono text-xs text-ink3">{batch.batchNo}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-650">{batch.code}</span>
          <span className="text-ink3"> {description}</span>
        </span>
        {partial ? <Chip tone="warn">Part blasted</Chip> : null}
        <Chip tone={batch.stage === 'blasting' ? 'info' : 'warn'}>
          {batch.stage === 'blasting' ? 'On the blaster' : 'Needs blast'}
        </Chip>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-ink3">{line}</span>
        <span className="text-sm tabular-nums">
          {formatNumber(batch.trays, 0)} trays
          <span className="text-ink3"> · {formatQty(batch.qty, unit)}</span>
        </span>
        <span className="text-xs text-ink3">{blastCureWords(batch)}</span>
        {partial ? (
          // The outstanding amount is a quantity, not a tray count — a rack can be
          // weighed rather than counted — so it is stated with its unit.
          <span className="text-xs text-warn">
            {formatQty(outstanding, unit)} still to go
          </span>
        ) : null}
        {canRecord ? (
          // In the order the floor does it: the next step, then the step that skips
          // ahead, and the dialog last, because it is the one that needs a number
          // typed rather than a press.
          <span className="ml-auto flex items-center gap-1.5">
            {action === 'start' ? (
              <Button variant="primary" size={touch ? 'touch' : 'sm'} onClick={onStart} data-blast-start={batch.batchNo}>
                On the blaster
              </Button>
            ) : (
              <Button variant="primary" size={touch ? 'touch' : 'sm'} onClick={onOut} data-blast-out={batch.batchNo}>
                It&apos;s done
              </Button>
            )}
            {action === 'start' ? (
              <Button variant="ghost" size={touch ? 'touch' : 'sm'} onClick={onOut} data-blast-out={batch.batchNo}>
                It&apos;s done
              </Button>
            ) : null}
            <Button variant="ghost" size={touch ? 'touch' : 'sm'} onClick={onPart} data-blast-part={batch.batchNo}>
              Part of it
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}
