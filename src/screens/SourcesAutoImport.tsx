/**
 * The card that answers "did MYOB's numbers get in yet?"
 *
 * Two halves, because the question has two parts: what the shop decided (how
 * often to look, which paths, whether to look at all) and what actually happened
 * (this file, at this time, with this many rows — or the reason it did not).
 *
 * The reason it is its own file rather than another block in `Sources.tsx` is the
 * jsdom test: the interesting behaviour is this card's, and dragging the whole
 * sources screen — with its two virtualised grids — into a test to check a status
 * chip would cost more than it is worth.
 */

import { useState } from 'react';
import { runExportCheck } from '@/app/exportWatch';
import { formatClock, formatSince } from '@/core/dates';
import { formatNumber } from '@/core/format';
import type { ExportAutoImport, Settings } from '@/core/types';
import { saveSettings } from '@/data/db';
import type { ExportKind, ExportState, ExportStateMap, ExportStatus } from '@/data/exportSync';
import { Icon } from '@/ui/Icon';
import { Button, Card, Chip, Field, Select, TextInput, Toggle, toast, type Tone } from '@/ui/primitives';

const KIND_TITLE: Record<ExportKind, string> = {
  location: 'Stock export',
  future: 'Future jobs',
};

const STATUS_CHIP: Record<ExportStatus, { label: string; tone: Tone }> = {
  never: { label: 'Not checked', tone: 'neutral' },
  imported: { label: 'Imported', tone: 'curing' },
  unchanged: { label: 'Up to date', tone: 'neutral' },
  failed: { label: 'Could not import', tone: 'short' },
  missing: { label: 'File not found', tone: 'warn' },
};

const INTERVALS = [5, 10, 15, 30, 60];

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  return bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function stateLine(state: ExportState): string {
  const bits: string[] = [];
  if (state.status === 'imported' || state.status === 'unchanged') {
    if (state.rows != null) bits.push(`${formatNumber(state.rows, 0)} rows`);
    const size = formatBytes(state.bytes);
    if (size) bits.push(size);
  } else {
    bits.push(state.detail);
  }
  if (state.importedAt != null) bits.push(`in at ${formatClock(state.importedAt)}`);
  bits.push(`checked ${formatSince(state.checkedAt)}`);
  return bits.filter(Boolean).join(' · ');
}

export function AutoImportCard({
  settings,
  states,
  canWrite,
}: {
  settings: Settings;
  states: ExportStateMap;
  canWrite: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const config = settings.sources.exports;

  // saveSettings deep-merges and does the read-modify-write inside one IndexedDB
  // transaction, so an interval change and a path change a moment apart cannot
  // erase each other.
  const patch = (next: Partial<ExportAutoImport>) => {
    void saveSettings({ sources: { exports: next } }).catch((error: unknown) => {
      toast('warn', 'That change did not save', error instanceof Error ? error.message : String(error));
    });
  };

  const checkNow = () => {
    setChecking(true);
    void runExportCheck({ force: true })
      .catch((error: unknown) => {
        toast('warn', 'The check failed', error instanceof Error ? error.message : String(error));
      })
      .finally(() => setChecking(false));
  };

  return (
    <Card
      title="Automatic import"
      subtitle={
        config.autoImport
          ? `Checks the repository about every ${config.intervalMinutes} min while this app is open and online.`
          : 'Switched off: the two exports get imported by hand, onto this screen.'
      }
      actions={
        canWrite ? (
          <Button icon="refresh" variant="ghost" loading={checking} onClick={checkNow}>
            Check now
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        {canWrite ? (
          <div className="flex flex-wrap items-end gap-3">
            <Toggle
              checked={config.autoImport}
              onChange={(on) => patch({ autoImport: on })}
              label="Pull the exports from the repository"
              hint="Reads the two files in the data repository and imports whichever changed."
              disabled={!canWrite}
            />
            <Field label="How often" className="w-32">
              <Select
                value={String(config.intervalMinutes)}
                options={INTERVALS.map((m) => ({ value: String(m), label: m === 60 ? 'Hourly' : `Every ${m} min` }))}
                onChange={(e) => patch({ intervalMinutes: Number(e.currentTarget.value) })}
              />
            </Field>
          </div>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          {(['location', 'future'] as const).map((kind) => {
            const state = states[kind];
            const chip = STATUS_CHIP[state.status];
            const path = kind === 'location' ? config.locationPath : config.futurePath;
            return (
              <div
                key={kind}
                className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel2/40 p-2.5"
                data-export-kind={kind}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.72rem] font-650 uppercase tracking-wide text-ink3">{KIND_TITLE[kind]}</span>
                  <Chip tone={chip.tone} title={state.detail}>
                    {chip.label}
                  </Chip>
                </div>
                {canWrite ? (
                  <Field label="Path in the repository">
                    <TextInput
                      value={path}
                      spellCheck={false}
                      onChange={(e) =>
                        patch(kind === 'location' ? { locationPath: e.currentTarget.value } : { futurePath: e.currentTarget.value })
                      }
                    />
                  </Field>
                ) : (
                  <span className="font-mono text-xs text-ink3">{path}</span>
                )}
                <span className="flex items-center gap-1.5 text-xs text-ink3">
                  {state.status === 'failed' || state.status === 'missing' ? (
                    <Icon name="alert" className="size-3.5 text-short" />
                  ) : null}
                  {stateLine(state)}
                </span>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-ink3">
          There is no server, so the shop's numbers arrive when an app is open on a device that holds the repository
          token. A laptop that stayed shut over the weekend imports on Monday morning as soon as it is opened — and a
          file that failed to import is retried at the next check rather than marked as seen.
        </p>
      </div>
    </Card>
  );
}
