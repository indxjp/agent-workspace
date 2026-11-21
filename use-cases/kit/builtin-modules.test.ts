/**
 * A use case's skill script imports the table reader and the command line by their package path
 * (ADR-0173), the one specifier that resolves both here, through `node_modules`, and in a run, where
 * `run_skill_script` maps it to the placed office-reader (`tests/engine/run-skill-script.test.ts`).
 * This holds the repository half for the use cases' own TypeScript, Vitest and budget settings.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { readTable } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';
import { describe, expect, it } from 'vitest';

describe('the built-in modules a use case’s skill script imports', () => {
  it('resolve by package path, with typed rows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'builtin-modules-'));
    const file = path.join(dir, '予実.csv');
    await writeFile(file, '年月,予算\n2026-09,"1,200"\n');
    const out: string[] = [];
    const code = runScript(
      [file],
      { usage: 'x.mjs <file>', positionals: ['file'] },
      ({ positionals }) =>
        readTable(positionals.file, {
          columns: { month: ['年月', 'month'], budget: { names: ['予算'], type: 'whole' } },
        }).rows,
      { stdout: { write: (text: string) => out.push(text) }, stderr: { write: () => true } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toStrictEqual([{ month: '2026-09', budget: 1200 }]);
  });
});
