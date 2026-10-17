import { describe, expect, it } from 'vitest';

import { clampMenuIndex, nextMenuIndex, parseMenuKey } from './workspace-switcher-menu';

describe('nextMenuIndex', () => {
  it('moves down and wraps from the last item to the first', () => {
    expect(nextMenuIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(nextMenuIndex(2, 'ArrowDown', 3)).toBe(0);
  });

  it('moves up and wraps from the first item to the last', () => {
    expect(nextMenuIndex(1, 'ArrowUp', 3)).toBe(0);
    expect(nextMenuIndex(0, 'ArrowUp', 3)).toBe(2);
  });

  it('Home and End jump to the ends regardless of the current position', () => {
    expect(nextMenuIndex(1, 'Home', 4)).toBe(0);
    expect(nextMenuIndex(1, 'End', 4)).toBe(3);
  });

  it('answers null for an empty menu — there is nothing to focus, never index 0', () => {
    expect(nextMenuIndex(0, 'ArrowDown', 0)).toBeNull();
    expect(nextMenuIndex(0, 'Home', 0)).toBeNull();
  });

  it('a single-item menu wraps to itself', () => {
    expect(nextMenuIndex(0, 'ArrowDown', 1)).toBe(0);
    expect(nextMenuIndex(0, 'ArrowUp', 1)).toBe(0);
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): dropping the `+ count` in the
  // `ArrowUp` branch's `(current - 1 + count) % count` makes `nextMenuIndex(0, 'ArrowUp', 3)`
  // return `-1` (JavaScript's `%` keeps the dividend's sign) instead of `2` — the wrap-to-last
  // case above fails with `-1 !== 2`. Restoring `+ count` fixes it.
});

describe('parseMenuKey', () => {
  it('names exactly the four keys this menu moves focus for', () => {
    expect(parseMenuKey('ArrowDown')).toBe('ArrowDown');
    expect(parseMenuKey('ArrowUp')).toBe('ArrowUp');
    expect(parseMenuKey('Home')).toBe('Home');
    expect(parseMenuKey('End')).toBe('End');
  });

  it('refuses every other key by name rather than guessing', () => {
    expect(parseMenuKey('Enter')).toBeNull();
    expect(parseMenuKey('Escape')).toBeNull();
    expect(parseMenuKey('a')).toBeNull();
    expect(parseMenuKey('')).toBeNull();
  });
});

describe('clampMenuIndex', () => {
  it('leaves an in-range index untouched', () => {
    expect(clampMenuIndex(1, 3)).toBe(1);
  });

  it('pulls an out-of-range index back inside the list', () => {
    expect(clampMenuIndex(5, 3)).toBe(2);
    expect(clampMenuIndex(-1, 3)).toBe(0);
  });

  it('answers null once the list is empty', () => {
    expect(clampMenuIndex(0, 0)).toBeNull();
  });
});
