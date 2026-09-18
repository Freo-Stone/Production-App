// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import { db, getSettings, saveSettings, seedIfEmpty } from '@/data/db';

describe('settings writes', () => {
  beforeEach(async () => {
    await Promise.all([db.meta.clear(), db.products.clear(), db.events.clear()]);
    await seedIfEmpty();
  });

  it('keeps untouched settings when one is changed', async () => {
    const before = await getSettings();
    const after = await saveSettings({ production: { defaultCureDays: 3 } });

    expect(after.production.defaultCureDays).toBe(3);
    expect(after.myobEntry.entryWeekday).toBe(before.myobEntry.entryWeekday);
    // Defaults survive, so a setting added in a later build is never missing.
    expect(after.production.batchNumberFormat).toBe(DEFAULT_SETTINGS.production.batchNumberFormat);
  });

  it('keeps both changes when two settings are saved a moment apart', async () => {
    await Promise.all([
      saveSettings({ production: { defaultCureDays: 4 } }),
      saveSettings({ myobEntry: { entryWeekday: 2 } }),
      saveSettings({ deviceName: 'Shop floor PC' }),
    ]);

    const s = await getSettings();
    expect(s.production.defaultCureDays).toBe(4);
    expect(s.myobEntry.entryWeekday).toBe(2);
    expect(s.deviceName).toBe('Shop floor PC');
  });
});

describe('first-run seeding', () => {
  // Two screens ask for seeding when the app starts — the shell, and the sign-in
  // screen behind it — and they ask in the same tick. The first version of
  // seedIfEmpty counted the lines, found none, and added all five, so the second
  // caller's add failed with ConstraintError and a brand-new device never got past
  // its loading screen.
  it('survives every screen asking for it at once', async () => {
    await Promise.all([db.lines.clear(), db.meta.clear()]);

    await Promise.all([seedIfEmpty(), seedIfEmpty(), seedIfEmpty()]);

    expect((await db.lines.toArray()).map((l) => l.id).sort()).toEqual(
      DEFAULT_LINES.map((l) => l.id).sort(),
    );
    expect(await db.meta.get('settings')).toBeTruthy();
  });

  it('does not overwrite a line the shop has renamed', async () => {
    await db.lines.clear();
    await seedIfEmpty();
    await db.lines.update('line-2', { name: 'Line 2 — long bed' });

    await seedIfEmpty();

    expect((await db.lines.get('line-2'))?.name).toBe('Line 2 — long bed');
    expect(await db.lines.count()).toBe(DEFAULT_LINES.length);
  });

  it('comes back after a partial seed, which is what a rejected add used to leave', async () => {
    await Promise.all([db.lines.clear(), db.meta.clear()]);
    await db.lines.add({ ...DEFAULT_LINES[0]!, updatedAt: Date.now() });

    await seedIfEmpty();

    expect(await db.lines.count()).toBe(DEFAULT_LINES.length);
  });
});
