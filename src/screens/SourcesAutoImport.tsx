/**
 * The line that answers "did MYOB's numbers get in yet?"
 *
 * It is a line and not a card, on purpose. The screen is opened to read a table,
 * and a framed card with two file panels and a paragraph about the lack of a
 * server took 280px of a 720px window to say "both files came in this morning".
 * The line says that; Details says the rest.
 *
 * The reason it is its own file rather than another block in `Sources.tsx` is the
 * jsdom test: the interesting behaviour is this line's, and dragging the whole
 * sources screen — with its two virtualised grids — into a test to check a status
 * chip would cost more than it is worth.
 */

import { useState } from 'react';
import { navigate } from '@/app/router';
import { runExportCheck } from '@/app/exportWatch';
import { formatClock, formatSince } from '@/core/dates';
import { formatNumber } from '@/core/format';
import type { ExportAutoImport, Settings } from '@/core/types';
import { saveSettings } from '@/data/db';
import { EXPORT_KINDS, type ExportKind, type ExportState, type ExportStateMap, type ExportStatus } from '@/data/exportSync';
import { Icon } from '@/ui/Icon';
import { Button, Chip, Field, Select, TextInput, Toggle, toast, type Tone } from '@/ui/primitives';

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

/** The file's name without the folder, for the one-line summary. */
function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * What the line itself carries. The row counts are on the facts at the left of
 * the same bar, so repeating them here would spend room the reason for the line
 * does not need: when the file arrived, or what went wrong.
 */
function briefLine(state: ExportState): string {
  // Nothing to add when it has never looked: the chip beside it already says
  // "Not checked", and the room on this line is the whole reason it is a line.
  if (state.checkedAt == null) return '';
  if (state.status === 'imported' || state.status === 'unchanged') return formatSince(state.checkedAt);
  return state.detail;
}

/** Everything, once Details is open: size and arrival time as well. */
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

