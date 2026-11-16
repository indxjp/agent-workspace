/**
 * The daily workflow runs the free sample check every night and the spending production test only
 * while a person has enabled it, and is never part of the required checks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const text = read('../../../.github/workflows/store-daily.yml');
const code = text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** The workflow's jobs, by id, with their lines. */
function jobs(): Map<string, string> {
  const section = /^jobs:\n([\s\S]*)$/mu.exec(code)?.[1] ?? '';
  const parts = section.split(/^ {2}([a-z-]+):\n/mu);
  const found = new Map<string, string>();
  for (let index = 1; index < parts.length; index += 2) {
    found.set(parts[index] ?? '', parts[index + 1] ?? '');
  }
  return found;
}

describe('store-daily.yml', () => {
  it('runs on a schedule and on dispatch, never on a pull request or a push', () => {
    const on = /^on:\n((?: {2}.*\n|\n)+)/mu.exec(code)?.[1] ?? '';
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]);
    expect(triggers).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('has one schedule, so the spending job can start only once a day', () => {
    const on = /^on:\n((?: {2}.*\n|\n)+)/mu.exec(code)?.[1] ?? '';
    expect(on.match(/^\s+- cron:/gmu)).toHaveLength(1);
  });

  it('is inert until the production address is set, for both jobs, and only on the INDXDev repository', () => {
    const all = jobs();
    expect([...all.keys()]).toEqual(['sample-check', 'daily-test']);
    for (const [id, lines] of all) {
      const condition = /^ {4}if: (.*)$/mu.exec(lines)?.[1] ?? '';
      expect(condition, id).toMatch(/^github\.repository_owner == 'INDXDev' && /u);
      expect(condition, id).toContain("vars.STORE_PRODUCTION_URL != ''");
    }
  });

  it('spends only while STORE_DAILY_TEST is enabled: the sample check never has the spend opt-in', () => {
    const all = jobs();
    expect(all.get('daily-test')).toContain("vars.STORE_DAILY_TEST == 'enabled'");
    expect(all.get('sample-check')).not.toContain('STORE_DAILY_TEST');
    expect(all.get('sample-check')).not.toContain('STORE_LIVE_VERIFY');
    expect(all.get('sample-check')).not.toContain('VERIFY_API_KEY');
    // The opt-in the harness reads appears once, in the spending job's run step.
    expect(code.match(/STORE_LIVE_VERIFY: spend-approved/gu)).toHaveLength(1);
    expect(all.get('daily-test')).toContain('STORE_LIVE_VERIFY_ENVIRONMENT: production');
  });

  it('gives each secret to the one step that runs the command, never to a checkout, install or build', () => {
    for (const [id, lines] of jobs()) {
      const steps = lines.split('      - name: ').slice(1);
      for (const step of steps) {
        const usesSecret = step.includes('secrets.');
        expect(usesSecret, `${id}: ${step.split('\n')[0] ?? ''}`).toBe(
          step.includes('node tests/store/daily/run.ts'),
        );
      }
    }
    const names = [...code.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/gu)].map((match) => match[1]);
    expect(new Set(names)).toEqual(
      new Set(['STORE_OPERATOR_TOKEN', 'STORE_PRODUCTION_VERIFY_API_KEY']),
    );
  });

  it('keeps the evidence as an artifact and never writes the committed file or pushes', () => {
    expect(code).toContain('name: store-daily-evidence');
    expect(code).not.toContain('real-model-runs.json');
    expect(code).not.toMatch(/git (push|commit)/u);
  });

  it('pins every action to a commit', () => {
    const uses = [...code.matchAll(/^\s+uses: (\S+)/gmu)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) expect(reference).toMatch(/@[0-9a-f]{40}$/u);
  });

  it('is no ci-success need', () => {
    expect(read('../../../.github/workflows/ci.yml')).not.toContain('store-daily');
  });
});
