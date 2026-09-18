// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDeviceToken, setDeviceToken } from '@/data/auth';
import { db, getSettings, seedIfEmpty } from '@/data/db';
import { Settings } from '@/screens/Settings';
import { click, render, type Rendered } from './support/render';

/**
 * The connection screen in the DOM. The GitHub client is covered in its own
 * tests; what matters here is which keystrokes go where — in particular that a
 * token typed into this screen is stored somewhere that never leaves the device.
 */
async function reset(): Promise<void> {
  await Promise.all([db.products.clear(), db.events.clear(), db.meta.clear(), db.views.clear()]);
  await seedIfEmpty();
}

async function paint(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderSettings(): Promise<Rendered> {
  const h = render(<Settings />);
  await paint();
  return h;
}

function fieldControl(host: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const field = [...host.querySelectorAll('label')].find(
    (l) => (l.querySelector('span')?.textContent ?? '').trim() === label,
  );
  if (!field) throw new Error(`no field labelled "${label}"`);
  const control = field.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  if (!control) throw new Error(`field "${label}" has no control`);
  return control;
}

function typeValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = control instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(host: HTMLElement, text: string): HTMLElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button labelled "${text}"`);
  return found;
}

function stubFetch(response: { status: number; headers?: Record<string, string>; body?: string }): string[] {
  const seen: string[] = [];
  (globalThis as { fetch: unknown }).fetch = (async (url: string) => {
    seen.push(String(url));
    const headers = new Map(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: response.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => response.body ?? '',
    };
  }) as unknown as typeof fetch;
  return seen;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Settings screen', () => {
  beforeEach(reset);

  it('shows the shop repository the app was built for', async () => {
    const h = await renderSettings();
    expect(h.host.textContent).toContain('Freo-Stone/Production-App-Data');
    expect((fieldControl(h.host, 'Owner') as HTMLInputElement).value).toBe('Freo-Stone');
    h.unmount();
  });

  it('saves a token apart from the settings that sync', async () => {
    const h = await renderSettings();
    typeValue(fieldControl(h.host, 'Token'), 'github_pat_device_only');
    click(button(h.host, 'Save'));
    await paint();

    expect(await getDeviceToken()).toBe('github_pat_device_only');
    // The state document is assembled from Settings, so this is the assertion
    // that keeps the secret off GitHub.
    expect(JSON.stringify(await getSettings())).not.toContain('github_pat_device_only');
    expect(h.host.textContent).toContain('On this device');
    h.unmount();
  });

  it('keeps a typed token without waiting for Save, and says why GitHub refused it', async () => {
    const seen = stubFetch({ status: 401, body: 'Bad credentials' });
    const h = await renderSettings();

    typeValue(fieldControl(h.host, 'Token'), 'github_pat_wrong');
    click(button(h.host, 'Test connection'));
    await paint();

    expect(seen).toContain('https://api.github.com/repos/Freo-Stone/Production-App-Data');
    expect(h.host.textContent).toContain('Token rejected (401)');
    expect(await getDeviceToken()).toBe('github_pat_wrong');
    h.unmount();
  });

  it('refuses to point the shop at a public repository', async () => {
    // The app is served from a public repository now, so the app's own name is a
    // plausible thing to type into the data field — and typing it would publish
    // the order book. The screen has to say that in plain words.
    stubFetch({ status: 200, body: JSON.stringify({ full_name: 'Freo-Stone/Production-App', private: false }) });
    await setDeviceToken('github_pat_any');
    const h = await renderSettings();

    click(button(h.host, 'Test connection'));
    await paint();

    expect(h.host.textContent).toContain('PUBLIC repository');
    expect(h.host.textContent, 'and not pretend the test passed').not.toContain('is reachable and this token can write');
    h.unmount();
  });

  it('calls a dead network a dead network', async () => {
    await setDeviceToken('tok');
    (globalThis as { fetch: unknown }).fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const h = await renderSettings();
    click(button(h.host, 'Test connection'));
    await paint();

    expect(h.host.textContent).toContain('Could not reach GitHub from this device');
    h.unmount();
  });

  it('forgets the device without touching the settings', async () => {
    await setDeviceToken('github_pat_borrowed');
    const h = await renderSettings();
    expect(h.host.textContent).toContain('On this device');

    click(button(h.host, 'Clear the token'));
    await paint();

    expect(await getDeviceToken()).toBe('');
    expect((await getSettings()).sync.githubRepo).toBe('Production-App-Data');
    expect(h.host.textContent).toContain('Not set');
    h.unmount();
  });

  it('moves the weekly MYOB day', async () => {
    const before = await getSettings();
    expect(before.myobEntry.entryWeekday).toBe(5); // Friday

    const h = await renderSettings();
    typeValue(fieldControl(h.host, 'Entry day'), '1');
    await paint();

    expect((await getSettings()).myobEntry.entryWeekday).toBe(1);
    h.unmount();
  });
});
