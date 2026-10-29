// The live eleven-step job (`.github/workflows/live-e2e.yml`) runs the root `compose.yaml`, so every
// variable the compose file requires (`${NAME:?…}`) must be set for it: by the job's `env`, by the
// `.env` it copies from `.env.example`, or by the lines that step writes into that `.env`. A gap
// fails `docker compose` at interpolation, before any acceptance step runs (#1925 item 1).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { workflowJobs } from '../scripts/ci/workflow-jobs.mjs';

import { parseDotEnv } from './generated-project/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

function requiredByCompose(compose: string): Set<string> {
  return new Set(Array.from(compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/gu), (m) => m[1] ?? ''));
}

/** The names a job sets: its `env:` keys, plus `.env.example` and the `.env` lines its steps write. */
function namesSetFor(job: string, example: Record<string, string>): Set<string> {
  const names = new Set<string>();
  const lines = job.split('\n');
  const envStart = lines.findIndex((line) => line === '    env:');
  if (envStart !== -1) {
    for (const line of lines.slice(envStart + 1)) {
      const key = /^ {6}([A-Z][A-Z0-9_]*):/u.exec(line)?.[1];
      if (key === undefined) break;
      names.add(key);
    }
  }
  if (job.includes('cp .env.example .env')) {
    for (const [name, value] of Object.entries(example)) if (value !== '') names.add(name);
    for (const match of job.matchAll(/s\/\^([A-Z][A-Z0-9_]*)=\.\*\/\1=\S/gu)) {
      names.add(match[1] ?? '');
    }
    for (const match of job.matchAll(/echo "([A-Z][A-Z0-9_]*)=\S/gu)) names.add(match[1] ?? '');
  }
  return names;
}

function jobText(workflow: string, id: string): string {
  const job = workflowJobs(workflow).find((candidate) => candidate.id === id);
  if (job === undefined) throw new Error(`${id} is missing`);
  return job.lines.map(({ text }) => text).join('\n');
}

describe('the live eleven-step compose env', () => {
  const example = parseDotEnv(read('.env.example'));
  const required = requiredByCompose(read('compose.yaml'));
  const job = jobText(read('.github/workflows/live-e2e.yml'), 'eleven-step');

  it('sets every variable compose.yaml requires', () => {
    expect(required).toContain('AW_STORAGE_URL');
    expect(required).toContain('RUNNER_MANAGER_TOKEN');
    const names = namesSetFor(job, example);
    expect([...required].filter((name) => !names.has(name))).toEqual([]);
  });

  it('writes the .env before compose starts', () => {
    const configured = job.indexOf('cp .env.example .env');
    expect(configured).toBeGreaterThan(-1);
    expect(configured).toBeLessThan(job.indexOf('docker compose up'));
  });

  it('reads a gap as missing', () => {
    const bare = '    env:\n      DATABASE_URL: x\n    steps:\n      - run: docker compose up';
    expect(namesSetFor(bare, example)).toEqual(new Set(['DATABASE_URL']));
    const written = `${bare}\n      - run: |\n          cp .env.example .env\n          sed -i "s/^RUNNER_MANAGER_TOKEN=.*/RUNNER_MANAGER_TOKEN=$(openssl rand -hex 24)/" .env`;
    expect(namesSetFor(written, example)).toContain('RUNNER_MANAGER_TOKEN');
    expect(namesSetFor(written, example)).toContain('AW_STORAGE_URL');
  });
});
