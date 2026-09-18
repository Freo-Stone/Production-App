// What each role may do, pinned one capability at a time. This is the only test that
// has to agree with src/core/roles.ts; every screen reads the same function.
import { describe, expect, it } from 'vitest';

import { can, isWriter, mayEditOwn, mayManage, ASSIGNABLE_ROLES, ROLE_LABEL } from '@/core/roles';
import type { Capability } from '@/core/roles';
import type { AccountRole } from '@/core/types';

const CAPABILITIES: Capability[] = [
  'people.manage',
  'settings.manage',
  'connection.manage',
  'products.edit',
  'production.record',
  'myob.enter',
  'sources.import',
  'views.own',
  'self.passcode',
];

describe('can', () => {
  it('gives the owner everything', () => {
    expect(CAPABILITIES.filter((c) => can('owner', c))).toEqual(CAPABILITIES);
  });

  it('lets a maker do the work but not run the shop', () => {
    expect(CAPABILITIES.filter((c) => can('maker', c))).toEqual([
      'products.edit',
      'production.record',
      'myob.enter',
      'sources.import',
      'views.own',
      'self.passcode',
    ]);
  });

  it('lets a viewer change nothing but their own table layout', () => {
    expect(CAPABILITIES.filter((c) => can('viewer', c))).toEqual(['views.own', 'self.passcode']);
    for (const capability of CAPABILITIES) {
      if (capability !== 'views.own' && capability !== 'self.passcode') {
        expect(can('viewer', capability), capability).toBe(false);
      }
    }
  });

  it('refuses everything when nobody is signed in', () => {
    // The sign-in gate is not the only thing standing between a stranger and the
    // data: a caller that asks while signed out gets a no, not an exception.
    for (const capability of CAPABILITIES) expect(can(null, capability), capability).toBe(false);
    expect(isWriter(null)).toBe(false);
  });

  it('calls a writer someone who can log production, and nobody else', () => {
    expect((['owner', 'maker'] as AccountRole[]).map(isWriter)).toEqual([true, true]);
    expect(isWriter('viewer')).toBe(false);
  });
});

describe('mayManage', () => {
  it('lets the owner manage anyone but another owner', () => {
    expect(mayManage('owner', 'maker')).toBe(true);
    expect(mayManage('owner', 'viewer')).toBe(true);
    // There is one owner. Refusing here is what stops an owner being deleted and
    // the shop locking itself out of its own data.
    expect(mayManage('owner', 'owner')).toBe(false);
  });

  it('lets nobody but the owner manage anyone', () => {
    for (const role of ['maker', 'viewer', null] as (AccountRole | null)[]) {
      expect(mayManage(role, 'maker'), String(role)).toBe(false);
      expect(mayManage(role, 'owner'), String(role)).toBe(false);
    }
  });
});

describe('mayEditOwn', () => {
  it('lets anyone change their own passcode', () => {
    // Otherwise resetting a code means handing a phone across the yard to the owner.
    for (const role of ['owner', 'maker', 'viewer'] as AccountRole[]) {
      expect(mayEditOwn(role, 'passcode'), role).toBe(true);
    }
  });

  it('lets only the owner change a name, which the work is stamped with', () => {
    expect(mayEditOwn('owner', 'name')).toBe(true);
    expect(mayEditOwn('maker', 'name')).toBe(false);
    expect(mayEditOwn('viewer', 'name')).toBe(false);
    expect(mayEditOwn(null, 'name')).toBe(false);
    expect(mayEditOwn(null, 'passcode')).toBe(false);
  });
});

describe('role labels handed to people', () => {
  it('names all three and hands out only two', () => {
    expect(Object.keys(ROLE_LABEL).sort()).toEqual(['maker', 'owner', 'viewer']);
    // The owner role is not assignable: it is created once, and demoting it would
    // leave the shop with no way to manage accounts at all.
    expect(ASSIGNABLE_ROLES).toEqual(['maker', 'viewer']);
  });
});
