import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempDirectory } from '../testing.js';
import { AW_VERSION } from '../version.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The app kit's `aw-app` bin, stubbed: `sql` prints a fixed table, and `recipe-on` refuses a cron
 * whose minute is 61 (as croner does) and accepts every other one, recording what it was asked.
 */
const STUB_BIN = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  'const [, , command, ...rest] = process.argv;',
  "if (command === 'sql') { const { name } = JSON.parse(rest[2]); process.stdout.write('CREATE TABLE \"' + name + 's\" ();\\n'); process.exit(0); }",
  "if (command === 'recipe-on') {",
  "  fs.appendFileSync('recipe-on.log', JSON.stringify(rest) + '\\n');",
  "  if (rest[0].startsWith('61 ')) { process.stderr.write('error: the schedule is refused: cron is not a cron expression croner accepts\\n'); process.exit(1); }",
  "  process.stdout.write('ok\\n'); process.exit(0);",
  '}',
  "process.stderr.write('error: bad line\\n'); process.exit(2);",
  '',
].join('\n');

async function project(): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  await writeFile(path.join(root, 'package.json'), '{\n  "name": "crm",\n  "private": true\n}\n');
  const kit = path.join(root, 'node_modules', '@indx-workspace', 'app');
  await mkdir(kit, { recursive: true });
  await writeFile(
    path.join(kit, 'package.json'),
    JSON.stringify({
      name: '@indx-workspace/app',
      version: AW_VERSION,
      bin: { 'aw-app': './bin.cjs' },
    }),
  );
  await writeFile(path.join(kit, 'bin.cjs'), STUB_BIN);
  return root;
}

/** Every file under `root` with its text, `node_modules` and the stub's log aside. */
async function tree(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (relative === 'node_modules' || relative === 'recipe-on.log') continue;
    if (entry.isDirectory()) Object.assign(result, await tree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), 'utf8');
  }
  return result;
}

function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

const aw = (cwd: string, argv: readonly string[]) => runCli(argv, { cwd, env: {} });

/** A generated app with one resource, `contact`. */
async function crm(): Promise<string> {
  const root = await project();
  expect((await aw(root, ['generate', 'app', 'crm'])).code).toBe(EXIT_CODE.ok);
  expect((await aw(root, ['generate', 'resource', 'contact', 'name:text(200)'])).code).toBe(
    EXIT_CODE.ok,
  );
  return root;
}

const ENRICH = ['generate', 'recipe', 'enrich-contact', '--on', 'resource:contact.created'];
const SWEEP = ['generate', 'recipe', 'sla-sweep', '--on', 'schedule:*/5 * * * *'];

describe('aw generate recipe (#1514)', () => {
  it('writes exactly the recipe and its test, adds it to app.config.ts and records it', async () => {
    const root = await crm();
    const before = await tree(root);

    const run = await aw(root, ENRICH);
    const after = await tree(root);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(changed(before, after)).toEqual([
      'app.config.ts',
      'aw-generated.json',
      'recipes/enrich-contact.ts',
      'tests/recipes/enrich-contact.test.ts',
    ]);
    expect(after['recipes/enrich-contact.ts']).toContain(
      "on: resourceEvent('contact', 'created'),",
    );
    expect(after['app.config.ts']).toContain(
      "import enrichContactRecipe from './recipes/enrich-contact.ts';",
    );
    expect(after['app.config.ts']).toContain('  recipes: [\n    enrichContactRecipe,\n  ],');
    const manifest = JSON.parse(after['aw-generated.json'] ?? '{}') as {
      entries: Record<string, { files: Record<string, string>; edits: unknown[] }>;
    };
    const entry = manifest.entries['recipe:enrich-contact'];
    expect(Object.keys(entry?.files ?? {})).toEqual([
      'recipes/enrich-contact.ts',
      'tests/recipes/enrich-contact.test.ts',
    ]);
    expect(entry?.edits).toHaveLength(2);
  });

  it("writes a schedule in UTC, checked by the project's aw-app recipe-on", async () => {
    const root = await crm();

    const run = await aw(root, SWEEP);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(root, 'recipes/sla-sweep.ts'), 'utf8')).toContain(
      "on: schedule('*/5 * * * *', 'UTC'),",
    );
    expect(await readFile(path.join(root, 'recipe-on.log'), 'utf8')).toBe(
      '["*/5 * * * *","--tz","UTC"]\n',
    );
    const tokyo = await aw(root, [
      'generate',
      'recipe',
      'morning',
      '--on',
      'schedule:0 9 * * 1-5',
      '--tz',
      'Asia/Tokyo',
    ]);
    expect(tokyo.code).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(root, 'recipes/morning.ts'), 'utf8')).toContain(
      "on: schedule('0 9 * * 1-5', 'Asia/Tokyo'),",
    );
  });

  it('refuses an unknown resource, an invalid cron and no --on as usage errors, writing nothing', async () => {
    const root = await crm();
    const before = await tree(root);

    const unknown = await aw(root, ['generate', 'recipe', 'x', '--on', 'resource:lead.created']);
    const badCron = await aw(root, ['generate', 'recipe', 'x', '--on', 'schedule:61 * * * *']);
    const noOn = await aw(root, ['generate', 'recipe', 'x']);

    expect([unknown.code, badCron.code, noOn.code]).toEqual([
      EXIT_CODE.usage,
      EXIT_CODE.usage,
      EXIT_CODE.usage,
    ]);
    expect(unknown.stderr).toContain('names no resource of this app: lead (it has contact)');
    expect(badCron.stderr).toContain('cron is not a cron expression croner accepts');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses a recipe already generated, and one with no generated app', async () => {
    const root = await crm();
    await aw(root, ENRICH);

    const again = await aw(root, ENRICH);
    const bare = await aw(await project(), ENRICH);

    expect(again.code).toBe(EXIT_CODE.problem);
    expect(again.stderr).toContain('recipe enrich-contact is already generated');
    expect(bare.code).toBe(EXIT_CODE.problem);
    expect(bare.stderr).toContain('there is no generated app here');
  });
});

describe('aw destroy recipe (#1514)', () => {
  it('destroy recipe refuses an edited file', async () => {
    const root = await crm();
    await aw(root, ENRICH);
    await writeFile(path.join(root, 'recipes/enrich-contact.ts'), '// mine now\n');
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'recipe', 'enrich-contact', '--yes']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('edited since they were generated:\n  recipes/enrich-contact.ts');
    expect(await tree(root)).toEqual(before);
  });

  it('removes both files and reverts app.config.ts, byte for byte', async () => {
    const root = await crm();
    const before = await tree(root);
    await aw(root, ENRICH);

    const run = await aw(root, ['destroy', 'recipe', 'enrich-contact', '--yes']);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('removed recipes/enrich-contact.ts');
    expect(run.stdout).toContain('removed tests/recipes/enrich-contact.test.ts');
    expect(run.stdout).toContain('reverted app.config.ts');
    expect(await tree(root)).toEqual(before);
  });
});
