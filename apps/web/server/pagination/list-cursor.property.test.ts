/**
 * Property tests for list cursors and keyset paging (F-21 property 6): a minted cursor reads back as
 * the position it was minted for and only for its own list and workspace, and walking a list page
 * by page through those cursors returns every row exactly once, newest first, for any page size.
 * The walk uses the in-memory keyset fake the store doubles share; the PostgreSQL keyset query is
 * held to the same ordering by the repositories' own suites. On a failure fast-check prints the
 * seed and path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { encodeListCursor, readListCursor, type ListCursorKind } from './list-cursor';
import { keysetPageOf } from './testing';

const kind = fc.constantFrom<ListCursorKind>('sessions', 'audit-events');

/** Few distinct instants, so ties on `createdAt` (broken by id) are the common case. */
const createdAt = fc
  .integer({ min: 0, max: 5 })
  .map((offset) => new Date(Date.UTC(2026, 9, 18, 12, 0, offset, offset * 7)));

const rows = fc.uniqueArray(fc.record({ id: fc.uuid(), createdAt }), {
  selector: (row) => row.id,
  maxLength: 25,
});

describe('list cursors (property)', () => {
  it('round-trip the position, and refuse another list or another workspace', () => {
    fc.assert(
      fc.property(
        kind,
        fc.uuid(),
        fc.uuid(),
        createdAt,
        fc.uuid(),
        (list, workspaceId, otherWorkspace, at, id) => {
          const position = { createdAt: at.toISOString(), id };
          const cursor = encodeListCursor(list, workspaceId, position);
          expect(readListCursor(cursor, list, workspaceId)).toEqual({ kind: 'ok', position });
          const other = list === 'sessions' ? 'audit-events' : 'sessions';
          expect(readListCursor(cursor, other, workspaceId).kind).toBe('invalid');
          if (otherWorkspace !== workspaceId) {
            expect(readListCursor(cursor, list, otherWorkspace).kind).toBe('invalid');
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('keyset paging through minted cursors (property)', () => {
  it('returns every row exactly once, newest first, for any page size', () => {
    fc.assert(
      fc.property(rows, fc.integer({ min: 1, max: 7 }), fc.uuid(), (all, limit, workspaceId) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page <= all.length; page += 1) {
          const read = readListCursor(cursor, 'sessions', workspaceId);
          if (read.kind === 'invalid') throw new Error(read.reason);
          const result = keysetPageOf(all, {
            limit,
            cursor: read.kind === 'ok' ? read.position : null,
          });
          expect(result.items.length).toBeLessThanOrEqual(limit);
          seen.push(...result.items.map((row) => row.id));
          if (result.nextCursor === null) break;
          cursor = encodeListCursor('sessions', workspaceId, result.nextCursor);
        }
        const newestFirst = [...all].sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
        expect(seen).toEqual(newestFirst.map((row) => row.id));
      }),
      { numRuns: 300 },
    );
  });
});
