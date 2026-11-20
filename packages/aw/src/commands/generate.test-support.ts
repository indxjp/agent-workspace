import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, expect } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempDirectory } from '../testing.js';
import { AW_VERSION } from '../version.js';

const temporary: string[] = [];

/** Removes every project directory the calling suite created, after each test. */
export function removeProjectsAfterEach(): void {
  afterEach(async () => {
    for (const directory of temporary.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

const PACKAGE_JSON = '{\n  "name": "desk",\n  "private": true\n}\n';

/**
 * The app kit's `aw-app` bin, stubbed: it prints a fixed SQL text naming the resource it was
 * given, so the suite never needs a built app kit.
 */
const STUB_BIN = [
  '#!/usr/bin/env node',
  'const [, , command, flag, app, spec] = process.argv;',
  "if (command !== 'sql' || flag !== '--app') { process.stderr.write('error: bad line\\n'); process.exit(2); }",
  'const { name } = JSON.parse(spec);',
  "process.stdout.write('-- fixed SQL for ' + app + '\\nCREATE TABLE \"' + name + 's\" ();\\n');",
  '',
].join('\n');

/** A project with a `package.json` and the stubbed app kit installed at `aw`'s version. */
export async function project(): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  await writeFile(path.join(root, 'package.json'), PACKAGE_JSON);
  const kit = path.join(root, 'node_modules', '@indx-workspace', 'app');
  await mkdir(kit, { recursive: true });
  await writeFile(
    path.join(kit, 'package.json'),
    JSON.stringify({
      name: '@indx-workspace/app',
      version: AW_VERSION,
      bin: { 'aw-app': './bin.js' },
    }),
  );
  await writeFile(path.join(kit, 'bin.js'), STUB_BIN);
  return root;
}

/** Every file (with its text) and directory under `root`, `node_modules` aside. */
export async function tree(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (relative === 'node_modules') continue;
    if (entry.isDirectory()) {
      result[`${relative}/`] = '';
      Object.assign(result, await tree(root, relative));
    } else {
      result[relative] = await readFile(path.join(root, relative), 'utf8');
    }
  }
  return result;
}

/** The paths that appeared or changed from `before` to `after`. */
export function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after)
    .filter((key) => !key.endsWith('/') && before[key] !== after[key])
    .sort();
}

export function aw(cwd: string, argv: readonly string[]) {
  return runCli(argv, { cwd, env: {} });
}

export const RESOURCE = [
  'generate',
  'resource',
  'ticket',
  'title:text(200)',
  'status:enum(new,closed)',
];

export async function generatedApp(): Promise<string> {
  const root = await project();
  expect((await aw(root, ['generate', 'app', 'service-desk'])).code).toBe(EXIT_CODE.ok);
  return root;
}

/** A generated app with a room and a message keyed on it, ready for `generate channel`. */
export async function chatApp(): Promise<string> {
  const root = await generatedApp();
  expect((await aw(root, ['generate', 'resource', 'room', 'title:text(80)'])).code).toBe(0);
  const message = await aw(root, [
    'generate',
    'resource',
    'message',
    'thread_root:ref(message)?',
    'room:ref(room)',
    'body:text',
  ]);
  expect(message.code).toBe(0);
  return root;
}
