/**
 * The recipe `aw generate recipe` writes, run as its project would run it (issue #1514). Both
 * template variants are kept here as the files the generator writes, in a project's layout:
 * `<name>/recipes/<name>.ts` and its generated test. The first case of each variant renders the
 * template through the SDK and requires it to equal those files byte for byte, so a template
 * change that is not reflected here fails; the second executes the generated test unmodified
 * against this app kit's own source.
 *
 * The generated test is kept as `<name>.node-test.ts` rather than `<name>.test.ts`, its only
 * difference from the generated path, because it is a `node:test` file and Vitest would otherwise
 * collect it as one of its own. Here `node:test`'s `test` collects its cases instead. Each one is
 * loaded through a literal import, so the import gates can read which module it names, and
 * `@indx-workspace/app` resolves to this package's source rather than its build.
 *
 * shortcut: this emulates a generated app (the kept files, a mocked `node:test`, the app kit's
 * source) rather than running `aw generate app`, then `aw generate recipe`, then the project's own
 * test script in a temp directory; upgrade when the create-output lane can install the workspace
 * packages into a generated project. The generator also edits `app.config.ts` and
 * `aw-generated.json`; the SDK's project generate tests cover those edits, not this file.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderGeneratorTemplate, renderRecipeSpec } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';

const collected = vi.hoisted(() => [] as { name: string; fn: () => Promise<void> }[]);

vi.mock('node:test', () => ({
  test: (name: string, fn: () => Promise<void>) => {
    collected.push({ name, fn });
  },
}));

// The project imports the app kit by its package name; here that name is this package's source.
vi.mock('@indx-workspace/app', () => import('../../src/index.ts'));
vi.mock('@indx-workspace/app/testing', () => import('../../src/testing/index.ts'));

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Where the file the generator writes at `generated` is kept for the recipe `name`. */
const keptAt = (name: string, generated: string): string =>
  path.join(HERE, name, generated.replace(/\.test\.ts$/, '.node-test.ts'));

const VARIANTS = [
  {
    name: 'enrich-contact',
    on: 'resource:contact.created',
    load: () => import('./enrich-contact/tests/recipes/enrich-contact.node-test.ts'),
  },
  {
    name: 'sla-sweep',
    on: 'schedule:*/5 * * * *',
    load: () => import('./sla-sweep/tests/recipes/sla-sweep.node-test.ts'),
  },
] as const;

describe('the generated recipe test (#1514)', () => {
  it.each(VARIANTS)('$name: the kept files are what the generator writes', async ({ name, on }) => {
    const { values } = renderRecipeSpec(name, { on, resources: ['contact'] });
    const files = renderGeneratorTemplate('recipe', values);
    expect(files.map((file) => file.path).sort()).toEqual([
      `recipes/${name}.ts`,
      `tests/recipes/${name}.test.ts`,
    ]);
    for (const file of files) {
      expect(await readFile(keptAt(name, file.path), 'utf8'), file.path).toBe(file.contents);
    }
  });

  it.each(VARIANTS)('$name: its generated test passes unmodified', async ({ name, load }) => {
    collected.length = 0;
    await load();
    expect(collected.map((each) => each.name)).toEqual([
      `${name} completes, starting one run for its step`,
    ]);
    for (const each of collected) await each.fn();
  });
});
