import { useEffect, useState } from 'react';
import type { Product, ProductRoute } from '@/core/types';
import { ROUTE_LABELS, patchProduct, UNIT_OPTIONS } from '@/data/productRepo';
import { unitLabel } from '@/core/format';
import { Button, Chip, Field, Modal, NumberInput, Select, TextInput, Toggle } from '@/ui/primitives';

/**
 * One product, everything about it.
 *
 * The table is for scanning and quick edits; the drawer is where a product's
 * setup gets written down properly — the notes in particular explain *why* a
 * target is what it is, which is the thing people forget by the next Monday.
 */
export interface DrawerPosition {
  stockReal: number;
  inclCuringBlasted: number;
  toGetToTarget: number;
  demand: number;
  lines: number;
  earliest: number | null;
}

export function ProductDrawer({
  product,
  position,
  defaultCureDays,
  onClose,
  readOnly = false,
}: {
  product: Product | null;
  position: DrawerPosition | null;
  defaultCureDays: number;
  onClose: () => void;
  /** A viewer may read a product but has nothing to save. */
  readOnly?: boolean;
}) {
  // Draft state so a half-typed number cannot land in the database on a blur
  // caused by closing the drawer.
  const [draft, setDraft] = useState<Product | null>(product);
  useEffect(() => setDraft(product), [product]);

  if (!draft) return null;

  const set = (patch: Partial<Product>): void => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const save = (): void => {
    if (readOnly) return;
    void patchProduct(draft.code, {
      enabled: draft.enabled,
      route: draft.route,
      unit: draft.unit,
      usesBaseline10000: draft.usesBaseline10000,
      trayYield: draft.trayYield,
      target: draft.target,
      cureDays: draft.cureDays,
      notes: draft.notes,
    });
    onClose();
  };

  const unit = UNIT_OPTIONS.find((u) => u.value === draft.unit);
  const unitChoices =
    unit == null ? [...UNIT_OPTIONS, { value: draft.unit, label: draft.unit || 'Custom' }] : UNIT_OPTIONS;

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={draft.code}
      subtitle={draft.description || 'No description in the export'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {readOnly ? (
            <Chip tone="neutral" title="A viewer reads the board and changes nothing on it.">
              Read only
            </Chip>
          ) : (
            <Button variant="primary" icon="save" onClick={save}>
              Save product
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {position ? (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={position.stockReal < 0 ? 'short' : 'neutral'}>
              On hand {position.stockReal.toLocaleString('en-AU')} {unitLabel(draft.unit)}
            </Chip>
            <Chip tone={position.toGetToTarget > 0 ? 'short' : 'curing'}>
              To target {position.toGetToTarget.toLocaleString('en-AU')}
            </Chip>
            <Chip tone="info">
              Open jobs {position.lines} · {position.demand.toLocaleString('en-AU')}
            </Chip>
            {draft.seenInJobs ? <Chip tone="info">In the sales export</Chip> : null}
          </div>
        ) : null}

        <Toggle
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
          label="Current product"
          hint="Only current products appear in the matrix and in planning."
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Made how" hint="Shotblast items get an extra step before MYOB.">
            <Select
              value={draft.route}
              onChange={(e) => set({ route: e.target.value as ProductRoute })}
              options={(Object.keys(ROUTE_LABELS) as ProductRoute[]).map((r) => ({
                value: r,
                label: ROUTE_LABELS[r],
              }))}
            />
          </Field>

          <Field label="Unit" hint="What MYOB and the job quantities are counted in.">
            <Select
              value={draft.unit}
              onChange={(e) => set({ unit: e.target.value })}
              options={unitChoices}
            />
          </Field>

          <Field label={`Per tray (${unitLabel(draft.unit)})`} hint="Trays entered on the floor × this = quantity.">
            <NumberInput
              value={draft.trayYield}
              min={0}
              step="any"
              onValueChange={(v) => set({ trayYield: v ?? 0 })}
            />
          </Field>

          <Field label={`Target stock (${unitLabel(draft.unit)})`} hint="Drives TO GET TO TARGET.">
            <NumberInput value={draft.target} min={0} step="any" onValueChange={(v) => set({ target: v ?? 0 })} />
          </Field>

          <Field
            label="Cure days"
            hint={
              draft.cureDays === defaultCureDays
                ? 'Same as the default in Settings.'
                : `Default in Settings is ${defaultCureDays}.`
            }
          >
            <NumberInput value={draft.cureDays} min={0} step="1" onValueChange={(v) => set({ cureDays: v ?? 0 })} />
          </Field>

          <Field label="MYOB baseline" hint="MYOB holds this item as actual + 10000.">
            <div className="pt-1">
              <Toggle
                checked={draft.usesBaseline10000}
                onChange={(usesBaseline10000) => set({ usesBaseline10000 })}
                label="Subtract the phantom 10000"
              />
            </div>
          </Field>
        </div>

        <Field label="Notes" hint="Anything the next person needs to know about this product.">
          <TextInput
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="e.g. only made to order, no target"
          />
        </Field>
      </div>
    </Modal>
  );
}