export function AutoImportBar({
  settings,
  states,
  canWrite,
  blocker = null,
}: {
  settings: Settings;
  states: ExportStateMap;
  canWrite: boolean;
  /** Why this device cannot check, or `null` when it can. See `exportBlockerReason`. */
  blocker?: string | null;
}) {
  const [checking, setChecking] = useState(false);
  const [details, setDetails] = useState(false);
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
    <span
      data-auto-import
      className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1.5 text-xs"
    >
      {canWrite ? (
        <Toggle checked={config.autoImport} onChange={(on) => patch({ autoImport: on })} label={config.autoImport ? 'On' : 'Off'} />
      ) : null}
      <span className="text-ink3">
        {/* The switch beside it says what this is about; on a phone the words
            would only push the two file chips onto another line. */}
        <span className="hidden sm:inline">Automatic import </span>
        <b className="font-650 text-ink">
          {config.autoImport ? `every ${config.intervalMinutes} min` : 'off, imported by hand'}
        </b>
      </span>

      {/* The switch says it is on, the two chips say nothing happened, and until
          this sentence existed the screen offered no third thing: the reason. A
          device that is switched on, online and entitled but has never been handed a
          token sits here forever, and it looked like the app was broken. */}
      {blocker ? (
        // One control, not a sentence and a button: this row shares its line with the
        // table, and on a phone every wrapped line is a row of stock that is not
        // visible. The reason and the way out are the same words.
        <span data-auto-import-blocker className="flex min-w-0 items-center gap-1.5">
          <Chip tone="warn" icon="alert" title="Automatic import cannot run on this device">
            Not checking
          </Chip>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate('/settings')}
            // Truncated, not wrapped and not left to push: a sentence this long is
            // wider than a phone, and the screen must not gain a sideways scroll
            // because the app is finally explaining itself. The whole reason is in
            // the title and, in full, under Details.
            className="max-w-[26ch] truncate"
            title={`${blocker} — set it on the Settings screen`}
          >
            {blocker} — Settings
          </Button>
        </span>
      ) : null}

      {/* One per file: enough to answer "did it come in" without opening anything. */}
      {EXPORT_KINDS.map((kind) => {
        const state = states[kind];
        // While this device cannot check at all and has never checked, the reason
        // above is the whole story. Two chips reading "Not checked" say it worse, and
        // the line they wrap onto is room the table wants back.
        if (blocker !== null && state.checkedAt == null) return null;
        const chip = STATUS_CHIP[state.status];
        const path = kind === 'location' ? config.locationPath : config.futurePath;
        return (
          <span key={kind} data-export-kind={kind} className="flex min-w-0 items-center gap-1.5">
            <Chip tone={chip.tone} title={`${KIND_TITLE[kind]}: ${state.detail}`}>
              {chip.label}
            </Chip>
            {/* The file name at a desk, the plainest possible label on a phone,
                where the folder path would cost a line and say less. */}
            <span className="hidden font-mono text-ink3 sm:inline">{fileName(path)}</span>
            <span className="font-mono text-ink3 sm:hidden">{kind === 'location' ? 'Stock' : 'Jobs'}</span>
            {/* A failure sentence is longer than a glance allows; the whole of it
                is in the title, and in Details. */}
            <span className="min-w-0 max-w-[34ch] truncate text-ink3">{briefLine(state)}</span>
          </span>
        );
      })}

      {canWrite ? (
        <Button size="sm" icon="refresh" variant="ghost" loading={checking} onClick={checkNow}>
          Check now
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
        Details
        <Icon name={details ? 'chevronUp' : 'chevronDown'} size={13} />
      </Button>

      {details ? (
        <span data-export-details className="flex basis-full flex-col gap-3 border-t border-line pt-2.5">
          <span className="grid gap-2 sm:grid-cols-2">
            {EXPORT_KINDS.map((kind) => {
              const state = states[kind];
              const chip = STATUS_CHIP[state.status];
              const path = kind === 'location' ? config.locationPath : config.futurePath;
              return (
                <span key={kind} className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel2/40 p-2.5">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-eyebrow font-650 uppercase tracking-wide text-ink3">{KIND_TITLE[kind]}</span>
                    <Chip tone={chip.tone}>{chip.label}</Chip>
                  </span>
                  {canWrite ? (
                    <Field label="Path in the repository">
                      <TextInput
                        value={path}
                        spellCheck={false}
                        onChange={(e) =>
                          patch(
                            kind === 'location' ? { locationPath: e.currentTarget.value } : { futurePath: e.currentTarget.value },
                          )
                        }
                      />
                    </Field>
                  ) : (
                    <span className="font-mono text-xs text-ink3">{path}</span>
                  )}
                  <span className="flex items-center gap-1.5 text-xs text-ink3">
                    {state.status === 'failed' || state.status === 'missing' ? <Icon name="alert" className="size-3.5 text-short" /> : null}
                    {stateLine(state)}
                  </span>
                </span>
              );
            })}
          </span>

          <span className="flex flex-wrap items-end gap-3">
            {/* A viewer is not offered a control that their own write would refuse. */}
            {canWrite ? (
              <Field label="How often" className="w-32">
                <Select
                  value={String(config.intervalMinutes)}
                  options={INTERVALS.map((m) => ({ value: String(m), label: m === 60 ? 'Hourly' : `Every ${m} min` }))}
                  onChange={(e) => patch({ intervalMinutes: Number(e.currentTarget.value) })}
                />
              </Field>
            ) : null}
            {blocker ? (
              <span className="basis-full text-xs text-warn">
                {/* The sentence above is the diagnosis; this one is the fix, so that
                    the screen does not stop at being right. */}
                Nothing can be pulled until that is fixed. On Settings, the repository card
                takes a token for <b className="font-650">Production-App-Data</b> — one that can
                read its contents — and <b className="font-650">Test connection</b> says whether it
                works. Each device needs its own: the token is not part of a login and is never
                sent to the other devices.
              </span>
            ) : null}
            <span className="min-w-40 flex-1 text-xs text-ink3">
              Checked while this app is open and online. There is no server, so a laptop that stayed shut over the
              weekend imports on Monday morning as soon as it is opened. A file that failed to import is tried again at
              the next check rather than marked as seen.
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
