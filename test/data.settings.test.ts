// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
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
