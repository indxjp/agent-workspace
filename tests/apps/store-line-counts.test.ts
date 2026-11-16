/**
 * The Agent Store's published line counts (R8): the handwritten lines of each reference app,
 * read from the apps benchmark, never typed by hand.
 *
 * `examples/store/catalog/line-counts.generated.ts` holds them. A hand edit, or an app that
 * grew, fails here; `APPS_WRITE=1 pnpm vitest run --project tests tests/apps` rewrites it (the
 * same flag that rewrites the scoreboard in `examples/README.md`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseGeneratedManifest } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { countHandwritten } from './benchmark.ts';
import { loadExampleApps, REPOSITORY_ROOT } from './registry.ts';

const WRITE = process.env['APPS_WRITE'] === '1';
const GENERATED = path.join(REPOSITORY_ROOT, 'examples/store/catalog/line-counts.generated.ts');

interface Measured {
  readonly id: string;
  readonly handwritten: number;
  readonly budget: number;
}

const HEADER = `// Generated from tests/apps/benchmark.ts by \`APPS_WRITE=1 pnpm vitest run --project tests tests/apps\`.
// Do not edit by hand: tests/apps/store-line-counts.test.ts fails when it differs from the benchmark.
`;

/** The generated file's text for these measurements, in the order given. */
function renderLineCounts(measured: readonly Measured[]): string {
  const rows = measured.map(
    ({ id, handwritten, budget }) =>
      `  ${/^[A-Za-z_]\w*$/.test(id) ? id : `'${id}'`}: { handwritten: ${String(handwritten)}, budget: ${String(budget)} },\n`,
  );
  return `${HEADER}
import type { LineCount } from './define.ts';

/** Handwritten lines against budget, keyed by the \`examples/<id>\` directory. */
export const LINE_COUNTS: Readonly<Record<string, LineCount>> = {
${rows.join('')}};
`;
}

const references = loadExampleApps().filter(({ benchmark }) => benchmark.reference);

async function measureReferences(): Promise<Measured[]> {
  return Promise.all(
    references.map(async ({ benchmark, dir }) => {
      const manifest = parseGeneratedManifest(
        await readFile(path.join(dir, 'aw-generated.json'), 'utf8'),
      );
      const { lines } = await countHandwritten(dir, manifest);
      return { id: benchmark.id, handwritten: lines, budget: benchmark.budget };
    }),
  );
}

describe('the Agent Store line counts', () => {
  it('examples/store/catalog/line-counts.generated.ts matches the apps benchmark', async () => {
    const expected = renderLineCounts(await measureReferences());
    if (WRITE) {
      await writeFile(GENERATED, expected);
      return;
    }
    const text = await readFile(GENERATED, 'utf8').catch(() => '');
    expect(
      text,
      'examples/store/catalog/line-counts.generated.ts is stale; run with APPS_WRITE=1',
    ).toBe(expected);
  });

  it('renders every reference app and nothing else', async () => {
    const measured = await measureReferences();
    const text = renderLineCounts(measured);
    const keys = [...text.matchAll(/^ {2}'?([\w-]+)'?:/gm)].map((match) => match[1]);
    expect(keys).toStrictEqual(references.map(({ benchmark }) => benchmark.id));
    expect(keys).not.toContain('minimal');
    expect(text).toContain("import type { LineCount } from './define.ts';");
    expect(text.match(/^import /gm)).toHaveLength(1);
  });

  it('renders a different file when a handwritten count changes', () => {
    const before = [{ id: 'wiki', handwritten: 59, budget: 100 }];
    const after = [{ id: 'wiki', handwritten: 60, budget: 100 }];
    expect(renderLineCounts(before)).not.toBe(renderLineCounts(after));
    expect(renderLineCounts(before)).toBe(renderLineCounts([...before]));
    expect(renderLineCounts(after)).toContain('wiki: { handwritten: 60, budget: 100 }');
  });
});
