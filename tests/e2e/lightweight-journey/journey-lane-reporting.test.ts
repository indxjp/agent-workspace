import { journeySource } from './journey-test-fixtures.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IGNORED_STORAGE_VARIABLES } from '@indx-workspace/contracts/storage-settings';
import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { describe, expect, it } from 'vitest';
import { storageEntries } from './journey.e2e.mjs';
import { LANES, resultsWriter } from './lanes.mjs';
import {
  SUMMARY,
  ALL_CHAPTERS,
  cloudflareLane,
  directories,
  stderr,
  outcomes,
  credentials,
} from './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  it('builds the E2B runtime template from the checkout and never reads the released-image variable', () => {
    const source = journeySource();
    expect(source).toContain('const [runtimeTemplate, toolHostTemplate] = await Promise.all([');
    expect(source).toContain('E2B_RUNTIME_TEMPLATE: runtimeTemplate,');
    expect(source).toContain('E2B_TOOL_HOST_TEMPLATE: toolHostTemplate,');
    expect(source).toContain('...runtimeBuild(ROOT)');
    expect(source).toContain('...toolHostBuild(ROOT)');
    expect(source).not.toContain("process.env['E2B_RUNTIME_TEMPLATE']");
    const workflow = readFileSync(
      path.join(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    expect(workflow).not.toMatch(/^\s+E2B_RUNTIME_TEMPLATE:/mu);
  });

  it('places every lane in its own reused R2 bucket through AW_STORAGE_URL, with no ignored name', () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'key',
    };
    for (const lane of LANES) {
      const entries = storageEntries(lane.key, env);
      for (const name of IGNORED_STORAGE_VARIABLES)
        expect(entries, lane.id).not.toHaveProperty(name);
      expect(parseStorageUrl(entries.AW_STORAGE_URL), lane.id).toEqual({
        ok: true,
        location: {
          kind: 's3',
          bucket: `awlj-${lane.key}-files`,
          prefix: '',
          endpoint: 'https://acct123.r2.cloudflarestorage.com',
          region: 'auto',
          forcePathStyle: false,
        },
      });
      expect(entries.OBJECT_STORAGE_ACCESS_KEY_ID).toBe('id');
      expect(entries.OBJECT_STORAGE_SECRET_ACCESS_KEY).toBe('key');
    }
    const source = journeySource();
    expect(source).toContain('Object.assign(entries, storageEntries(lane.key, process.env));');
    for (const name of IGNORED_STORAGE_VARIABLES) expect(source, name).not.toContain(name);
  });

  it('runs the two E2B lanes one after the other and every other lane in a group of its own', () => {
    const workflow = readFileSync(
      path.join(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    expect(workflow).toContain(
      "group: lightweight-journey-${{ endsWith(matrix.lane, '-e2b') && 'e2b' || matrix.lane }}",
    );
    expect(LANES.filter((lane) => lane.sandbox === 'e2b').map((lane) => lane.id)).toEqual([
      'vercel-e2b',
      'cloudflare-e2b',
    ]);
  });

  it('sweeps the E2B lane sandboxes by workspace after the chapters, on success and failure alike', () => {
    const source = journeySource();
    const after = source.slice(source.indexOf('await runChapters(lane, process.env, steps'));
    expect(after).toMatch(
      /finally \{[\s\S]*if \(lane\.sandbox === 'e2b'\) await sweepE2bSandboxes\(\);/u,
    );
    expect(source).toContain("s['workspaceId'] = me.json.workspaceId");
    // A lane that never learned its workspace fails the sweep instead of skipping it.
    const sweep = source.slice(source.indexOf('async function sweepE2bSandboxes'));
    expect(sweep).toMatch(/try \{[\s\S]*?check\(\s*typeof workspaceId === 'string',/u);
    expect(sweep.slice(0, sweep.indexOf('killLaneSandboxes'))).not.toContain('return;');
  });

  it('records a throwing deploy as fail with the reason, redacted, and the rest as not reached', async () => {
    const env = credentials(cloudflareLane);
    const token = env['CLOUDFLARE_API_TOKEN'] ?? '';
    const { rows, ran } = await outcomes(cloudflareLane, env, {
      deploy: () =>
        Promise.reject(
          new Error(`Unauthorized: needs Containers: Edit (token ${token}, minted-secret-value)`),
        ),
    });
    expect(ran).toEqual(['create', 'eval']);
    expect(rows['deploy']?.outcome).toBe('fail');
    expect(rows['deploy']?.detail).toContain('Containers: Edit');
    expect(rows['deploy']?.detail).not.toContain(token);
    expect(rows['deploy']?.detail).not.toContain('minted-secret-value');
    for (const id of ALL_CHAPTERS.slice(3)) {
      expect(rows[id]?.outcome).toBe('fail');
      expect(rows[id]?.detail).toContain('not reached');
    }
  });

  it('prints a failing chapter’s redacted message to stderr, not only to the results file', async () => {
    const env = credentials(cloudflareLane);
    const token = env['CLOUDFLARE_API_TOKEN'] ?? '';
    await outcomes(cloudflareLane, env, {
      deploy: () =>
        Promise.reject(new Error(`wrangler: Unauthorized (token ${token}, minted-secret-value)`)),
    });
    const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(printed).toContain('chapter "deploy" failed');
    expect(printed).toContain('wrangler: Unauthorized');
    expect(printed).toContain('[redacted]');
    expect(printed).not.toContain(token);
    expect(printed).not.toContain('minted-secret-value');
  });

  it('is never clean in the isolation summary unless every row passed', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lj-summary-'));
    directories.push(directory);
    const file = path.join(directory, 'results.json');
    const write = (rows: Record<string, string>) => {
      const record = resultsWriter('lane', (target, text) => writeFileSync(target, text), file);
      for (const [id, outcome] of Object.entries(rows)) record(id, outcome);
      return spawnSync('node', [SUMMARY, `lane=${file}`], { encoding: 'utf8' });
    };
    const allPass = Object.fromEntries(ALL_CHAPTERS.map((id) => [id, 'pass']));
    expect(write(allPass).status).toBe(0);
    expect(write({ ...allPass, rollback: 'skipped' }).status).toBe(1);
    const failed = write({ ...allPass, deploy: 'fail' });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('fail');
    expect((JSON.parse(readFileSync(file, 'utf8')) as { lane: string }).lane).toBe('lane');
  });
});
