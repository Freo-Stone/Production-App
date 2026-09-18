import { useCallback, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCan } from '@/app/session';
import { useView } from '@/app/useView';
import { formatNumber } from '@/core/format';
import { defaultView } from '@/core/defaults';
import type { JobRow, StockRow } from '@/core/types';
import { getSettings, latestJobsSnapshot, latestStockSnapshot, saveSettings } from '@/data/db';
import { readExportStates } from '@/data/exportSync';
import { commitImport, type ImportCommit } from '@/data/importFlow';
import { parseExport, type ImportResult } from '@/lib/myob/importFile';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { ViewToolbar } from '@/ui/DataTable/ViewToolbar';
import { Icon } from '@/ui/Icon';
import { AutoImportCard } from './SourcesAutoImport';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Segmented,
  Select,
  TextInput,
  Tile,
  Toggle,
  toast,
  cx,
} from '@/ui/primitives';

/* ── Columns ───────────────────────────────────────────────────────────────── */

const STOCK_COLUMNS: ColumnDef<StockRow>[] = [
  { key: 'code', header: 'Item No.', value: (r) => r.code, format: 'code', sticky: true, width: 110 },
  { key: 'location', header: 'Location', value: (r) => r.location, width: 110 },
  {
    key: 'qtyOnHandRaw',
    header: 'Units On Hand',
    value: (r) => r.qtyOnHandRaw,
    format: 'number',
    totals: 'sum',
    width: 130,
    tone: (r) => (r.qtyOnHandRaw < 0 ? 'short' : null),
    headerHint: 'Exactly as exported. Baseline items still carry the phantom 10000 here.',
  },
  { key: 'category', header: 'Category', value: (r) => r.category, width: 240 },
];

const JOB_COLUMNS: ColumnDef<JobRow>[] = [
  { key: 'itemCode', header: 'Item No.', value: (r) => r.itemCode, format: 'code', sticky: true, width: 100 },
  { key: 'itemDescription', header: 'Description', value: (r) => r.itemDescription, width: 260 },
  { key: 'customer', header: 'Customer', value: (r) => r.customer, width: 220 },
  { key: 'orderNo', header: 'Order No.', value: (r) => r.orderNo, format: 'code', width: 104 },
  { key: 'promisedDate', header: 'Promised', value: (r) => r.promisedDate, format: 'date', width: 108, totals: 'none' },
  { key: 'orderDate', header: 'Ordered', value: (r) => r.orderDate, format: 'date', width: 104 },
  {
    key: 'qty',
    header: 'Qty',
    value: (r) => r.qty,
    format: 'number',
    totals: 'sum',
    width: 96,
    tone: (r) => (r.qty < 0 ? 'short' : null),
    headerHint: 'Negative lines are credits, kept as-is.',
  },
  { key: 'shipVia', header: 'Ship Via', value: (r) => r.shipVia, width: 120 },
  { key: 'salesperson', header: 'Sales', value: (r) => r.salesperson, width: 130 },
];

/* ── Drop zone ─────────────────────────────────────────────────────────────── */

function DropZone({ onFiles, busy }: { onFiles: (files: File[]) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
      className={cx(
        'flex flex-col items-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed px-4 py-6 text-center transition-colors',
        over ? 'border-accent bg-accent/10' : 'border-line bg-surface2',
      )}
    >
      <Icon name="sources" size={22} className={over ? 'text-accent' : 'text-ink3'} />
      <p className="text-sm font-600">Drop the two MYOB exports here</p>
      <p className="max-w-md text-xs text-ink3">
        <b>Sales [Item Detail]</b> for future jobs and <b>Item List [Summary]</b> for stock. Which file is
        which is read from the report inside, never from the file name.
      </p>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xlsm,.xls"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <Button icon="upload" loading={busy} onClick={() => input.current?.click()}>
        Choose files
      </Button>
    </div>
  );
}

/* ── Screen ────────────────────────────────────────────────────────────────── */

type Tab = 'stock' | 'jobs';

/**
 * A file sitting in the import tray.
 *
 * `id` is unique per staged copy on purpose: keying the list by file name looked
 * harmless until the same export was dropped twice, when React reconciled two
 * children with one key and left a stale row on screen.
 */
interface Staged {
  id: string;
  fileName: string;
  result?: ImportResult;
  error?: string;
}

