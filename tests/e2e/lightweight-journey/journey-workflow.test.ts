import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANES, LEFTOVER_AGE_MS, resourceNames } from './lanes.mjs';
import { ALL_CHAPTERS, vercelLane, directories } from './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  it('the journey script writes an all-skipped file and exits 0 for a lane with no credentials', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lj-dry-'));
    directories.push(directory);
    const file = path.join(directory, 'results.json');
    const run = spawnSync('node', [path.join(import.meta.dirname, 'journey.e2e.mjs')], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        LJ_LANE: vercelLane.id,
        LJ_RUN_ID: '1',
        LJ_RESULTS: file,
      },
    });
    expect(run.status, run.stderr).toBe(0);
    const { results } = JSON.parse(readFileSync(file, 'utf8')) as {
      results: Record<string, { outcome: string }>;
    };
    expect(Object.keys(results)).toEqual(ALL_CHAPTERS);
    expect(Object.values(results).every((row) => row.outcome === 'skipped')).toBe(true);
  });

  it('builds its images on the docker driver, which can push to the runner-host registry', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    // A docker-container builder pushes from its own network namespace, where localhost:5000 is
    // not the registry (run 37864353535).
    expect(workflow).not.toMatch(/docker\/setup-buildx-action|buildx\s+(?:create|use)\b/u);
  });

  it('installs the host CLIs at exact pins, wrangler at the bridge deploy’s pin, within a bound', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    const start = workflow.indexOf('- name: Install the host CLI\n');
    expect(start).toBeGreaterThan(-1);
    const step = workflow.slice(start, workflow.indexOf('\n      - name:', start + 1));
    expect(step).toMatch(/timeout-minutes: 5\b/u);
    // The bridge deploy's pin; read as text so tsc does not check the untyped bridge module.
    const bridge = readFileSync(
      path.resolve(import.meta.dirname, '../../../infra/tests/providers/cloudflare-bridge.mjs'),
      'utf8',
    );
    const wrangler = /^export const WRANGLER = '([^']+)';$/mu.exec(bridge)?.[1];
    expect(wrangler).toMatch(/^wrangler@\d+\.\d+\.\d+$/u);
    expect(step).toContain(`npm install --global ${String(wrangler)} `);
    expect(step).toMatch(/npm install --global vercel@\d+\.\d+\.\d+ /u);
  });

  it('frees the runner’s unused toolchains before the build and prints the disk either side', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    // Run 37871130400: the lanes filled the runner disk before the first journey row.
    const stepOf = (name: string) => {
      const start = workflow.indexOf(`- name: ${name}\n`);
      expect(start).toBeGreaterThan(-1);
      const next = workflow.indexOf('\n      - name:', start + 1);
      return workflow.slice(start, next === -1 ? undefined : next);
    };
    const free = stepOf('Free disk');
    expect(workflow.indexOf('- name: Free disk')).toBeLessThan(workflow.indexOf('- name: Install'));
    expect(free).toContain('sudo rm -rf');
    for (const toolchain of [
      '/usr/share/dotnet',
      '/usr/local/lib/android',
      '/opt/ghc',
      '/opt/hostedtoolcache/CodeQL',
    ]) {
      expect(free).toContain(toolchain);
    }
    expect(stepOf('Disk after the journey')).toMatch(/if: always\(\)/u);
  });

  it('tears down and uploads before the disk report, which is bounded and cannot fail the job', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    // Run 37876751956: `docker system df` hung, the job died (exit 143) and Teardown never ran.
    const at = (name: string) => workflow.indexOf(`- name: ${name}\n`);
    const names = ['Run the journey', 'Teardown', 'Upload results', 'Disk after the journey'];
    for (const name of names) expect(at(name)).toBeGreaterThan(-1);
    expect(at('Run the journey')).toBeLessThan(at('Teardown'));
    expect(at('Teardown')).toBeLessThan(at('Upload results'));
    expect(at('Upload results')).toBeLessThan(at('Disk after the journey'));
    const stepOf = (name: string) => {
      const next = workflow.indexOf('\n      - name:', at(name) + 1);
      const end = next === -1 ? workflow.indexOf('\n  summary:') : next;
      return workflow.slice(at(name), end);
    };
    const minutes = names.map((name) => Number(/timeout-minutes: (\d+)/u.exec(stepOf(name))?.[1]));
    for (const step of minutes) expect(step).toBeGreaterThan(0);
    const job = Number(/^ {4}timeout-minutes: (\d+)/mu.exec(workflow)?.[1]);
    expect(minutes.reduce((total, step) => total + step, 0)).toBeLessThan(job);
    expect(job * 60_000).toBeLessThan(LEFTOVER_AGE_MS);
    expect(stepOf('Teardown')).toContain('if: always()');
    expect(stepOf('Upload results')).toContain('if: always()');
    expect(stepOf('Disk after the journey')).toContain('timeout 30 docker system df || true');
    expect(stepOf('Disk after the journey')).toContain('df -h /');
  });

  it('derives deterministic, distinct, short, lowercase names per run and lane', () => {
    const names = LANES.map((lane) => resourceNames(lane, '123456'));
    expect(resourceNames(vercelLane, '123456')).toEqual(names[0]);
    expect(new Set(names.map((entry) => entry.project)).size).toBe(LANES.length);
    expect(resourceNames(vercelLane, '123457').project).not.toBe(names[0]?.project);
    for (const entry of names) {
      for (const name of [...entry.vercelProjects, ...entry.workers]) {
        expect(name).toMatch(/^[a-z0-9-]{1,52}$/u);
      }
    }
  });
});
