/**
 * `tests/conformance/fixtures/container-fixture.ts` — a fixture driver that actually enforces
 * everything {@link CONTAINER_FIXTURE_CAPABILITIES} claims: real isolation, real network
 * enforcement, a real per-session mounted workspace.
 *
 * This is not a driver this repository ships — `docker`, `kubernetes` and the rest are Wave 3's
 * later tasks (the Wave 3 plan's 3b-1/3b-2 rows) and out of `W3-QA-02`'s
 * `tests/conformance/**` glob. It exists to prove the *positive* half of the harness: that
 * `runA12ConformanceSuite` can report a full, honest `pass` on every scenario a real isolation
 * boundary makes possible, not only `unsupported-by-capability` (`local`, which has none) or
 * `fail` (the dishonest fixture in `tests/conformance/a12-honesty.test.ts`, which claims one it
 * does not have). ADR-0029 cuts both ways: a gate this task writes must be watched failing on a
 * tree it ought to reject *and* passing on one it ought to accept.
 *
 * `RuntimeHandle.driver` is typed `RuntimeDriverId` (spec §14.2), a closed union with no member
 * for a harness-only fixture. `'docker'` is borrowed here, once, labelled exactly as that: a
 * stand-in shaped like a container driver, not a claim about the real `docker` driver.
 */
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  createFixtureStarter,
  fixtureAgentProbe,
  ENFORCED_NETWORK,
  SANDBOXED_FILE_ACCESS,
  SANDBOXED_FILE_WRITE,
} from './common.js';
import type { FixtureEvent, FixtureRequest } from './common.js';
import type {
  A12Probe,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from '../types.js';

// Deliberately small, and shared between the capability claim below and the starter's real
// enforcement of it (`createFixtureStarter`'s `maxSessionSeconds` option) — a single constant, so
// the two cannot drift apart the way `container-fixture.ts` and `scenarios.ts` did in round 1.
// `tests/conformance/scenarios.ts`'s `enforce-resource-limits` scenario waits this many seconds
// (plus its own grace window, measured on one monotonic timer armed before the turn starts, never
// on `Date.now()` — issue #562) for the enforcement below to fire before failing, so a small number
// keeps that scenario's real cost small too.
const MAX_SESSION_SECONDS = 1;

export const CONTAINER_FIXTURE_CAPABILITIES: RuntimeCapabilities = {
  isolation: 'container',
  customImage: true,
  persistentFilesystem: true,
  sessionAffinity: true,
  maxSessionSeconds: MAX_SESSION_SECONDS,
  networkPolicies: ['none', 'allowlist', 'open'],
  execCommands: true,
  gpu: false,
  managedByProvider: false,
  typicalStartMs: 5,
};

export function createContainerFixtureDriver(): RuntimeDriver<FixtureRequest, FixtureEvent> {
  const live = new Map<string, RuntimeHandle>();
  const startAgent = createFixtureStarter({
    network: ENFORCED_NETWORK,
    fileAccess: SANDBOXED_FILE_ACCESS,
    fileWrite: SANDBOXED_FILE_WRITE,
    maxSessionSeconds: MAX_SESSION_SECONDS,
  });

  function assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const known = live.get(runtime.id);
    if (known === undefined) {
      throw new Error(
        `container-fixture: cannot ${operation} — handle ${JSON.stringify(runtime.id)} is not live.`,
      );
    }
    return known;
  }

  return {
    id: 'docker',
    capabilities: CONTAINER_FIXTURE_CAPABILITIES,

    async create(config: RuntimeConfig): Promise<RuntimeHandle> {
      await mkdir(config.workspacePath, { recursive: true });
      const handle: RuntimeHandle = {
        id: randomUUID(),
        driver: 'docker',
        externalId: `container-fixture:${randomUUID()}`,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
      };
      live.set(handle.id, handle);
      return handle;
    },

    async startAgent(runtime, request) {
      const known = assertLive(runtime, 'start an agent');
      return await startAgent(known, request);
    },

    async destroy(runtime) {
      assertLive(runtime, 'destroy');
      live.delete(runtime.id);
      return await Promise.resolve();
    },
  };
}

export const containerFixtureProbe: A12Probe<FixtureRequest, FixtureEvent> = {
  agent: fixtureAgentProbe,
};
