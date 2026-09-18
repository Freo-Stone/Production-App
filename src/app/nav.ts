import { can, type Capability } from '@/core/roles';
import type { AccountRole } from '@/core/types';

/**
 * Navigation model, shared by the desktop rail and the mobile tab bar so the
 * two can never disagree about what exists or what it is called.
 */
export type NavGroup = 'plan' | 'make' | 'ship' | 'setup';

export interface NavItem {
  /** Hash route, e.g. `/curing`. */
  path: string;
  label: string;
  /**
   * Fitted for the 5-slot mobile bar, and the source of the letters the collapsed
   * rail shows. The menu is words: a picture beside every entry costs a glance to
   * decode and says nothing the word does not already say.
   */
  short: string;
  group: NavGroup;
  /** One-line description shown in the mobile "More" sheet and page headers. */
  blurb: string;
  /** Which live count, if any, rides along as a badge. */
  badge?: 'curing' | 'shotblast' | 'myob' | 'late';
  /**
   * Which account may see this at all. Absent means everyone signed in. It decides
   * what is *listed*, never what is allowed — the check that counts is in the data
   * layer under the button, so a viewer typing `/settings` into the address bar gets
   * a refusal, not a way in.
   */
  capability?: Capability;
}

export const NAV_GROUPS: Array<{ key: NavGroup; label: string }> = [
  { key: 'plan', label: 'Plan' },
  { key: 'make', label: 'Make' },
  { key: 'ship', label: 'Ship' },
  { key: 'setup', label: 'Setup' },
];

export const NAV: NavItem[] = [
  {
    path: '/',
    label: 'Matrix',
    short: 'Matrix',
    group: 'plan',
    blurb: 'Product against day: what is promised, what is short, what is curing.',
  },
  {
    path: '/jobs',
    label: 'Future jobs',
    short: 'Jobs',
    group: 'plan',
    blurb: 'Every open sales-order line from the MYOB export.',
  },
  {
    path: '/schedule',
    label: 'Schedule',
    short: 'Schedule',
    group: 'plan',
    blurb: 'What needs making, and the latest day it can start.',
  },
  {
    path: '/entry',
    label: 'Daily entry',
    short: 'Entry',
    group: 'make',
    blurb: 'Log trays made per line. Quantities follow each product’s tray yield.',
  },
  {
    path: '/log',
    label: 'Production log',
    short: 'Log',
    group: 'make',
    blurb: 'Every batch, its stage history and who made it.',
  },
  {
    path: '/curing',
    label: 'Curing',
    short: 'Curing',
    group: 'make',
    blurb: 'Batches on the cure clock, due by day.',
    badge: 'curing',
  },
  {
    path: '/shotblast',
    label: 'Shotblast',
    short: 'Blast',
    group: 'make',
    blurb: 'Awaiting blast, on the blaster, and blasted.',
    badge: 'shotblast',
  },
  {
    path: '/myob',
    label: 'MYOB entry',
    short: 'MYOB',
    group: 'ship',
    blurb: 'The weekly run: cured and blasted stock ready to key into MYOB.',
    badge: 'myob',
  },
  {
    path: '/products',
    label: 'Products',
    short: 'Products',
    group: 'setup',
    blurb: 'Pick the current range, set route, unit, tray yield and target.',
  },
  {
    path: '/sources',
    label: 'Data sources',
    short: 'Data',
    group: 'setup',
    blurb: 'MYOB exports: freshness, contents and manual import.',
    capability: 'sources.import',
  },
  {
    path: '/settings',
    label: 'Settings',
    short: 'Settings',
    group: 'setup',
    blurb: 'Cure times, lines, the weekly entry day and sync.',
    capability: 'settings.manage',
  },
  {
    path: '/people',
    label: 'People',
    short: 'People',
    group: 'setup',
    blurb: 'Who can sign in, what they may do, and which devices are allowed.',
    capability: 'people.manage',
  },
];

/** The four screens used on the floor, in thumb order. Everything else is in More. */
export const MOBILE_TAB_PATHS = ['/', '/entry', '/curing', '/myob'];

/** Whether a role sees this entry at all. `null` role means nobody is signed in. */
export function navVisible(item: NavItem, role: AccountRole | null): boolean {
  return item.capability === undefined || can(role, item.capability);
}

export function navByPath(path: string): NavItem | undefined {
  if (NAV.some((n) => n.path === path)) return NAV.find((n) => n.path === path);
  // Sub-pages (/products/S3) inherit their section's entry.
  const root = `/${path.split('/')[1] ?? ''}`;
  return NAV.find((n) => n.path === root);
}
