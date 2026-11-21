/** The real-model workflow spends, so the person starting it is the only trigger. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const text = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/store-live-verify.yml', import.meta.url)),
  'utf8',
);
const code = text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('store-live-verify.yml', () => {
  it('starts only on workflow_dispatch: never a pull request, a schedule or a push', () => {
    const on = /^on:\n((?: {2}.*\n|\n)+)/mu.exec(code)?.[1] ?? '';
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]);
    expect(triggers).toEqual(['workflow_dispatch']);
  });

  it('passes the secrets to the one step that runs the harness, and is no ci-success need', () => {
    const uses = [...code.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/gu)].map((match) => match[1]);
    expect(uses.sort()).toEqual(['STORE_STAGING_URL', 'STORE_VERIFY_API_KEY']);
    const step = code.split('      - name: ').find((part) => part.includes('secrets.')) ?? '';
    expect(step).toContain('node tests/store/live-verify/run.ts');
    const ci = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );
    expect(ci).not.toContain('store-live-verify');
  });

  it('keeps the typed spend gate, INDXDev only, and takes the entries as data, never as code', () => {
    expect(code).toContain(
      "if: github.repository_owner == 'INDXDev' && (inputs.approve_spend == 'spend-approved')",
    );
    expect(code).toMatch(/^ {6}entries:\n(?: {8}.*\n)*? {8}required: false\n/mu);
    // The slugs reach the harness through the environment, which validates them; no `run:` line
    // interpolates an input.
    expect(code).toContain('          STORE_LIVE_VERIFY_ENTRIES: ${{ inputs.entries }}\n');
    const runs = code.split('\n').filter((line) => /^\s*run:/u.test(line));
    expect(runs.filter((line) => line.includes('${{'))).toEqual([]);
  });

  it('hands the harness the commit the latest successful staging deploy seeded from', () => {
    expect(code).toContain(
      '--workflow store-deploy.yml --branch main --event push --status success',
    );
    expect(code).toContain(
      '          STORE_LIVE_VERIFY_DEPLOYED_COMMIT: ${{ steps.deployed.outputs.commit }}\n',
    );
    expect(code).toMatch(/^permissions:\n {2}contents: read\n {2}actions: read\n\n/mu);
    expect(code).toContain('          fetch-depth: 0\n');
  });
});