export function Sources() {
  const [tab, setTab] = useState<Tab>('stock');
  const [busy, setBusy] = useState(false);
  const [staged, setStaged] = useState<Staged[]>([]);
  const stagedSeq = useRef(0);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [showPlaceholders, setShowPlaceholders] = useState(false);

  const stock = useLiveQuery(() => latestStockSnapshot(), []);
  const jobs = useLiveQuery(() => latestJobsSnapshot(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const exportStates = useLiveQuery(() => readExportStates(), []);
  const canImport = useCan('sources.import');

  const stockView = useView('sources.stock', defaultView('sources.stock', STOCK_COLUMNS.map((c) => c.key)));
  const jobsView = useView('sources.jobs', defaultView('sources.jobs', JOB_COLUMNS.map((c) => c.key)));

  const locations = useMemo(() => {
    const seen: string[] = [];
    for (const row of stock?.rows ?? []) if (!seen.includes(row.location)) seen.push(row.location);
    return seen.sort();
  }, [stock]);

  const stockRows = useMemo(() => {
    let rows = stock?.rows ?? [];
    if (location) rows = rows.filter((r) => r.location === location);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.code.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
    return rows;
  }, [stock, location, search]);

  const placeholderCount = useMemo(() => {
    const years = settings?.planning.placeholderYears ?? [2040];
    return (jobs?.rows ?? []).filter((j) => years.includes(new Date(j.promisedDate).getFullYear())).length;
  }, [jobs, settings]);

  const jobRows = useMemo(() => {
    let rows = jobs?.rows ?? [];
    if (!showPlaceholders) {
      const years = settings?.planning.placeholderYears ?? [2040];
      rows = rows.filter((j) => !years.includes(new Date(j.promisedDate).getFullYear()));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        [r.itemCode, r.customer, r.orderNo, r.itemDescription].some((v) => v.toLowerCase().includes(q)),
      );
    }
    return rows;
  }, [jobs, showPlaceholders, settings, search]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    const results: Staged[] = [];
    for (const file of files) {
      stagedSeq.current += 1;
      const id = `s${stagedSeq.current}`;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        results.push({ id, fileName: file.name, result: parseExport(bytes, file.name) });
      } catch (error) {
        results.push({ id, fileName: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // The same export dropped twice replaces its earlier copy instead of
    // stacking a second tray row for it — dropping location.xlsx again means
    // "use this one", not "I have two different location.xlsx files".
    setStaged((prev) => {
      const next = [...prev];
      for (const item of results) {
        const at = next.findIndex((s) => s.fileName === item.fileName);
        if (at >= 0) next.splice(at, 1, item);
        else next.push(item);
      }
      return next;
    });
    setBusy(false);
  }, []);

  const load = useCallback(async (item: Staged) => {
    const result = item.result;
    if (!result) return;
    try {
      const commit: ImportCommit = await commitImport(result);
      toast(
        'curing',
        commit.kind === 'stock' ? 'Stock loaded' : 'Future jobs loaded',
        `${formatNumber(commit.rows, 0)} rows from ${commit.source}` +
          (commit.newCodes.length > 0 ? ` · ${commit.newCodes.length} new item codes` : ''),
      );
      setStaged((prev) => prev.filter((s) => s.id !== item.id));
    } catch (error) {
      toast('short', 'Import failed', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const toggleLocation = useCallback((name: string) => {
    void saveSettings({
      sources: {
        stockLocations: (settings?.sources.stockLocations ?? []).includes(name)
          ? (settings?.sources.stockLocations ?? []).filter((l) => l !== name)
          : [...(settings?.sources.stockLocations ?? []), name],
      },
    });
  }, [settings]);

  const selectedLocations = new Set(settings?.sources.stockLocations ?? []);

  return (
    <div className="flex flex-col gap-3">
      {/* ── Freshness ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile
          label="Stock export"
          value={stock ? `${formatNumber(stock.rows.length, 0)} rows` : 'None'}
          sub={stock ? `${stock.source} · ${new Date(stock.capturedAt).toLocaleString('en-AU')}` : 'Import the Item List [Summary]'}
          tone={stock ? 'curing' : 'short'}
        />
        <Tile
          label="Future jobs"
          value={jobs ? `${formatNumber(jobs.rows.length, 0)} lines` : 'None'}
          sub={jobs ? `${jobs.source} · ${new Date(jobs.capturedAt).toLocaleString('en-AU')}` : 'Import the Sales [Item Detail]'}
          tone={jobs ? 'curing' : 'short'}
        />
        <Tile label="Locations" value={locations.length} sub={locations.join(', ') || '—'} />
        <Tile
          label="Placeholder dates"
          value={formatNumber(placeholderCount, 0)}
          sub="Lines dated years ahead — hidden from near-term planning"
          tone={placeholderCount > 0 ? 'warn' : 'neutral'}
        />
      </div>

      {/* ── Automatic import ───────────────────────────────────────────────── */}
      {settings && exportStates ? <AutoImportCard settings={settings} states={exportStates} canWrite={canImport} /> : null}

      {/* ── Import ─────────────────────────────────────────────────────────── */}
      <Card title="Import by hand" subtitle="Files are read in the browser; nothing is uploaded.">
        <div className="flex flex-col gap-2">
          <DropZone onFiles={(files) => void handleFiles(files)} busy={busy} />

          {staged.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {staged.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface2 px-2.5 py-2"
                >
                  <Icon name={item.error ? 'alert' : 'check'} size={16} className={item.error ? 'text-short' : 'text-curing'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-600">{item.fileName}</span>
                    <span className="block truncate text-xs text-ink3">
                      {item.error
                        ? item.error
                        : `${item.result?.reportTitle} · sheet ${item.result?.sheetName} · ${
                            item.result?.stock ? `${item.result.stock.rows.length} stock rows` : `${item.result?.jobs?.rows.length} job lines`
                          }`}
                    </span>
                  </span>
                  {item.result ? (
                    <Button size="sm" variant="primary" onClick={() => void load(item)}>
                      Load
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setStaged((prev) => prev.filter((s) => s.id !== item.id))}>
                    Discard
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      {/* ── Locations ──────────────────────────────────────────────────────── */}
      {locations.length > 0 ? (
        <Card
          title="Locations counted as stock"
          subtitle="Everything else in the export is ignored by the planning maths."
        >
          <div className="flex flex-wrap gap-1.5">
            {locations.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggleLocation(name)}
                className={cx(
                  'chip cursor-pointer',
                  selectedLocations.has(name)
                    ? 'border-curing/40 bg-curingbg text-curing'
                    : 'border-line bg-surface3 text-ink3',
                )}
              >
                <Icon name={selectedLocations.has(name) ? 'check' : 'plus'} size={11} />
                {name}
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ── Tables ─────────────────────────────────────────────────────────── */}
      <Card
        padded={false}
        title={
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'stock' as const, label: `Stock (${formatNumber(stockRows.length, 0)})` },
              { value: 'jobs' as const, label: `Future jobs (${formatNumber(jobRows.length, 0)})` },
            ]}
          />
        }
        actions={
          tab === 'jobs' ? (
            <Toggle
              checked={showPlaceholders}
              onChange={setShowPlaceholders}
              label="Include placeholder dates"
            />
          ) : null
        }
      >
        <div className="border-b border-line px-2 py-2">
          {tab === 'stock' ? (
            <ViewToolbar
              view={stockView.view}
              patch={stockView.patch}
              columns={STOCK_COLUMNS.map((c) => ({ key: c.key, header: c.header }))}
              isPersonal={stockView.isPersonal}
              hasShared={stockView.hasShared}
              onResetToShared={stockView.resetToShared}
              onPublishDefault={stockView.publishAsDefault}
              extra={
                <>
                  <TextInput
                    placeholder="Filter item or category…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-48"
                  />
                  <Field label="Location">
                    <Select
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      options={[
                        { value: '', label: 'All locations' },
                        ...locations.map((l) => ({ value: l, label: `${l}${selectedLocations.has(l) ? ' ✓' : ''}` })),
                      ]}
                    />
                  </Field>
                  <Chip tone="info">Raw units on hand — baseline items still include the phantom 10000</Chip>
                </>
              }
            />
          ) : (
            <ViewToolbar
              view={jobsView.view}
              patch={jobsView.patch}
              columns={JOB_COLUMNS.map((c) => ({ key: c.key, header: c.header }))}
              isPersonal={jobsView.isPersonal}
              hasShared={jobsView.hasShared}
              onResetToShared={jobsView.resetToShared}
              onPublishDefault={jobsView.publishAsDefault}
              extra={
                <TextInput
                  placeholder="Filter customer, item or order…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-64"
                />
              }
            />
          )}
        </div>

        <div className="h-[min(62vh,620px)] min-h-0">
          {tab === 'stock' ? (
            <DataTable
              rows={stockRows}
              columns={STOCK_COLUMNS}
              view={stockView.view}
              onViewChange={stockView.patch}
              getRowId={(r) => `${r.code}|${r.location}`}
              loading={stock === undefined}
              empty={
                <EmptyState
                  icon="sources"
                  title="No stock imported yet"
                  body="Drop the Item List [Summary] export above to see on-hand quantities here."
                />
              }
            />
          ) : (
            <DataTable
              rows={jobRows}
              columns={JOB_COLUMNS}
              view={jobsView.view}
              onViewChange={jobsView.patch}
              getRowId={(r) => r.id}
              loading={jobs === undefined}
              empty={
                <EmptyState
                  icon="jobs"
                  title="No future jobs imported yet"
                  body="Drop the Sales [Item Detail] export above to see every open order line here."
                />
              }
            />
          )}
        </div>
      </Card>
    </div>
  );
}
