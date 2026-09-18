import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { navigate, setQueryParam, useRoute } from '@/app/router';
import {
  actorsIn,
  filterLedger,
  groupWord,
  familyCounts,
  familyOf,
  groupDays,
  isRackLine,
  LEDGER_FAMILIES,
  ledgerLine,
  shortDevice,
  spanOf,
  summariseDay,
  type LedgerFamily,
} from '@/core/ledger';
import { dayKey, formatClock, formatDayFull, isSameDay } from '@/core/dates';
import { formatNumber } from '@/core/format';
import { deviceLabels } from '@/data/accounts';
import { describeRack } from '@/data/batchRepo';
import { ledgerForBatch, ledgerSize, ledgerWindow } from '@/data/events';
import { deviceId } from '@/data/principal';
import type { IconName } from '@/ui/Icon';
import { Icon } from '@/ui/Icon';
import { Button, Card, Chip, EmptyState, TextInput } from '@/ui/primitives';
import { useIsCoarsePointer, useIsCompact } from '@/app/useMediaQuery';

/**
 * The production log.
 *
 * Eighteen places in this app write a ledger line — making logged, racks moved,
 * parts parted off, blasts, write-offs, stock keyed into MYOB, exports loaded,
 * products changed, accounts and devices, sign-ins. Nothing had ever read one.
 *
 * Two questions get asked here and they are different shapes, so the screen has two
 * modes. **"What happened?"** is a diary: newest first, grouped into days, with a
 * day told by what it was made of, filtered by which part of the shop you care
 * about. **"Who moved this rack?"** is one rack's whole history, and it is reached
 * by pressing *This rack* on a line — not by filtering the newest four hundred lines,
 * because the line you want is usually the one a busy fortnight pushed out.
 *
 * Nothing here can be changed. The log is append-only by design, and a screen that
 * reads it must not offer to edit it.
 */

const FAMILY_ICON: Record<LedgerFamily, IconName> = {
  floor: 'curing',
  myob: 'myob',
  stock: 'sources',
  people: 'user',
  shop: 'cloud',
};

/** How many lines a page is. Big enough to scroll a busy week, small enough to read. */
const PAGE = 400;

/**
 * How many "who did it" chips are shown before the row is folded.
 *
 * A shop with five accounts never sees the fold; one that has been through a dozen
 * casuals would get a wall of names instead of a diary. The rest are one press away
 * and counted on the fold button, because a filter row that quietly stops is worse
 * than one that says where the rest are.
 */
const PEOPLE_CHIPS = 8;

