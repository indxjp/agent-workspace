import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntimeEnvironment, sessionWorkspacePaths } from './env.js';
import { createLocalDriver } from './local.js';
import type { RuntimeCapabilities } from './driver.js';
import { baseInput, CONFIG_DIRECTORY } from './env.test-support.js';

type ProbeResult = {
  cwd: string;
  sandboxHomedir: string;
  hostConfigMarker: string | null;
  envConfigDir: string | null;
  envConfigDirEntries: string[] | null;
};

function runProbe(cwd: string, env: Record<string, string>): ProbeResult {
  const script =
    "const fs=require('fs');const os=require('os');const path=require('path');" +
    'let hostConfigMarker;' +
    "try { hostConfigMarker = fs.readFileSync(path.join(os.homedir(), '.claude', 'HOST-MARKER'), 'utf8'); } " +
    'catch (err) { hostConfigMarker = null; }' +
    'let envConfigDirEntries;' +
    'try { envConfigDirEntries = fs.readdirSync(process.env.CLAUDE_CONFIG_DIR); } ' +
    'catch (err) { envConfigDirEntries = null; }' +
    'process.stdout.write(JSON.stringify({' +
    'cwd: process.cwd(), sandboxHomedir: os.homedir(), ' +
    'hostConfigMarker: hostConfigMarker, envConfigDir: process.env.CLAUDE_CONFIG_DIR || null, ' +
    'envConfigDirEntries: envConfigDirEntries' +
    '}));';
  const stdout = execFileSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' });
  return JSON.parse(stdout) as ProbeResult;
}

function scenario10Verdict(
  hostConfigReachable: boolean,
  isolation: RuntimeCapabilities['isolation'],
): 'pass' | 'fail' | 'unsupported-by-capability' {
  if (isolation === 'none') return 'unsupported-by-capability';
  return hostConfigReachable ? 'fail' : 'pass';
}

describe('A.12 scenario 10 against `local`: no host configuration is visible inside the sandbox', () => {
  it('local leaks a harness-seeded host-config marker (ADR-0047) and the injected env reaches the process (ADR-0046 rule 1), so `local` is unsupported-by-capability on every host, including one with no real ~/.claude', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'w3-cp-09-a12-10-'));
    // Seed a private stand-in for the host home; never read or write the operator's configuration.
    const hostConfigRoot = mkdtempSync(path.join(tmpdir(), 'w3-cp-09-a12-10-hostroot-'));
    const hostClaudeDir = path.join(hostConfigRoot, '.claude');
    mkdirSync(hostClaudeDir, { recursive: true });
    const hostMarkerToken = `host-marker-${randomUUID()}`;
    writeFileSync(path.join(hostClaudeDir, 'HOST-MARKER'), hostMarkerToken, 'utf8');
    try {
      const driver = createLocalDriver<{ cwd: string; env: Record<string, string> }, ProbeResult>(
        (_runtime, request) => {
          const result = runProbe(request.cwd, request.env);
          return {
            events: (async function* () {
              await Promise.resolve();
              yield result;
            })(),
            sessionId: Promise.resolve('probe-session'),
            interrupt: () => Promise.resolve(),
          };
        },
      );

      const sessionIds = ['session-one', 'session-two'] as const;
      const scopes = sessionIds.map((sessionId) =>
        sessionWorkspacePaths(workspaceRoot, sessionId, CONFIG_DIRECTORY),
      );

      const [scopeOne, scopeTwo] = scopes;
      if (scopeOne === undefined || scopeTwo === undefined) {
        throw new Error('test setup error: expected exactly two session scopes.');
      }
      for (const scope of [scopeOne, scopeTwo]) {
        mkdirSync(scope.cwd, { recursive: true });
        mkdirSync(scope.configDir, { recursive: true });
      }

      const results: ProbeResult[] = [];
      for (const [index, sessionId] of sessionIds.entries()) {
        const scope = index === 0 ? scopeOne : scopeTwo;
        const handle = await driver.create({
          engine: 'claude-agent-sdk',
          sessionId,
          workspacePath: scope.cwd,
        });
        const env: Record<string, string> = {
          ...buildRuntimeEnvironment({
            ...baseInput,
            runId: `run-${sessionId}`,
            sessionId,
            configDir: scope.configDir,
          }),
          HOME: hostConfigRoot,
          USERPROFILE: hostConfigRoot,
        };
        const connection = await driver.startAgent(handle, { cwd: scope.cwd, env });
        for await (const event of connection.events) {
          results.push(event);
        }
      }

      expect(results).toHaveLength(2);
      const [resultOne, resultTwo] = results;
      if (resultOne === undefined || resultTwo === undefined) {
        throw new Error('test setup error: expected exactly two probe results.');
      }
      expect(resultOne.cwd).not.toBe(resultTwo.cwd);
      assertProbeResult(resultOne, scopeOne, hostConfigRoot, hostMarkerToken);
      assertProbeResult(resultTwo, scopeTwo, hostConfigRoot, hostMarkerToken);

      const hostConfigReachable =
        resultOne.hostConfigMarker === hostMarkerToken &&
        resultTwo.hostConfigMarker === hostMarkerToken;
      const verdict = scenario10Verdict(hostConfigReachable, driver.capabilities.isolation);
      expect(driver.capabilities.isolation).toBe('none');
      expect(verdict).toBe('unsupported-by-capability');

      expect(scenario10Verdict(true, 'none')).toBe('unsupported-by-capability');
      expect(scenario10Verdict(false, 'none')).toBe('unsupported-by-capability');
      for (const realIsolation of ['os-sandbox', 'container', 'gvisor', 'microvm'] as const) {
        expect(scenario10Verdict(true, realIsolation)).toBe('fail');
        expect(scenario10Verdict(false, realIsolation)).toBe('pass');
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(hostConfigRoot, { recursive: true, force: true });
    }
  });
});

function assertProbeResult(
  result: ProbeResult,
  scope: ReturnType<typeof sessionWorkspacePaths>,
  hostConfigRoot: string,
  marker: string,
): void {
  expect(path.normalize(result.cwd)).toBe(path.normalize(scope.cwd));
  expect(path.normalize(result.sandboxHomedir)).toBe(path.normalize(hostConfigRoot));
  expect(result.envConfigDirEntries).not.toBeNull();
  expect(result.envConfigDir).not.toBeNull();
  expect(path.normalize(result.envConfigDir ?? '')).toBe(path.normalize(scope.configDir));
  expect(result.hostConfigMarker).toBe(marker);
}
