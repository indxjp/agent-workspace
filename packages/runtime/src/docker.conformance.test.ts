import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertHonestReport, runA12ConformanceSuite } from '../../../tests/conformance/harness.js';
import type { A12AgentAction } from '../../../tests/conformance/types.js';
import { createDockerDriver, runDockerCommand } from './docker.js';
import {
  GATEWAY_ALIAS,
  a12Probe,
  createAgentStarter,
  createDockerTracker,
  startGatewayFixture,
  wgetArgs,
} from './docker.conformance.test-support.js';
import type { ProbeEvent } from './docker.conformance.test-support.js';
import { runSpec } from './docker.test-support.js';

const dockerDaemonAvailable = await runDockerCommand(['info']).then(
  (result) => result.exitCode === 0,
  () => false,
);

describe.skipIf(!dockerDaemonAvailable)('real Docker isolation and A.12 conformance', () => {
  const suffix = randomUUID().slice(0, 8);
  const networkName = `w3-agent-egress-${suffix}`;
  const gatewayName = `w3-gateway-${suffix}`;
  const tracker = createDockerTracker();
  const { docker } = tracker;

  beforeAll(() => startGatewayFixture(tracker, networkName, gatewayName), 120_000);

  afterAll(() => tracker.removeAll(networkName), 120_000);

  const driver = createDockerDriver<A12AgentAction, ProbeEvent>({
    images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
    networkName,
    networkPolicy: 'none',
    command: ['sleep', '600'],
    docker,
    startAgent: createAgentStarter(tracker),
  });
  const probe = a12Probe;

  it('proves the gateway is reachable while a non-gateway host is blocked', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-network-'));
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'network-proof',
      workspacePath: root,
    });
    try {
      const gateway = await docker(wgetArgs(handle.externalId, `http://${GATEWAY_ALIAS}/`, 3));
      const outside = await docker(wgetArgs(handle.externalId, 'http://example.com/', 3));
      expect(gateway.exitCode).toBe(0);
      expect(outside.exitCode).not.toBe(0);
    } finally {
      await driver.destroy(handle);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('A2 docker lane: a session past its deadline is reaped by the live daemon', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-reap-'));
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'deadline-reap',
      workspacePath: root,
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });
    try {
      expect((await docker(['inspect', handle.externalId])).exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await driver.reapExpired();
      expect((await docker(['inspect', handle.externalId])).exitCode).not.toBe(0);
      expect(await driver.isLive(handle)).toBe(false);
    } finally {
      await driver.destroy(handle).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('returns only pass or capability-backed unsupported verdicts from the A.12 harness', async () => {
    const report = await runA12ConformanceSuite(driver, driver.capabilities, probe);
    console.log(
      `A.12 vs docker:\n${report.results
        .map((result) => `  ${result.verdict.padEnd(24)} ${result.id} — ${result.detail}`)
        .join('\n')}`,
    );
    expect(() => assertHonestReport(report)).not.toThrow();
    expect(report.results).toHaveLength(10);
    expect(report.results.every((result) => result.verdict !== 'fail')).toBe(true);
    expect(
      report.results.filter((result) => result.verdict === 'unsupported-by-capability'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'enforce-network-restricted' }),
        expect.objectContaining({ id: 'enforce-resource-limits' }),
      ]),
    );
  }, 180_000);
});