export function ProductionLog() {
  const route = useRoute();
  const rackId = route.query.get('rack');
  const [query, setQuery] = useState('');
  const [families, setFamilies] = useState<LedgerFamily[]>([]);
  const [actor, setActor] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [morePeople, setMorePeople] = useState(false);
  // Gloved hands on a phone. Both hooks are called every render — short-circuiting
  // one of them unmounts the screen. See the note in Curing.tsx.
  const compact = useIsCompact();
  const coarse = useIsCoarsePointer();
  const touch = compact || coarse;

  const lines = useLiveQuery(
    () => (rackId === null || rackId === '' ? ledgerWindow(limit) : ledgerForBatch(rackId)),
    [rackId, limit],
  );
  const total = useLiveQuery(() => ledgerSize(), []);
  // Ledger lines carry the device's id. Names come from People, where the shop gives
  // its tablets names — an id on every line is noise a phone cannot afford.
  const devices = useLiveQuery(() => deviceLabels(), []);
  const here = deviceId();
  const rack = useLiveQuery(
    () => (rackId === null || rackId === '' ? Promise.resolve(null) : describeRack(rackId)),
    [rackId],
  );

  const shown = useMemo(() => lines ?? [], [lines]);
  const counts = useMemo(() => familyCounts(shown), [shown]);
  const allPeople = useMemo(() => actorsIn(shown), [shown]);
  const people = morePeople ? allPeople : allPeople.slice(0, PEOPLE_CHIPS);
  const span = useMemo(() => spanOf(shown), [shown]);
  const visible = useMemo(
    () => filterLedger(shown, { families, query, actor }),
    [shown, families, query, actor],
  );
  const days = useMemo(() => groupDays(visible), [visible]);

  function deviceText(id: string): string {
    const named = devices?.[id];
    if (named === undefined) return shortDevice(id);
    // A tablet the shop has already called "this device" does not need it twice.
    if (id !== here || /^this device$/i.test(named)) return named;
    return `${named} (this device)`;
  }

  const filtering = families.length > 0 || actor !== null || query.trim() !== '';
  const filteredOut = shown.length - visible.length;

  function toggleFamily(key: LedgerFamily): void {
    setFamilies((current) => (current.includes(key) ? current.filter((f) => f !== key) : [...current, key]));
  }

  function clearFilters(): void {
    setFamilies([]);
    setActor(null);
    setQuery('');
  }

  // The first read of the ledger takes a moment on a device with a year in it. Until
  // it lands, saying "nothing matches" or "N lines" would be invented — so the screen
  // says what it is doing, like every other screen here.
  if (lines === undefined || total === undefined) {
    return <Card title="The production log" subtitle="Reading the shop’s lines." />;
  }

  if (total === 0) {
    return (
      <Card title="The production log" subtitle="Every line the shop has written down.">
        <EmptyState
          icon="log"
          title="Nothing logged yet"
          body="Making, moves, blasts, write-offs, stock keyed into MYOB, exports loaded and people signing in all leave a line here. The shop's first day on the app will fill it."
        />
      </Card>
    );
  }

  // The subtitle has to say what is being looked at, and in rack mode the rack's
  // number arrives one query later than the lines do. Until it does, and for a rack
  // whose row is not on this device at all, it says what it knows instead of a name.
  const onlyRack = rackId !== null && rackId !== '';
  const daySpanStart = span === null ? '' : isSameDay(span.from, Date.now()) ? 'today' : formatDayFull(span.from);
  const head = !onlyRack
    ? `${formatNumber(total, 0)} lines on this device${
          // Only say "the newest N back to …" when there really are lines not on
          // screen yet. Otherwise it reads like there is a page of older work the
          // shop has to go and find.
          span === null || shown.length >= total
            ? ''
            : `, the newest ${formatNumber(shown.length, 0)} back to ${daySpanStart}`
      }`
    : rack === undefined
      ? 'Reading this rack’s lines.'
      : rack === null
        ? `Every line about a rack that is not on this device — ${shown.length} of them`
        : `Every line about ${rack.batchNo} (${rack.code}) — ${shown.length} line${shown.length === 1 ? '' : 's'}`;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Card
        title={onlyRack ? 'One rack’s history' : 'The production log'}
        subtitle={head}
        actions={
          onlyRack ? (
            <Button size={touch ? 'touch' : 'sm'} icon="undo" onClick={() => navigate('/log')}>
              Every line
            </Button>
          ) : (
            shown.length < total ? (
              <Chip tone="info" title="The oldest lines are still here. Press Show earlier lines to read back further.">
                showing {formatNumber(shown.length, 0)} of {formatNumber(total, 0)}
              </Chip>
            ) : null
          )
        }
      >
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <span className="sr-only">Search the log</span>
            <TextInput
              data-log-query
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={onlyRack ? 'Search this rack’s lines' : 'A rack number, a reference, a person, a file'}
              className="w-full"
            />
          </label>

          {!onlyRack ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which part of the shop">
              {LEDGER_FAMILIES.map((family) => (
                <Button
                  key={family.key}
                  data-log-family-filter={family.key}
                  size={touch ? 'touch' : 'sm'}
                  active={families.includes(family.key)}
                  aria-pressed={families.includes(family.key)}
                  title={family.hint}
                  onClick={() => toggleFamily(family.key)}
                >
                  {family.label}
                  <span className="text-ink3 tabular-nums">{counts.get(family.key) ?? 0}</span>
                </Button>
              ))}
              {filtering ? (
                <Button data-log-clear size={touch ? 'touch' : 'sm'} icon="undo" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          ) : null}

          {allPeople.length > 1 && !onlyRack ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Who did it">
              {people.map((p) => (
                <Button
                  key={p.name}
                  data-log-actor-filter={p.name}
                  size={touch ? 'touch' : 'sm'}
                  active={actor === p.name}
                  aria-pressed={actor === p.name}
                  title={`${p.count} line${p.count === 1 ? '' : 's'} in what is loaded`}
                  onClick={() => setActor(actor === p.name ? null : p.name)}
                >
                  {p.name}
                  <span className="text-ink3 tabular-nums">{p.count}</span>
                </Button>
              ))}
              {!morePeople && allPeople.length > people.length ? (
                <Button
                  data-log-more-people
                  size={touch ? 'touch' : 'sm'}
                  variant="ghost"
                  onClick={() => setMorePeople(true)}
                >
                  +{allPeople.length - people.length} more
                </Button>
              ) : null}
            </div>
          ) : null}

          {filteredOut > 0 ? (
            <p className="text-xs text-ink3" data-log-filtered>
              {filteredOut} line{filteredOut === 1 ? '' : 's'} hidden by the filter
              {onlyRack ? '' : ' — the oldest lines are not loaded yet, so a count is of what is on screen'}.
            </p>
          ) : null}
        </div>
      </Card>

      {visible.length === 0 ? (
        <Card title="Nothing matches" subtitle="The lines are here, just not these ones.">
          {/* Said as short sentences rather than one long one: the words that follow
              "match" are a search string somebody typed, a name, and group names, and
              braiding all three into a clause produces something no one would say. */}
          <p className="text-sm text-ink2">
            {shown.length} line{shown.length === 1 ? '' : 's'} loaded, and none of them match.
            {query.trim() !== '' ? ` Looking for “${query.trim()}”.` : ''}
            {actor !== null ? ` Only by ${actor}.` : ''}
            {families.length > 0 ? ` Only ${families.map((f) => groupWord(f)).join(', ')}.` : ''}
          </p>
          <div className="pt-3">
            <Button size={touch ? 'touch' : 'sm'} icon="undo" onClick={clearFilters}>
              Clear the filters
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {days.map((day) => (
            <Card
              key={dayKey(day.day)}
              padded={false}
              title={day.label}
              subtitle={summariseDay(day.items, touch ? 'terse' : 'words').join(' · ')}
              actions={
                <Chip title="Lines on this day">{day.items.length}</Chip>
              }
            >
              <ul className="divide-y divide-line">
                {day.items.map((event) => {
                  const family = familyOf(event.action);
                  return (
                    <li
                      key={event.id}
                      data-log-line
                      data-log-family={family}
                      data-log-batch={event.batchId ?? ''}
                      className="flex items-start gap-2.5 px-3 py-2.5"
                    >
                      <span className="w-[3.1rem] shrink-0 pt-0.5 text-xs tabular-nums text-ink3">{formatClock(event.at)}</span>
                      <span className="shrink-0 pt-0.5 text-ink3" aria-hidden="true">
                        <Icon name={FAMILY_ICON[family]} size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{ledgerLine(event)}</span>
                        <span className="block truncate text-xs text-ink3" title={`on ${event.device}`}>
                          {event.actor.trim() === '' ? 'nobody signed in' : event.actor} · {deviceText(event.device)}
                        </span>
                      </span>
                      {isRackLine(event) && !onlyRack ? (
                        <Button
                          size={touch ? 'touch' : 'sm'}
                          onClick={() => setQueryParam('rack', event.batchId)}
                          title="Every line about this rack, however far back"
                        >
                          This rack
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}

          {!onlyRack && shown.length < total ? (
            <div className="flex justify-center pb-1">
              <Button
                data-log-earlier
                size={touch ? 'touch' : 'sm'}
                icon="chevronDown"
                onClick={() => setLimit(limit + PAGE)}
              >
                Show earlier lines
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
