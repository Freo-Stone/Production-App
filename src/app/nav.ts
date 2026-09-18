import type { IconName } from '@/ui/Icon';

/**
 * Navigation model, shared by the desktop rail and the mobile tab bar so the
 * two can never disagree about what exists or what it is called.
 */
export type NavGroup = 'plan' | 'make' | 'ship' | 'setup';

export interface NavItem {
  /** Hash route, e.g. `/curing`. */
  path: string;
  label: string;
  /** Fitted for the 5-slot mobile bar. */
  short: string;
  icon: IconName;
  group: NavGroup;
  /** One-line description shown in the mobile "More" sheet and page headers. */
  blurb: string;
  /** Which live count, if any, rides along as a badge. */
  badge?: 'curing' | 'shotblast' | 'myob' | 'late';
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
    icon: 'matrix',
    group: 'plan',
    blurb: 'Product against day: what is promised, what is short, what is curing.',
  },
  {
    path: '/jobs',
    label: 'Future jobs',
    short: 'Jobs',
    icon: 'jobs',
    group: 'plan',
    blurb: 'Every open sales-order line from the MYOB export.',
  },
  {
    path: '/schedule',
    label: 'Schedule',
    short: 'Schedule',
    icon: 'schedule',
    group: 'plan',
    blurb: 'What needs making, and the latest day it can start.',
  },
  {
    path: '/entry',
    label: 'Daily entry',
    short: 'Entry',
    icon: 'entry',
    group: 'make',
    blurb: 'Log trays made per line. Quantities follow each product’s tray yield.',
  },
  {
    path: '/log',
    label: 'Production log',
    short: 'Log',
    icon: 'log',
    group: 'make',
    blurb: 'Every batch, its stage history and who made it.',
  },
  {
    path: '/curing',
    label: 'Curing',
    short: 'Curing',
    icon: 'curing',
    group: 'make',
    blurb: 'Batches on the cure clock, due by day.',
    badge: 'curing',
  },
  {
    path: '/shotblast',
    label: 'Shotblast',
    short: 'Blast',
    icon: 'blast',
    group: 'make',
    blurb: 'Awaiting blast, on the blaster, and blasted.',
    badge: 'shotblast',
  },
  {
    path: '/myob',
    label: 'MYOB entry',
    short: 'MYOB',
    icon: 'myob',
    group: 'ship',
    blurb: 'The weekly run: cured and blasted stock ready to key into MYOB.',
    badge: 'myob',
  },
  {
    path: '/products',
    label: 'Products',
    short: 'Products',
    icon: 'products',
    group: 'setup',
    blurb: 'Pick the current range, set route, unit, tray yield and target.',
  },
  {
    path: '/sources',
    label: 'Data sources',
    short: 'Data',
    icon: 'sources',
    group: 'setup',
    blurb: 'MYOB exports: freshness, contents and manual import.',
  },
  {
    path: '/settings',
    label: 'Settings',
    short: 'Settings',
    icon: 'settings',
    group: 'setup',
    blurb: 'Cure times, lines, the weekly entry day and sync.',
  },
];

/** The four screens used on the floor, in thumb order. Everything else is in More. */
export const MOBILE_TAB_PATHS = ['/', '/entry', '/curing', '/myob'];

export function navByPath(path: string): NavItem | undefined {
  if (NAV.some((n) => n.path === path)) return NAV.find((n) => n.path === path);
  // Sub-pages (/products/S3) inherit their section's entry.
  const root = `/${path.split('/')[1] ?? ''}`;
  return NAV.find((n) => n.path === root);
}
