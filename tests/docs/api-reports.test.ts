/**
 * The comparison `generate-api-reports.mjs --check` runs (`pnpm docs:check`): a committed API
 * report that differs from the rendered one is named, and so is one that is missing or left over.
 * Tested on small trees: rendering the real reports emits five packages' declarations and runs API
 * Extractor over every subpath, which `pnpm docs:check` already does on every change.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { staleReports } from '../../scripts/docs/lib/api-reports-compare.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-api-reports-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

const REPORT =
  '## API Report File for "@indx-workspace/sdk"\n\nexport function defineAgent(): void;\n';

const compare = async (
  rendered: Readonly<Record<string, string>>,
  committed: Readonly<Record<string, string>>,
  normalise: (text: string) => string = (text) => text,
) =>
  await staleReports({
    rendered: await tree(rendered),
    committed: await tree(committed),
    normalise,
    label: 'docs/10-product/sdk/api',
  });

describe('generate-api-reports --check compares the rendered reports with the committed ones', () => {
  it('is clean when every committed report matches its rendering', async () => {
    const reports = { 'sdk/define.api.md': REPORT, 'contracts/index.api.md': 'x\n' };
    expect(await compare(reports, reports)).toEqual([]);
  });

  it('names a committed report that was altered, by its repository path', async () => {
    expect(
      await compare(
        { 'sdk/define.api.md': REPORT, 'contracts/index.api.md': 'x\n' },
        {
          'sdk/define.api.md': REPORT.replace('export ', 'export  '),
          'contracts/index.api.md': 'x\n',
        },
      ),
    ).toEqual(['docs/10-product/sdk/api/sdk/define.api.md']);
  });

  it('names a report the source now renders that is not committed, and one it no longer renders', async () => {
    expect(
      await compare(
        { 'sdk/define.api.md': REPORT, 'sdk/tools-host.api.md': 'new\n' },
        { 'sdk/define.api.md': REPORT, 'sdk/removed.api.md': 'old\n' },
      ),
    ).toEqual([
      'docs/10-product/sdk/api/sdk/removed.api.md',
      'docs/10-product/sdk/api/sdk/tools-host.api.md',
    ]);
  });

  it('compares the normalised rendering, never the raw one', async () => {
    const crlf = REPORT.replaceAll('\n', '\r\n');
    const lf = (text: string) => text.replaceAll('\r\n', '\n');
    expect(
      await compare({ 'sdk/define.api.md': crlf }, { 'sdk/define.api.md': REPORT }, lf),
    ).toEqual([]);
    expect(await compare({ 'sdk/define.api.md': crlf }, { 'sdk/define.api.md': REPORT })).toEqual([
      'docs/10-product/sdk/api/sdk/define.api.md',
    ]);
  });

  it('treats a missing committed directory as no reports at all', async () => {
    expect(
      await staleReports({
        rendered: await tree({ 'sdk/define.api.md': REPORT }),
        committed: path.join(await tree({}), 'absent'),
        normalise: (text) => text,
        label: 'docs/10-product/sdk/api',
      }),
    ).toEqual(['docs/10-product/sdk/api/sdk/define.api.md']);
  });
});
