import { describe, expect, it } from 'vitest';

import type { RuntimeProfile } from './types.js';

/**
 * `RuntimeProfile` (§15.1) is a type: TypeScript erases it, so there is nothing at run time for
 * this file to call. What these tests actually exercise is the *shape* — that a value with only
 * the required fields, and a value with every optional field present, both satisfy the type as
 * written in `types.ts` — which is a compile-time check `pnpm typecheck` enforces and `vitest` runs
 * as ordinary assertions so a regression shows up in `pnpm test` too, not only in a type-checker a
 * contributor might skip locally.
 *
 * The member-by-member correspondence with `docs/spec.md`'s §15.1 fenced block — every name,
 * every optionality flag, every type text — is `spec-transcription.test.ts`'s job, not this
 * file's; duplicating that check here would be the "hand-written list" ADR-0016's neighbouring
 * finding warns about, transcribed twice and going stale once.
 *
 * There is no Zod schema to test here. `types.ts`'s header records why: building one requires a
 * `zod` dependency this package's Accept criterion (and ADR-0041's concurrency precondition)
 * forbids adding, and the plan itself assigns "the §15.1 schema validated with Zod" to W3-CP-06 in
 * `apps/web`. That is a declared gap, not silently absent.
 */
describe('RuntimeProfile (§15.1)', () => {
  it('accepts a value with only the required fields', () => {
    const minimal: RuntimeProfile = {
      id: 'profile-minimal',
      name: 'Minimal',
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-only',
    };
    expect(minimal.id).toBe('profile-minimal');
    expect(minimal.runtimeConnectionId).toBeUndefined();
    expect(minimal.driverConfig).toBeUndefined();
  });

  it('accepts a value with every optional field present', () => {
    const full: RuntimeProfile = {
      id: 'profile-full',
      name: 'Heavy',
      driver: 'kubernetes',
      runtimeConnectionId: 'connection-1',
      cpu: 4,
      memoryMb: 8192,
      diskMb: 20480,
      networkPolicy: 'restricted',
      allowedDomains: ['api.anthropic.com'],
      filesystem: 'read-write',
      persistPaths: ['/workspace/output'],
      timeoutSeconds: 3600,
      idleTimeoutSeconds: 300,
      driverConfig: { runtimeClassName: 'gvisor' },
    };
    expect(full.allowedDomains).toEqual(['api.anthropic.com']);
    expect(full.driverConfig).toEqual({ runtimeClassName: 'gvisor' });
  });

  it('accepts every RuntimeDriverId as a driver value (the reference is by id, not a copy)', () => {
    const drivers: RuntimeProfile['driver'][] = [
      'local',
      'sandbox-runtime',
      'docker',
      'kubernetes',
      'gke-agent-sandbox',
      'aca-sessions',
      'aws-agentcore',
      'aws-ecs',
      'cloud-run-sandbox',
      'external',
      'vercel-sandbox',
      'cloudflare-sandbox',
    ];
    for (const driver of drivers) {
      const profile: RuntimeProfile = {
        id: `profile-${driver}`,
        name: driver,
        driver,
        networkPolicy: 'open',
        filesystem: 'read-write',
      };
      expect(profile.driver).toBe(driver);
    }
  });
});
