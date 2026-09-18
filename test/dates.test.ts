import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  formatDayFull,
  formatDayNum,
  nextWeekday,
  parseDate,
  startOfWeek,
  weekdayShort,
} from '@/core/dates';

describe('parseDate — MYOB writes dates as d/mm/yyyy TEXT', () => {
  it('reads single-digit days without zero padding', () => {
    // 9/09/2026 must be 9 September, never US-style 9 June.
    expect(formatDayFull(parseDate('9/09/2026'))).toBe('09/09/2026');
    expect(formatDayFull(parseDate('17/09/2026'))).toBe('17/09/2026');
  });

  it('reads the far-future placeholder without dropping it', () => {
    expect(formatDayFull(parseDate('4/04/2040'))).toBe('04/04/2040');
  });

  it('treats day > 31 as yyyy/mm/dd rather than guessing', () => {
    expect(formatDayFull(parseDate('2026/09/17'))).toBe('17/09/2026');
  });

  it('accepts ISO, Date objects and Excel serials', () => {
    expect(formatDayFull(parseDate('2026-09-17'))).toBe('17/09/2026');
    expect(formatDayFull(parseDate(new Date(2026, 8, 17)))).toBe('17/09/2026');
    // 46282 is 2026-09-17 in Excel's 1900 system (epoch offset 1899-12-30).
    expect(formatDayFull(parseDate(46282))).toBe('17/09/2026');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('0/09/2026')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate('To')).toBeNull();
  });

  it('returns local midnight so day bucketing is stable', () => {
    const ms = parseDate('17/09/2026')!;
    const d = new Date(ms);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
  });
});

describe('day arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(formatDayFull(addDays(parseDate('29/09/2026')!, 3))).toBe('02/10/2026');
    expect(formatDayFull(addDays(parseDate('31/12/2026')!, 1))).toBe('01/01/2027');
  });

  it('counts whole days in both directions', () => {
    expect(diffDays(parseDate('17/09/2026')!, parseDate('25/09/2026')!)).toBe(8);
    expect(diffDays(parseDate('25/09/2026')!, parseDate('17/09/2026')!)).toBe(-8);
  });

  it('formats the way the sheet labels columns', () => {
    expect(formatDayNum(parseDate('17/09/2026')!)).toBe('17/09');
    expect(weekdayShort(parseDate('17/09/2026')!)).toBe('Thu');
  });

  it('anchors week blocks on Friday, matching the heavy separators', () => {
    // The sheet's rule falls after each Thursday, so blocks are Fri -> Thu.
    expect(formatDayFull(startOfWeek(parseDate('22/09/2026')!))).toBe('18/09/2026');
    expect(formatDayFull(startOfWeek(parseDate('24/09/2026')!))).toBe('18/09/2026');
    expect(formatDayFull(startOfWeek(parseDate('25/09/2026')!))).toBe('25/09/2026');
    expect(formatDayFull(startOfWeek(parseDate('02/10/2026')!))).toBe('02/10/2026');
  });

  it('finds the next weekday, counting today as a match', () => {
    const thu = parseDate('17/09/2026')!;
    expect(formatDayFull(nextWeekday(thu, 5))).toBe('18/09/2026'); // Fri
    const fri = parseDate('18/09/2026')!;
    expect(formatDayFull(nextWeekday(fri, 5))).toBe('18/09/2026'); // same day
    expect(formatDayFull(nextWeekday(addDays(fri, 1), 5))).toBe('25/09/2026');
  });
});
