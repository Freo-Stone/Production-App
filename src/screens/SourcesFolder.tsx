/**
 * "Has this computer got a MYOB export, and did it tell the shop?"
 *
 * The other half of the same bar as `SourcesAutoImport.tsx`: that one is about files
 * arriving *from* the repository, this one is about a file leaving *from the folder
 * on this machine's own disk*. It sits on the same screen because they are two ends
 * of one thing, and a person standing at the machine that exported the workbook is
 * the only person who can start it.
 *
 * It is a line with a Details panel for the same reason the import line is: the
 * screen is opened to read a table. What earns its space on the line is the answer
 * to the question the person actually has — is this computer watching, and did the
 * file go out — and everything else (the two file names, how old a file may be,
 * which file to use when the folder does not match the name in Settings) is behind
 * one click.
 *
 * Every state has its own sentence because every state has a different thing to do
 * about it, and three of them can only be fixed by a hand on this keyboard: pointing
 * the browser at the folder, clicking once after a restart, and telling MYOB to save
 * into that folder in the first place.
 */

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { runFolderLook } from '@/app/folderWatch';
import { formatClock } from '@/core/dates';
import { FOLDER_EXPORT_KINDS, folderRules, type FolderExportKind } from '@/core/folderSource';
import type { ExportFolderWatch, Settings } from '@/core/types';
import { db, saveSettings } from '@/data/db';
import {
  chooseFolder,
  folderStatus,
  forgetFolder,
  requestAccess,
  supportsFolders,
  type FolderAccessState,
  type FolderAccessStatus,
} from '@/data/folderAccess';
import { FOLDER_REPORT_KEY, type FolderOutcome, type FolderRun } from '@/data/folderPublish';
import { Button, Chip, Field, NumberInput, TextInput, toast, type Tone } from '@/ui/primitives';

const KIND_TITLE: Record<FolderExportKind, string> = {
  location: 'Stock file',
  future: 'Jobs file',
};

const ACCESS_CHIP: Record<FolderAccessState, { label: string; tone: Tone }> = {
  unsupported: { label: 'Cannot watch folders', tone: 'neutral' },
  none: { label: 'No folder yet', tone: 'warn' },
  'needs-a-click': { label: 'Waiting for one click', tone: 'warn' },
  denied: { label: 'Folder refused', tone: 'short' },
  ready: { label: 'Watching', tone: 'curing' },
};

const OUTCOME_CHIP: Record<FolderOutcome['action'], { label: string; tone: Tone }> = {
  published: { label: 'Sent', tone: 'curing' },
  unchanged: { label: 'Nothing new', tone: 'neutral' },
  missing: { label: 'Not in the folder', tone: 'warn' },
  'needs-a-name': { label: 'Named differently', tone: 'warn' },
  refused: { label: 'Held back', tone: 'warn' },
  failed: { label: 'Could not send', tone: 'short' },
};

/** The one paragraph a browser that cannot see folders, or a computer that has never
been shown one, actually needs. */
function quietPanel(state: FolderAccessState) {
  return (
    <span data-folder-details className="basis-full rounded-lg border border-line bg-panel2/40 p-2.5 text-xs text-ink2">
      {state === 'unsupported' ? (
        <>
          Only <b className="font-650">Chrome</b> and <b className="font-650">Edge</b> can read a folder from a web
          page — Firefox and Safari will not let any website see a disk. Nothing is broken: open the app in Chrome or
          Edge on the computer that runs MYOB, and everything else carries on importing from the repository as usual.
        </>
      ) : (
        <>
          The computer that exports MYOB can send the file to the shop itself: point this app at the folder MYOB saves
          into and it notices a new workbook within a minute, uses it here and passes it to the other computers. Nothing
          else changes — a computer that cannot see the folder carries on taking the exports out of the repository.
        </>
      )}
    </span>
  );
}

