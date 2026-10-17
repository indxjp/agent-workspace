/**
 * The `path-grant` vectors, replayed against `@agent-workspace/engine`'s path-grant helper
 * (ENG-04, #303).
 *
 * This suite is in `tests/formal/` rather than beside an application because it imports a
 * package through its public export (decision D-012): the helper is shared by every engine
 * adapter, and a second implementation of `..` resolution is a second chance to get it wrong.
 *
 * A disagreement with `formal/AgentWorkspace/Authz/PathGrant.lean` is a failing test, and the
 * fix is never to edit a vector (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import {
  normaliseGrantPath,
  writeGrantVerdict,
  type NormalisedGrant,
} from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import { asRecord, loadVectors } from './vectors.js';

const FAMILY = 'path-grant';

function rows(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected an array, got ${JSON.stringify(value)}`);
  }
  return value.map((entry, index) => asRecord(entry, `${label}[${String(index)}]`));
}

/** One expected verdict, compared the same way for both files. */
function expectVerdict(
  id: string,
  verdict: ReturnType<typeof normaliseGrantPath>,
  answer: Record<string, unknown>,
): void {
  if (answer['ok'] === true) {
    expect(verdict.ok, `${id}: ${verdict.ok ? '' : verdict.reason}`).toBe(true);
    if (verdict.ok) expect(verdict.path).toBe(answer['path']);
    return;
  }
  expect(verdict.ok, `${id}: the model refuses this path`).toBe(false);
  // The refusal is compared by *name*, not merely by being a refusal: "it said no" and "it said
  // no for the reason the model says" are different claims, and only the second catches a rule
  // that started firing one clause earlier than it should.
  if (!verdict.ok) expect(verdict.refusal).toBe(answer['refusal']);
}

describe('path-grant: normalisation', () => {
  const vectors = loadVectors(FAMILY, 'normalise.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const protectedDirectory = request['protectedDirectory'];
    expectVerdict(
      id,
      normaliseGrantPath(
        String(request['path']),
        typeof protectedDirectory === 'string' ? protectedDirectory : null,
      ),
      asRecord(expected, id),
    );
  });

  it('replayed the spellings an escape is actually written in', () => {
    // ADR-0015: a suite that replayed only canonical paths would pass while saying nothing about
    // the inputs this helper exists for.
    const ids = vectors.map((vector) => vector.id);
    expect(ids).toContain('escape-through');
    expect(ids).toContain('absolute-windows-drive');
    expect(ids).toContain('protected-through-parent');
  });
});

describe('path-grant: the write decision', () => {
  const vectors = loadVectors(FAMILY, 'write.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const grants: NormalisedGrant[] = rows(request['grants'], id).map((row) => {
      const path = String(row['path']);
      return {
        kind: row['kind'] === 'directory' ? 'directory' : 'file',
        path,
        segments: path.split('/'),
        access: row['access'] === 'read' ? 'read' : 'read-write',
      };
    });
    expectVerdict(
      id,
      writeGrantVerdict(String(request['candidate']), grants),
      asRecord(expected, id),
    );
  });

  it('replayed the case a prefix comparison gets wrong', () => {
    expect(vectors.map((vector) => vector.id)).toContain('prefix-not-inside');
  });
});
