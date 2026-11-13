/**
 * The run store: the vocabulary and ceiling it restates.
 *
 * The conformance suite (`store.conformance.test-support.ts`) runs against `InMemoryRunStore` and
 * PostgreSQL in `store.postgres.test.ts`; the gate that keeps the in-memory store out of anything a
 * deployment loads is `store.in-memory-gate.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import { RUN_STATUS_EVENT_NAME, RUN_STATUS_NAMES } from '@indx-workspace/react/run-model';

import { isTerminalRunStatus, MAX_RUN_LIST_LIMIT, runStatuses, terminalRunStatuses } from './store';
import { RUN_STATUS_EVENT } from './sse';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('the run status vocabulary', () => {
  it('is character-for-character the database schema this repository already has', () => {
    // The list is restated in `store.ts` rather than imported, because `apps/web` reaches
    // `@agent-workspace/core` through `import type` only — see that file's header. This test is
    // what keeps the restatement from becoming a second, drifting source of truth.
    // The path is joined with the imported `path` rather than constructed with `new URL`, because
    // the reachability gate refuses a layer path handed to a callee it cannot see this file bind
    // (ADR-0031 clause 1), and `URL` is a free global. Reading the schema as *text* is what this
    // test is for; routing the path through an imported binding is what makes the reference one a
    // reader — and that gate — can follow.
    const schema = readFileSync(
      path.join(here, '../../../../packages/core/src/db/schema/runs.ts'),
      'utf8',
    );
    const read = (name: string): string[] => {
      const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(schema);
      if (match === null)
        throw new Error(`${name} not found in packages/core/src/db/schema/runs.ts`);
      return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    };
    // Both lists are the contract's `RUN_STATUSES` itself: the schema imports it rather than
    // restating it (F-12), and `store.ts` re-exports it, so the check is that both do.
    expect(schema).toContain("import { RUN_STATUSES } from '@indx-workspace/contracts/runs';");
    expect(schema).toContain('export const runStatuses = RUN_STATUSES;');
    expect(runStatuses).toBe(RUN_STATUSES);
    expect([...terminalRunStatuses]).toEqual(read('terminalRunStatuses'));
  });

  it('agrees with isTerminalRunStatus on every member, with no default arm', () => {
    for (const status of runStatuses) {
      expect(isTerminalRunStatus(status)).toBe(
        (terminalRunStatuses as readonly string[]).includes(status),
      );
    }
  });

  // The browser's run model (`@indx-workspace/react/run-model`) restates these two, because a
  // client bundle cannot import a server module; this is the check that the restatement agrees.
  it('is the run model’s RUN_STATUS_NAMES, and its status event is RUN_STATUS_EVENT', () => {
    expect([...RUN_STATUS_NAMES]).toEqual([...runStatuses]);
    expect(RUN_STATUS_EVENT_NAME).toBe(RUN_STATUS_EVENT);
  });
});

/** The value of `const <name> = <digits>;` in the file at `relative` (from this directory). */
function declaredLimit(relative: string, name: string): number {
  const source = readFileSync(path.join(here, relative), 'utf8');
  const match = new RegExp(`const ${name}\\s*=\\s*(\\d+);`, 'u').exec(source);
  if (match === null) throw new Error(`${name} is not declared in ${relative}`);
  return Number(match[1] ?? '');
}

describe('the run list page-size ceiling', () => {
  it('is one number written in three places, and they agree', () => {
    // `MAX_RUN_LIST_LIMIT` exists twice under that name: in the repository, which enforces it for
    // every direct caller, and in `store.ts`, so `InMemoryRunStore` refuses what the repository
    // refuses and `list-query.ts` turns a larger `limit` into `400 invalid_limit` before any store
    // is reached. `store.ts` restates the repository's rather than importing it for the reason the
    // run status vocabulary above is — `apps/web` reaches `@agent-workspace/core` through `import
    // type` only. This test is what stops them from drifting apart silently; the conformance
    // suite's `listRuns` block is what stops the *message* they refuse with from drifting.
    expect(
      declaredLimit(
        '../../../../packages/core/src/db/repositories/runs/listing.ts',
        'MAX_RUN_LIST_LIMIT',
      ),
    ).toBe(MAX_RUN_LIST_LIMIT);
    // Declared once in this directory, in `store.ts`: `api.ts`, `service.ts` and `list-query.ts`
    // import it, so a second declaration there would be a fourth copy to drift.
    const declaring = readdirSync(here).filter(
      (file) =>
        /\.ts$/u.test(file) &&
        !/\.test\.ts$/u.test(file) &&
        /MAX_RUN_LIST_LIMIT\s*=/u.test(readFileSync(path.join(here, file), 'utf8')),
    );
    expect(declaring).toEqual(['store.ts']);
    // The third copy, spelled differently and so read separately: `project-detail.tsx` sends it
    // verbatim as `limit=` to this same route, so a lowered ceiling would answer the archive-impact
    // dialog `400 invalid_limit` rather than a page. Read as text, not imported — it is browser
    // code, and reading the declaration is the pattern the read above already uses.
    expect(declaredLimit('../../components/projects/model.ts', 'ARCHIVE_IMPACT_RUN_LIMIT')).toBe(
      MAX_RUN_LIST_LIMIT,
    );
  });
});
