import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
let fixture: string | undefined;

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('generate-api-reports --check', () => {
  it('fails, naming the file, when a committed report is altered', async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'agent-workspace-api-reports-'));
    await cp(path.join(root, 'docs/sdk/api'), fixture, { recursive: true });
    const tampered = path.join(fixture, 'sdk/define.api.md');
    await writeFile(tampered, (await readFile(tampered, 'utf8')).replace('export ', 'export  '));
    const result = spawnSync(
      process.execPath,
      ['scripts/docs/generate-api-reports.mjs', '--check', `--reports=${fixture}`],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/sdk/api/sdk/define.api.md');
  }, 240_000);
});
