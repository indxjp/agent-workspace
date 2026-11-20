/**
 * The ADR index renderer, on a fixture directory. Its two properties of the real docs/adr/ — every
 * record indexed, no index committed into the README — are tests/docs/adr-index.docs-check.ts,
 * in `pnpm docs:check`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { renderAdrIndex } from '../../scripts/docs/adr-index.mjs';

let fixture: string | undefined;

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('renderAdrIndex', () => {
  it('reads all three header shapes into one sorted table with its count', async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'agent-workspace-adr-index-'));
    await writeFile(path.join(fixture, 'README.md'), '# not a record\n');
    await writeFile(
      path.join(fixture, '0002-lines.md'),
      '# ADR-0002 — Separate lines\r\n\r\nStatus: Accepted\r\nDate: 2026-09-03\r\nScope: whole programme\r\n',
    );
    await writeFile(
      path.join(fixture, 'W0-DOC-01-dotted.md'),
      '# W0-DOC-01 · One dotted line\n\nStatus: accepted · Date: 2026-09-04 · Task: W0-DOC-01 \n',
    );
    await writeFile(
      path.join(fixture, 'W0-INF-01-list.md'),
      '# 0003 - List form\n\n- **Status:** proposed\n- **Date:** 2026-09-05\n- **Context task:** W0-INF-01\n',
    );

    expect(await renderAdrIndex(fixture)).toBe(
      [
        '**3 records** in `docs/adr/`.',
        '',
        '| Id | Title | Date | Scope | Status |',
        '| --- | --- | --- | --- | --- |',
        '| [0002](0002-lines.md) | Separate lines | 2026-09-03 | whole programme | accepted |',
        '| [W0-DOC-01](W0-DOC-01-dotted.md) | One dotted line | 2026-09-04 | task W0-DOC-01 | accepted |',
        '| [W0-INF-01](W0-INF-01-list.md) | List form | 2026-09-05 | task W0-INF-01 | proposed |',
        '',
      ].join('\n'),
    );
  });
});
