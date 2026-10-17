import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DRIVERS,
  RUNTIME_FILESYSTEM_MODES,
  RUNTIME_NETWORK_POLICIES,
  RUNTIME_PROFILE_BOUNDS,
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
} from './runtimes.js';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const profile = {
  id: '88888888-8888-4888-8888-888888888888',
  workspaceId: WORKSPACE,
  name: 'Standard',
  driver: 'docker',
  runtimeConnectionId: null,
  cpu: null,
  memoryMb: null,
  diskMb: null,
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-write',
  persistPaths: null,
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  driverConfig: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const connection = {
  id: CONNECTION,
  name: 'RUNTIME_CONNECTION__DOCKER__PRIMARY',
  driver: 'docker',
  createdAt: '2026-09-21T10:00:00.000Z',
};

function without(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

describe('RuntimeProfileResourceSchema', () => {
  it('accepts a profile that leaves sizing to the driver and one that pins everything', () => {
    expect(RuntimeProfileResourceSchema.safeParse(profile).success).toBe(true);
    expect(
      RuntimeProfileResourceSchema.safeParse({
        ...profile,
        driver: 'kubernetes',
        runtimeConnectionId: CONNECTION,
        cpu: 0.5,
        memoryMb: 2048,
        diskMb: 10_240,
        networkPolicy: 'none',
        allowedDomains: null,
        filesystem: 'read-only',
        persistPaths: ['/workspace/.cache'],
        timeoutSeconds: 3600,
        idleTimeoutSeconds: 600,
        driverConfig: { image: 'ghcr.io/x/runner@sha256:' + 'a'.repeat(64), namespace: 'agents' },
      }).success,
    ).toBe(true);
  });

  it('rejects a driver, policy or filesystem outside the published vocabularies', () => {
    expect(RuntimeProfileResourceSchema.safeParse({ ...profile, driver: 'podman' }).success).toBe(
      false,
    );
    expect(
      RuntimeProfileResourceSchema.safeParse({ ...profile, networkPolicy: 'gateway' }).success,
    ).toBe(false);
    expect(
      RuntimeProfileResourceSchema.safeParse({ ...profile, filesystem: 'ephemeral' }).success,
    ).toBe(false);
  });

  it('rejects an unknown key, a missing field, and a wrongly typed field', () => {
    expect(RuntimeProfileResourceSchema.safeParse({ ...profile, image: 'x' }).success).toBe(false);
    expect(RuntimeProfileResourceSchema.safeParse(without(profile, 'filesystem')).success).toBe(
      false,
    );
    expect(RuntimeProfileResourceSchema.safeParse({ ...profile, memoryMb: '1024' }).success).toBe(
      false,
    );
    expect(
      RuntimeProfileResourceSchema.safeParse({ ...profile, createdAt: 1_700_000_000 }).success,
    ).toBe(false);
  });

  it('holds the sizing bounds the server enforces', () => {
    expect(RuntimeProfileResourceSchema.safeParse({ ...profile, cpu: 0 }).success).toBe(false);
    expect(RuntimeProfileResourceSchema.safeParse({ ...profile, cpu: 0.25 }).success).toBe(true);
    expect(
      RuntimeProfileResourceSchema.safeParse({
        ...profile,
        memoryMb: RUNTIME_PROFILE_BOUNDS.memoryMb.min - 1,
      }).success,
    ).toBe(false);
    expect(RuntimeProfileResourceSchema.safeParse({ ...profile, diskMb: 1.5 }).success).toBe(false);
    expect(
      RuntimeProfileResourceSchema.safeParse({
        ...profile,
        timeoutSeconds: RUNTIME_PROFILE_BOUNDS.timeoutSeconds.max + 2,
      }).success,
    ).toBe(false);
    expect(
      RuntimeProfileResourceSchema.safeParse({ ...profile, idleTimeoutSeconds: -1 }).success,
    ).toBe(false);
  });

  it('reads the list envelope and refuses a wrapped item', () => {
    expect(RuntimeProfileListResponseSchema.safeParse({ runtimeProfiles: [profile] }).success).toBe(
      true,
    );
    expect(RuntimeProfileListResponseSchema.safeParse({ profiles: [profile] }).success).toBe(false);
    expect(RuntimeProfileResourceSchema.safeParse({ runtimeProfile: profile }).success).toBe(false);
  });
});

describe('RuntimeConnectionResourceSchema', () => {
  it('accepts a connection and refuses one that carries its endpoint or credential', () => {
    expect(RuntimeConnectionResourceSchema.safeParse(connection).success).toBe(true);
    expect(
      RuntimeConnectionResourceSchema.safeParse({ ...connection, endpoint: 'https://x' }).success,
    ).toBe(false);
    expect(
      RuntimeConnectionResourceSchema.safeParse({ ...connection, credential: 'secret' }).success,
    ).toBe(false);
  });

  it('rejects an unknown driver, a missing name, and a non-string id', () => {
    expect(RuntimeConnectionResourceSchema.safeParse({ ...connection, driver: 'x' }).success).toBe(
      false,
    );
    expect(RuntimeConnectionResourceSchema.safeParse(without(connection, 'name')).success).toBe(
      false,
    );
    expect(RuntimeConnectionResourceSchema.safeParse({ ...connection, id: 7 }).success).toBe(false);
  });

  it('reads the list envelope', () => {
    expect(
      RuntimeConnectionListResponseSchema.safeParse({ runtimeConnections: [connection] }).success,
    ).toBe(true);
    expect(RuntimeConnectionListResponseSchema.safeParse({ runtimeConnections: [] }).success).toBe(
      true,
    );
    expect(RuntimeConnectionListResponseSchema.safeParse({ connections: [] }).success).toBe(false);
  });
});

describe('vocabularies', () => {
  it('publishes the driver catalogue, the network policies and the filesystem modes', () => {
    expect(RUNTIME_DRIVERS).toEqual([
      'local',
      'sandbox-runtime',
      'docker',
      'kubernetes',
      'gke-agent-sandbox',
      'aca-sessions',
      'aws-agentcore',
      'aws-ecs',
      'cloud-run-sandbox',
      'cloud-run-service',
      'external',
      'vercel-sandbox',
      'cloudflare-sandbox',
    ]);
    expect(RUNTIME_NETWORK_POLICIES).toEqual(['none', 'restricted', 'open']);
    expect(RUNTIME_FILESYSTEM_MODES).toEqual(['read-only', 'read-write']);
    expect(RUNTIME_PROFILE_BOUNDS.cpu.exclusiveMin).toBe(0);
    expect(RUNTIME_PROFILE_BOUNDS.memoryMb.max).toBe(Number.MAX_SAFE_INTEGER);
  });
});
