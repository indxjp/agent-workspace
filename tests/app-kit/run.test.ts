import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import {
  casesOf,
  ciRunSteps,
  pkcePair,
  readmeCommands,
  removeWorkDirectory,
  SIGN_IN_PROOF_ROUTE,
  signInProofRoute,
  TEMPLATE_CASES,
} from './run.mjs';

const TEMPLATE = new URL(
  '../../packages/sdk/src/project/templates/app/.github/workflows/app-ci.yml.template.txt',
  import.meta.url,
);

describe('the app-kit E2E helpers (issue #1510)', () => {
  // The SDK's template test parses the same workflow with a YAML parser and holds every run step
  // to one line, which is what makes this line match exact.
  it('reads the generated CI run steps: install, imports, packages', async () => {
    const steps = ciRunSteps(await readFile(TEMPLATE, 'utf8'));

    expect(steps).toHaveLength(3);
    expect(steps.slice(0, 2)).toEqual([
      'npm ci',
      'npx --no-install depcruise --config dependency-cruiser.config.mjs .',
    ]);
    expect(steps[2]).toMatch(/^node --input-type=module -e "import .*"$/u);
  });

  // A run started through the app writes its skills 0o444 under 0o555 directories
  // (packages/engine/src/skills.ts); a plain rmSync of the work directory then fails EACCES.
  it('removes a work directory holding read-only skill directories, never through a symlink', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'app-kit-remove-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'app-kit-outside-'));
    const skill = path.join(work, 'sandbox', '.claude', 'skills', 'review');
    mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    writeFileSync(path.join(skill, 'SKILL.md'), '# review\n');
    writeFileSync(path.join(skill, 'scripts', 'plain.mjs'), '');
    chmodSync(path.join(skill, 'SKILL.md'), 0o444);
    chmodSync(path.join(skill, 'scripts', 'plain.mjs'), 0o444);
    chmodSync(outside, 0o555);
    symlinkSync(outside, path.join(work, 'link'));
    for (const directory of [path.join(skill, 'scripts'), skill, path.dirname(skill)]) {
      chmodSync(directory, 0o555);
    }

    try {
      removeWorkDirectory(work);

      expect(existsSync(work)).toBe(false);
      expect(existsSync(outside)).toBe(true);
    } finally {
      chmodSync(outside, 0o755);
      removeWorkDirectory(outside);
    }
  });

  it('runs every case, or the one --case names', () => {
    expect(casesOf([])).toEqual(['portal', 'team-chat', 'wiki', 'crm', 'service-desk', 'desk']);
    expect(casesOf(['--case', 'portal'])).toEqual(['portal']);
    expect(casesOf(['--case', 'service-desk'])).toEqual(['service-desk']);
    expect(() => casesOf(['--case', 'nope'])).toThrow(
      '--case takes one of portal, team-chat, wiki, crm, service-desk, desk',
    );
  });

  it('names each preset case after its directory, and reads the README commands (#1511)', () => {
    expect(TEMPLATE_CASES).toEqual({
      'team-chat': 'chat',
      wiki: 'wiki',
      crm: 'crm',
      'service-desk': 'desk',
    });
    expect(
      readmeCommands(
        "# crm\n\n```sh\nnpx aw generate resource company name:text\nnpm run dev\nnpx aw generate recipe r --on 'schedule:*/5 * * * *'\n```\n",
      ),
    ).toEqual([
      'npx aw generate resource company name:text',
      "npx aw generate recipe r --on 'schedule:*/5 * * * *'",
    ]);
  });

  it('plants a sign-in proof route on the five DI11 names, with a fresh S256 pair (#2075)', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(verifier);
    expect(SIGN_IN_PROOF_ROUTE).toBe('app/api/e2e-sign-in/route.ts');
    const route = signInProofRoute();
    for (const name of [
      'AW_OIDC_ISSUER_URL',
      'AW_OIDC_CLIENT_ID',
      'AW_OIDC_CLIENT_SECRET',
      'AW_APP_CLIENT_ID',
      'AW_APP_CLIENT_SECRET',
    ]) {
      expect(route).toContain(`env['${name}']`);
    }
    expect(route).toContain('aw.auth.exchange');
    expect(route).toContain('redirect_uri: redirectUri');
  });
});