export function FolderWatchLine({
  settings,
  canWrite,
  variant = 'bar',
}: {
  settings: Settings;
  canWrite: boolean;
  /**
   * `bar` is the line at the top of Data sources; `card` is the block on Settings,
   * which is where the watch is set up. They differ in one thing only: a bar on the
   * data screen is silent until there is something to say, because that screen's
   * room belongs to the table (`e2e/layout.spec.ts` measures it), while the Settings
   * block always shows itself — it is the only way to find the feature at all.
   */
  variant?: 'bar' | 'card';
}) {
  const rules = folderRules(settings);
  // The last look, out of the database rather than out of memory: the watch runs
  // while other screens are up, and this line has to say what happened then.
  const reportRow = useLiveQuery(() => db.meta.get(FOLDER_REPORT_KEY), []);
  const report = (reportRow?.value ?? null) as FolderRun | null;
  const [access, setAccess] = useState<FolderAccessStatus>(() => ({
    state: supportsFolders() ? 'none' : 'unsupported',
    folderName: '',
    detail: supportsFolders() ? 'This computer has not been shown a folder yet.' : 'This browser cannot open a folder.',
  }));
  const [busy, setBusy] = useState<string | null>(null);
  const [details, setDetails] = useState(false);

  const refresh = () => {
    void folderStatus()
      .then(setAccess)
      .catch((error: unknown) => {
        setAccess({
          state: 'denied',
          folderName: '',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  };

  useEffect(refresh, [report?.at]);

  const patch = (next: Partial<ExportFolderWatch>) => {
    // saveSettings deep-merges inside one transaction, so the two file names and the
    // interval cannot overwrite each other when they are changed a moment apart.
    void saveSettings({ sources: { exports: { folder: next } } }).catch((error: unknown) => {
      toast('warn', 'That change did not save', error instanceof Error ? error.message : String(error));
    });
  };

  const act = (what: 'choose' | 'again' | 'look' | 'forget', run: () => Promise<unknown>) => {
    setBusy(what);
    void run()
      .catch((error: unknown) => {
        // The browser's own "you said no" is not a fault worth a toast; the chip
        // already says it. Anything else is, because it is the only notice they get.
        if (error instanceof Error && error.name === 'AbortError') return;
        toast('warn', 'The folder', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  const chip = ACCESS_CHIP[access.state];
  const watching = access.state === 'ready' && rules.enabled;
  const published = report?.looks.filter((l) => l.outcome.action === 'published').length ?? 0;

  // A thing that is switched off does not get to take a row away from the table.
  // Before this computer has ever been shown a folder, and on a browser that never
  // can be, the whole line is a chip, the one button that exists, and Details — and
  // at phone width even that is withheld, because there is no folder to pick on a
  // phone and the explanation is a desktop's problem. `docs/screens/sources.md`
  // measures what this screen is allowed to spend; `e2e/layout.spec.ts` enforces it.
  const quiet = report == null && (access.state === 'none' || access.state === 'unsupported');
  // In a card the row starts at the left; in the bar it hugs the right edge.
  const rowClass = variant === 'card'
    ? 'flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs'
    : 'flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1.5 text-xs';

  if (quiet && variant === 'bar') return null;

  if (quiet) {
    return (
      <span
        data-folder-watch
        data-folder-quiet
        data-folder-state={access.state}
        className={variant === 'card' ? 'flex min-w-0 flex-wrap items-center gap-1.5 text-xs' : 'flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-xs'}
      >
        <Chip tone={chip.tone} title={access.detail}>
          {chip.label}
        </Chip>
        {access.state === 'none' && canWrite ? (
          <Button size="sm" icon="sources" loading={busy === 'choose'} onClick={() => act('choose', () => chooseFolder().then((next) => {
            setAccess(next);
            if (next.state === 'ready') patch({ enabled: true });
          }))}>
            Choose the folder
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
          Details
        </Button>
        {details ? quietPanel(access.state) : null}
      </span>
    );
  }

  return (
    <span data-folder-watch className={rowClass}>
      <span data-folder-state={access.state} className="flex min-w-0 items-center gap-1.5">
        <Chip tone={chip.tone} icon={access.state === 'ready' ? undefined : 'alert'} title={access.detail}>
          {chip.label}
        </Chip>
        <span className="min-w-0 max-w-[46ch] truncate text-ink3" title={access.detail}>
          {access.state === 'ready'
            ? rules.enabled
              ? // The folder's own name, because there may be three "exports" folders on
                // a shop server and this sentence is how you tell which one this is.
                <>
                  watching <b className="font-650 text-ink">{access.folderName ?? 'the folder'}</b> every{' '}
                  <b className="font-650 text-ink">{rules.intervalMinutes} min</b>
                </>
              : 'folder is set, watching is off'
            : access.detail}
        </span>
      </span>

      {/* The answer to the question, on the line, not behind the click. */}
      {report != null && published > 0 ? (
        <span data-folder-last-publish className="text-ink3">
          last sent <b className="font-650 text-ink">{formatClock(report.at)}</b>
        </span>
      ) : null}

      {access.state === 'none' || access.state === 'denied' ? (
        canWrite && supportsFolders() ? (
          <Button size="sm" icon="sources" loading={busy === 'choose'} onClick={() => act('choose', () => chooseFolder().then((next) => {
            setAccess(next);
            if (next.state === 'ready') patch({ enabled: true });
          }))}>
            Choose the folder
          </Button>
        ) : null
      ) : null}

      {access.state === 'needs-a-click' ? (
        <Button size="sm" icon="download" loading={busy === 'again'} onClick={() => act('again', () => requestAccess().then(setAccess))}>
          Let this app read it
        </Button>
      ) : null}

      {/* Nothing here is offered to a viewer. The data layer would refuse every one
          of these, and a button that only produces an error is worse than no button. */}
      {watching && canWrite ? (
        <>
          <Button size="sm" icon="refresh" variant="ghost" loading={busy === 'look'} onClick={() => act('look', () => runFolderLook({ force: true }))}>
            Look now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => patch({ enabled: false })}>
            Pause
          </Button>
        </>
      ) : null}

      {!rules.enabled && access.state === 'ready' && canWrite ? (
        <Button size="sm" variant="ghost" onClick={() => patch({ enabled: true })}>
          Start watching
        </Button>
      ) : null}

      <Button size="sm" variant="ghost" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
        Details
      </Button>

      {details ? (
        <span data-folder-details className="flex basis-full flex-col gap-3 border-t border-line pt-2.5">
          {access.state === 'unsupported' ? (
            <span className="rounded-lg border border-line bg-panel2/40 p-2.5 text-xs text-ink2">
              Only <b className="font-650">Chrome</b> and <b className="font-650">Edge</b> can read a folder from a web
              page — Firefox and Safari will not let any website see a disk. Nothing is broken: open the app in Chrome or
              Edge on the computer that runs MYOB, and everything else carries on importing from the repository as usual.
            </span>
          ) : null}

          <span className="grid gap-2 sm:grid-cols-2">
            {FOLDER_EXPORT_KINDS.map((kind) => {
              const look = report?.looks.find((l) => l.kind === kind);
              const outcome = look?.outcome;
              const chip2 = outcome == null ? { label: 'Not looked yet', tone: 'neutral' as Tone } : OUTCOME_CHIP[outcome.action];
              return (
                <span key={kind} data-folder-kind={kind} className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel2/40 p-2.5">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-eyebrow font-650 uppercase tracking-wide text-ink3">{KIND_TITLE[kind]}</span>
                    <Chip tone={chip2.tone}>{chip2.label}</Chip>
                  </span>
                  <span className="text-xs text-ink2">
                    {outcome == null
                      ? rules.enabled
                        ? 'This computer has not looked at the folder yet.'
                        : 'Watching is off on this computer.'
                      : outcome.detail}
                  </span>
                  {outcome?.action === 'needs-a-name' && canWrite ? (
                    // Never used on its own: a wrong guess here overwrites the wrong
                    // mirror on every computer at once, so this is a question.
                    <span className="flex flex-wrap gap-1.5">
                      {outcome.candidates.slice(0, 3).map((candidate) => (
                        <Button
                          key={candidate.name}
                          size="sm"
                          data-folder-candidate={candidate.name}
                          onClick={() => {
                            patch(kind === 'location' ? { locationFile: candidate.name } : { futureFile: candidate.name });
                            void runFolderLook({ force: true });
                          }}
                        >
                          Use {candidate.name}
                        </Button>
                      ))}
                    </span>
                  ) : null}
                  {canWrite ? (
                    <Field label="Name this computer looks for" hint="Exactly as MYOB saves it, in the folder you chose.">
                      <TextInput
                        defaultValue={rules.names[kind]}
                        onBlur={(event) => {
                          const next = event.currentTarget.value.trim();
                          if (next === rules.names[kind]) return;
                          patch(kind === 'location' ? { locationFile: next } : { futureFile: next });
                        }}
                      />
                    </Field>
                  ) : null}
                </span>
              );
            })}
          </span>

          <span className="grid gap-2 sm:grid-cols-[max-content_1fr] sm:items-center">
            {canWrite ? (
              <Field label="How old a file may be" hint="Anything older than this is left alone. A file from last week is not today's stock, however it got into the folder.">
                <NumberInput
                  value={settings.sources.exports.folder.maxAgeHours}
                  unit="hours"
                  min={1}
                  max={336}
                  onValueChange={(n) => {
                    if (n != null && n >= 1) patch({ maxAgeHours: Math.round(n) });
                  }}
                />
              </Field>
            ) : null}
            <span className="text-xs text-ink3">
              This is a choice for <b className="font-650">this computer only</b>, like its name and its token. Another
              computer that cannot see the folder carries on taking the exports from the repository, which is where this
              one puts them. Nothing here is needed for the app to work: it is how the newest numbers get to the others
              without anyone emailing a file.
            </span>
          </span>

          {access.state === 'ready' && rules.enabled ? (
            <span className="text-xs text-ink3">
              A file is sent once its size and write time have stopped moving, so MYOB writing it, or OneDrive still
              downloading it, cannot put half a workbook in front of the shop. That costs about one minute between the
              export and the other computers seeing it.
            </span>
          ) : null}

          {canWrite && access.state !== 'none' ? (
            <span className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink3">
                {access.folderName === '' ? 'No folder remembered.' : `Remembered: ${access.folderName}`}
              </span>
              <Button size="sm" variant="ghost" icon="trash" loading={busy === 'forget'} onClick={() => act('forget', () => forgetFolder().then(folderStatus))}>
                Forget this folder
              </Button>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
