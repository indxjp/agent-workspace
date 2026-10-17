import { readFileSync } from 'node:fs';

import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from './output.js';
import { runCli } from './testing.js';
import { AW_PUBLISHED_PACKAGE, AW_VERSION, nodeVersionWarning } from './version.js';

function manifestField(relative: string, field: string): unknown {
  const manifest: unknown = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
  return typeof manifest === 'object' && manifest !== null
    ? (manifest as Record<string, unknown>)[field]
    : undefined;
}

function manifestVersion(relative: string): unknown {
  return manifestField(relative, 'version');
}

function refusal(current: string, minimum: string): Response {
  const message = `This client was built against contracts ${CONTRACTS_VERSION}; this server serves contracts ${minimum} to ${current}.`;
  return new Response(
    JSON.stringify({ error: { code: 'contracts_version_unsupported', message, detail: message } }),
    {
      status: 426,
      headers: {
        'content-type': 'application/json',
        [CONTRACTS_VERSION_HEADER]: current,
        [CONTRACTS_MINIMUM_VERSION_HEADER]: minimum,
      },
    },
  );
}

describe('aw and the contracts version (issue #244, S-7)', () => {
  it('pins the version constants to their package manifests', () => {
    expect(manifestVersion('../package.json')).toBe(AW_VERSION);
    expect(manifestVersion('../../contracts/package.json')).toBe(CONTRACTS_VERSION);
  });

  it('is published under the name its install fix names (issue #246, ADR-0082)', () => {
    expect(manifestField('../package.json', 'name')).toBe(AW_PUBLISHED_PACKAGE);
    expect(AW_PUBLISHED_PACKAGE.startsWith('@indx-workspace/')).toBe(true);
  });

  it('releases aw, the SDK and the contracts in lock-step at the contracts version (P-3)', () => {
    expect(AW_VERSION).toBe(CONTRACTS_VERSION);
    expect(manifestVersion('../../sdk/package.json')).toBe(CONTRACTS_VERSION);
  });

  it('prints both versions for --version, without configuration or network', async () => {
    const run = await runCli(['--version'], { env: {} });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(`aw ${AW_VERSION} (contracts ${CONTRACTS_VERSION})\n`);
    expect(run.calls).toHaveLength(0);
  });

  it('prints both versions as JSON with --json or --jsonl (BH061-042)', async () => {
    const json = await runCli(['--version', '--json'], { env: {} });
    expect(JSON.parse(json.stdout)).toEqual({ aw: AW_VERSION, contracts: CONTRACTS_VERSION });
    const jsonl = await runCli(['--version', '--jsonl'], { env: {} });
    expect(jsonl.stdout).toBe(`${JSON.stringify({ aw: AW_VERSION, contracts: CONTRACTS_VERSION })}
`);
  });

  it('takes --version after a command, as a global flag, without a request', async () => {
    const run = await runCli(['runs', 'list', '--version'], { env: {} });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(`aw ${AW_VERSION} (contracts ${CONTRACTS_VERSION})
`);
    expect(run.calls).toHaveLength(0);
  });

  it('sends the contracts version on the request it makes', async () => {
    const run = await runCli(['me'], { route: () => refusal('9.1.0', '9.0.0') });
    expect(run.calls[0]?.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
  });

  it('exits non-zero naming both versions and the install that fixes an old client', async () => {
    const run = await runCli(['me'], { route: () => refusal('9.1.0', '9.0.0') });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('error: contracts_version_unsupported');
    expect(run.stderr).toContain(`built against contracts ${CONTRACTS_VERSION}`);
    expect(run.stderr).toContain('serves contracts 9.0.0 to 9.1.0');
    expect(run.stderr).toContain(`fix: npm install --global ${AW_PUBLISHED_PACKAGE}@9.1`);
    expect(run.stderr).not.toContain('@agent-workspace/');
  });

  it('names the server upgrade first when the client is the newer side', async () => {
    const run = await runCli(['me'], { route: () => refusal('0.0.3', '0.0.0') });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('serves contracts 0.0.0 to 0.0.3');
    expect(run.stderr).toContain(
      `fix: upgrade the control plane to a release that serves contracts ${CONTRACTS_VERSION}, or run: npm install --global ${AW_PUBLISHED_PACKAGE}@0.0`,
    );
  });
});

describe('nodeVersionWarning (BH061-068)', () => {
  it('says nothing on Node 24 or newer', () => {
    expect(nodeVersionWarning('24.0.0')).toBeNull();
    expect(nodeVersionWarning('26.1.0')).toBeNull();
  });

  it('warns on an older Node and names nvm use', () => {
    expect(nodeVersionWarning('22.12.0')).toBe(
      'warning: Agent Workspace needs Node 24 or newer; you have v22.12.0\n' +
        'fix: nvm install 24 && nvm use 24 (or install it from https://nodejs.org)\n',
    );
  });
});
