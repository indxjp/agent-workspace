import { describe, expect, it } from 'vitest';

import { encodeCursor, isKeysetTimestamp, readCursor } from './cursor.js';

const workspace = '00000000-0000-4000-8000-0000000000aa';
const position = {
  createdAt: '2026-10-31T01:02:03.456789Z',
  id: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
};

function encodedJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

describe('the resource list cursor', () => {
  it('round-trips a position, in base64url without padding', () => {
    const cursor = encodeCursor('desk.tickets', workspace, position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(readCursor(cursor, 'desk.tickets', workspace)).toEqual({ ok: true, position });
  });

  it('refuses a cursor of another list or another workspace', () => {
    const cursor = encodeCursor('desk.tickets', workspace, position);
    expect(readCursor(cursor, 'desk.notes', workspace)).toEqual({ ok: false });
    expect(readCursor(cursor, 'desk.tickets:search', workspace)).toEqual({ ok: false });
    expect(readCursor(cursor, 'desk.tickets', crypto.randomUUID())).toEqual({ ok: false });
  });

  it('refuses a tampered cursor', () => {
    const cursor = encodeCursor('desk.tickets', workspace, position);
    const last = cursor.at(-1) === 'A' ? 'B' : 'A';
    for (const tampered of [
      `${cursor.slice(0, -1)}${last}`,
      `${cursor}=`,
      `${cursor}.`,
      cursor.slice(1),
      '',
      '!!!!',
    ]) {
      expect(readCursor(tampered, 'desk.tickets', workspace), tampered).toEqual({ ok: false });
    }
  });

  it('refuses a well-encoded cursor that this code did not mint', () => {
    const base = { v: 1, k: 'desk.tickets', w: workspace, t: position.createdAt, i: position.id };
    for (const value of [
      { ...base, v: 2 },
      { ...base, extra: 1 },
      { ...base, t: '2026-02-30T00:00:00.000Z' },
      { ...base, t: '2026-10-31T01:02:03Z' },
      { ...base, i: 'not-a-uuid' },
      [base],
      'text',
    ]) {
      expect(readCursor(encodedJson(value), 'desk.tickets', workspace)).toEqual({ ok: false });
    }
  });

  it('accepts only real instants in the stores’ shape as timestamps', () => {
    expect(isKeysetTimestamp('2026-10-31T01:02:03.4Z')).toBe(true);
    expect(isKeysetTimestamp('0001-01-01T00:00:00.000Z')).toBe(true);
    expect(isKeysetTimestamp('0000-01-01T00:00:00.000Z')).toBe(false);
    expect(isKeysetTimestamp('2026-13-01T00:00:00.000Z')).toBe(false);
    expect(isKeysetTimestamp('2026-10-31T24:00:00.000Z')).toBe(false);
    expect(isKeysetTimestamp('2026-10-31T01:02:03.1234567Z')).toBe(false);
  });
});
