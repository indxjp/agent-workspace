import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  definePublicSource,
  publicSourceRun,
  type PublicSourceSnapshot,
} from '@indx-workspace/sdk/define';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

import { tempDirectory, tempFile } from '../testing.js';

/**
 * ADR-0170 D4: the demo's records stand-in runs `PUBLIC_SOURCE_SNAPSHOT_SCRIPT`, the source text of
 * the SDK's answer function. A production server bundle is minified, which renames functions, so
 * the script must not depend on any name the minifier chooses. This test minifies the SDK as a
 * bundler would (esbuild, the bundler `aw push` uses), takes the script from the minified build, and
 * runs it in a bare process, as the stand-in does.
 */
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SNAPSHOT: PublicSourceSnapshot = {
  asOf: '2026-11-20',
  items: [
    {
      source: 'Sample Agency',
      url: 'https://agency.example.org/notice/101',
      title: 'Sample guideline revised',
      summary: 'Fictional.',
      publishedAt: '2026-10-01',
      retrievedAt: '2026-11-01',
    },
    {
      id: 'SP-7',
      source: 'Sample List',
      url: 'https://lists.example.org/list.csv',
      title: 'Sample Trading Co.',
      summary: 'Listed party (fictional).',
      publishedAt: '2026-11-15T09:00:00+09:00',
      retrievedAt: '2026-11-20',
      fields: { country: 'XA' },
    },
  ],
};

/**
 * The script as the SDK's `define` entry exports it once bundled and minified. The minified module
 * is loaded by a child process, so this file names no module it cannot state.
 */
async function minifiedScript(): Promise<string> {
  const root = await tempDirectory();
  roots.push(root);
  const output = await build({
    stdin: {
      contents: "export { PUBLIC_SOURCE_SNAPSHOT_SCRIPT } from '@indx-workspace/sdk/define';",
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const [bundle] = output.outputFiles;
  if (bundle === undefined) throw new Error('esbuild wrote nothing');
  const file = await tempFile(root, 'define.min.mjs', bundle.contents);
  const loader = `import { PUBLIC_SOURCE_SNAPSHOT_SCRIPT } from ${JSON.stringify(pathToFileURL(file).href)};\nprocess.stdout.write(PUBLIC_SOURCE_SNAPSHOT_SCRIPT);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', loader], {
    encoding: 'utf8',
    env: {},
  });
  expect(run.stderr).toBe('');
  return run.stdout;
}

/** What the script answers in a bare Node process with no import, as the stand-in runs it. */
function standInAnswer(script: string, args: unknown): unknown {
  const program = `${script}\nprocess.stdout.write(JSON.stringify(answerPublicSourceSnapshot(${JSON.stringify(SNAPSHOT)}, ${JSON.stringify(args)})));`;
  const run = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', env: {} });
  expect(run.stderr).toBe('');
  return JSON.parse(run.stdout) as unknown;
}

describe('the public-source selection script from a minified build', () => {
  it('still answers as the tool does', async () => {
    const script = await minifiedScript();
    // The build is minified: the answer function no longer has its source name.
    expect(script).not.toContain('function answerPublicSource(');
    const run = publicSourceRun(definePublicSource({ mode: 'snapshot', snapshot: SNAPSHOT }));
    const signal = new AbortController().signal;
    for (const args of [{}, { query: 'xa' }, { since: '2026-11-15' }, { limit: 1 }]) {
      expect(standInAnswer(script, args)).toEqual({
        query: args,
        answer: await run(args, { signal }),
      });
    }
    expect(standInAnswer(script, { limit: 0 })).toEqual({ error: true });
  });
});
