import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from './clock';

const START = '2026-10-27T09:00:00.000Z';

describe('systemClock', () => {
  it('reads the real time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('cannot be replaced at runtime', () => {
    expect(Object.isFrozen(systemClock)).toBe(true);
  });
});

describe('fixedClock', () => {
  it('stands still until it is moved', () => {
    const clock = fixedClock(START);
    expect(clock.now().toISOString()).toBe(START);
    expect(clock.now().toISOString()).toBe(START);
  });

  it('accepts a Date as well as a string', () => {
    expect(fixedClock(new Date(START)).now().toISOString()).toBe(START);
  });

  it('advance() moves it forward by milliseconds', () => {
    const clock = fixedClock(START);
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-10-27T09:01:30.000Z');
  });

  it('set() moves it to any time, including back', () => {
    const clock = fixedClock(START);
    clock.set('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns a new Date each time, so a caller cannot change the clock', () => {
    const clock = fixedClock(START);
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe(START);
  });

  it('copies the start Date, so changing it later does not move the clock', () => {
    const start = new Date(START);
    const clock = fixedClock(start);
    start.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe(START);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'advance(%s) throws a RangeError',
    (amount) => {
      expect(() => fixedClock(START).advance(amount)).toThrow(RangeError);
    },
  );

  it('refuses an invalid start or set() time', () => {
    expect(() => fixedClock('not a date')).toThrow(RangeError);
    expect(() => fixedClock(START).set(new Date(Number.NaN))).toThrow(RangeError);
  });
});
