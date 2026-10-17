import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const status = JSON.parse(readFileSync(new URL('docs/capabilities/status.json', root), 'utf8')) as {
  canonical?: boolean;
  releaseVerdict?: string;
  capabilities?: Array<{ area?: string; status?: string; evidence?: string[] }>;
};

describe('canonical capability ledger', () => {
  it('uses the closed status vocabulary, unique areas, and repository evidence', () => {
    const allowed = new Set([
      'implemented',
      'partial',
      'fixture-verified',
      'live-verified',
      'deferred',
      'unsupported',
    ]);
    expect(status.canonical).toBe(true);
    expect(status.releaseVerdict).toBe('blocked');
    expect(status.capabilities?.length).toBeGreaterThan(0);
    const areas = status.capabilities?.map((item) => item.area) ?? [];
    expect(new Set(areas).size).toBe(areas.length);
    for (const item of status.capabilities ?? []) {
      expect(allowed.has(item.status ?? ''), item.area).toBe(true);
      expect(item.evidence?.length, item.area).toBeGreaterThan(0);
      for (const evidence of item.evidence ?? []) {
        expect(existsSync(new URL(evidence, root)), `${item.area}: ${evidence}`).toBe(true);
      }
    }
  });

  it('keeps the generated Markdown synchronized', () => {
    const result = spawnSync(process.execPath, ['scripts/status/render.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
