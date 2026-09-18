import { useEffect, useState } from 'react';
import { Chip } from '@/ui/primitives';
import { detectStore, forgetStoreProbe, type ServerHealth } from '@/data/serverStore';

/**
 * Which machine this device is actually talking to.
 *
 * There are two answers now — a GitHub repository, or a box the shop owns — and the
 * app picks between them by asking the machine it is standing on, once, at start-up.
 * That is the right rule for a build that has to work in both places, and it is also
 * the kind of automatic decision that wastes an hour if it is invisible: two people
 * looking at two screens, one of them pointing at a repository that has not been
 * written to in weeks.
 *
 * So the answer is said out loud, in the card where the repository is configured,
 * where anybody come-looking for this would already be looking.
 */
export function StoreLine() {
  const [health, setHealth] = useState<ServerHealth | null | 'probing'>('probing');

  useEffect(() => {
    let live = true;
    void detectStore().then((answer) => {
      if (live) setHealth(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  if (health === 'probing') return null;

  if (health) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink2">
        <Chip tone="curing">Shop server</Chip>
        <span className="min-w-0 max-w-[62ch]">
          This device reads and writes the shop&apos;s own machine, version {health.version} — the repository
          settings below are not used here, and the numbers on screen do not go to GitHub.
        </span>
        <button
          type="button"
          className="text-ink3 underline decoration-dotted"
          onClick={() => {
            setHealth('probing');
            forgetStoreProbe();
            void detectStore().then((answer) => setHealth(answer));
          }}
        >
          Ask again
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink3">
      <Chip tone="neutral">GitHub repository</Chip>
      <span className="min-w-0 max-w-[62ch]">
        No shop server answered here, so this device uses the repository below.
      </span>
    </div>
  );
}
