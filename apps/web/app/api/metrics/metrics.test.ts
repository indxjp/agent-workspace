/**
 * `GET /api/metrics` — workspace isolation.
 *
 * Named `metrics.test.ts`, not `route.test.ts`: `tests/route-inventory.test.ts`'s
 * `classifyAppFile` treats any `apps/web/app/**` file named `route.<anything>` as a claim that
 * Next.js serves it, and throws when the suffix is not one of `next.config.ts`'s
 * `pageExtensions` — exactly what a colocated `route.test.ts` would trigger.
 *
 * Issue #116: a member of workspace A received telemetry for every workspace a web process had
 * observed, because the route checked only `getSession() !== null` and never scoped the
 * projection. This file drives the real route module — the one Next.js calls — with a real
 * `authorise`/`decide` gate installed, the same way `apps/web/server/rbac/routes.test.ts` drives
 * its routes, so what is proved is the wiring and not just the projection filter in isolation
 * (that filter has its own tests in `../../../server/telemetry/runtime.test.ts`).
 *
 * A minimal `RbacRuntime` is installed here rather than reusing
 * `apps/web/server/rbac/testing.ts`'s `installRbacHarness`: that harness resolves every caller
 * into one fixed workspace, and the attack this route was found vulnerable to is specifically
 * about *two* workspaces sharing one process. `identify` below reads a header this test alone
 * writes and builds a real `Principal` with `Principal.fromApiKey`, so everything from there on
 * — `authorise`, `decide`, the handler, the projection filter — is the code that ships.
 */
import { describe, expect, it, afterEach } from 'vitest';

import { createMemoryDirectory } from '../../../server/rbac/memory-directory';
import { Principal } from '../../../server/rbac/principal';
import { ROLES, type Role } from '../../../server/rbac/roles';
import {
  clearRbacRuntime,
  configureRbacRuntime,
  type RbacRuntime,
} from '../../../server/rbac/runtime';
import { recordRunTelemetry } from '../../../server/telemetry/runtime';

import { GET } from './route';

const TEST_PRINCIPAL_HEADER = 'x-w9-sec-116-test-principal';

interface TestCaller {
  readonly workspaceId: string;
  readonly role: Role;
}

/** Install a runtime whose `identify` reads `TEST_PRINCIPAL_HEADER` and nothing else. */
function installTestRuntime(): void {
  const directory = createMemoryDirectory();
  const runtime: RbacRuntime = {
    directory,
    identify: (request: Request): Promise<Principal | null> => {
      const raw = request.headers.get(TEST_PRINCIPAL_HEADER);
      if (raw === null) return Promise.resolve(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return Promise.resolve(null);
      }
      if (typeof parsed !== 'object' || parsed === null) return Promise.resolve(null);
      const { workspaceId, role } = parsed as { workspaceId?: unknown; role?: unknown };
      if (typeof workspaceId !== 'string' || typeof role !== 'string') {
        return Promise.resolve(null);
      }
      const found = ROLES.find((candidate) => candidate === role);
      if (found === undefined) return Promise.resolve(null);
      return Promise.resolve(
        Principal.fromApiKey({
          principalId: '33f2b832-a1de-469f-8874-ddcab825aa02',
          apiKeyId: '3cff4ce7-8cf3-4ded-be3d-ab1dc3c1404f',
          workspaceId,
          role: found,
          label: 'Metrics test key',
        }),
      );
    },
  };
  configureRbacRuntime(runtime);
}

function requestFor(
  caller: TestCaller | null,
  init?: { readonly extraHeaders?: Record<string, string>; readonly url?: string },
): Request {
  const headers: Record<string, string> = { ...(init?.extraHeaders ?? {}) };
  if (caller !== null) headers[TEST_PRINCIPAL_HEADER] = JSON.stringify(caller);
  return new Request(init?.url ?? 'https://control-plane.test/api/metrics', {
    method: 'GET',
    headers,
  });
}

afterEach(() => {
  clearRbacRuntime();
});

describe('GET /api/metrics scopes the projection to the caller’s own workspace', () => {
  it(
    'returns only the caller’s workspace’s runs, and the other workspace’s run id occurs ' +
      'nowhere in the raw response text',
    async () => {
      installTestRuntime();
      const runInA = `metrics-a-${crypto.randomUUID()}`;
      const runInB = `metrics-b-${crypto.randomUUID()}`;
      const workspaceA = `ws-a-${crypto.randomUUID()}`;
      const workspaceB = `ws-b-${crypto.randomUUID()}`;
      recordRunTelemetry({
        runId: runInA,
        workspaceId: workspaceA,
        agentId: 'agent-a',
        status: 'completed',
        durationMs: 10,
        costUsd: 0.1,
      });
      recordRunTelemetry({
        runId: runInB,
        workspaceId: workspaceB,
        agentId: 'agent-b',
        status: 'completed',
        durationMs: 20,
        costUsd: 0.2,
      });

      const response = await GET(requestFor({ workspaceId: workspaceA, role: 'admin' }));
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const body = JSON.parse(text) as { runs: readonly { runId: string; workspaceId: string }[] };

      expect(body.runs.some((run) => run.runId === runInA)).toBe(true);
      expect(body.runs.every((run) => run.workspaceId === workspaceA)).toBe(true);
      // Not just "absent from the parsed array" — absent from the raw text, so a field this test
      // does not think to parse could not carry it either.
      expect(text).not.toContain(runInB);
      expect(text).not.toContain(workspaceB);
    },
  );

  it('ignores a forged workspace slug/header/query naming another workspace: byte-identical response', async () => {
    installTestRuntime();
    const workspaceA = `ws-a-${crypto.randomUUID()}`;
    const workspaceB = `ws-b-${crypto.randomUUID()}`;
    recordRunTelemetry({
      runId: `metrics-plain-${crypto.randomUUID()}`,
      workspaceId: workspaceA,
      agentId: 'agent-a',
      status: 'completed',
      durationMs: 5,
      costUsd: null,
    });

    const plain = await GET(requestFor({ workspaceId: workspaceA, role: 'admin' }));
    const plainText = await plain.text();

    const forged = await GET(
      requestFor(
        { workspaceId: workspaceA, role: 'admin' },
        {
          url: `https://control-plane.test/api/metrics?workspace=${workspaceB}&workspaceSlug=${workspaceB}`,
          extraHeaders: { 'x-workspace-slug': workspaceB },
        },
      ),
    );
    const forgedText = await forged.text();

    expect(forged.status).toBe(plain.status);
    expect(forgedText).toBe(plainText);
  });

  it('answers 401, with an identical body, to no credential and to a credential identify cannot verify', async () => {
    installTestRuntime();

    const noCookie = await GET(requestFor(null));
    const noCookieText = await noCookie.text();
    expect(noCookie.status).toBe(401);

    // A header present but not a shape `identify` can turn into a principal — the "wrong key"
    // case, generalised: something was presented and it did not verify.
    const wrongKey = await GET(
      requestFor(null, { extraHeaders: { [TEST_PRINCIPAL_HEADER]: 'not-json-at-all' } }),
    );
    const wrongKeyText = await wrongKey.text();
    expect(wrongKey.status).toBe(401);

    expect(wrongKeyText).toBe(noCookieText);
  });

  it('answers 503 when the rbac runtime is not configured, not a silent empty 200', async () => {
    clearRbacRuntime();
    const response = await GET(requestFor(null));
    const text = await response.text();
    expect(response.status, text).toBe(503);
    expect(text).toContain('rbac_runtime_not_configured');
  });

  for (const role of ROLES) {
    it(`allows role "${role}" to read its own workspace’s metrics (§21 grants metrics read to every role)`, async () => {
      installTestRuntime();
      const workspaceId = `ws-role-${role}-${crypto.randomUUID()}`;
      const runId = `metrics-role-${role}-${crypto.randomUUID()}`;
      recordRunTelemetry({
        runId,
        workspaceId,
        agentId: 'agent-x',
        status: 'completed',
        durationMs: 1,
        costUsd: null,
      });

      const response = await GET(requestFor({ workspaceId, role }));
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const body = JSON.parse(text) as { runs: readonly { runId: string }[] };
      expect(body.runs.some((run) => run.runId === runId)).toBe(true);
    });
  }

  it('never returns provider credentials, prompts or raw event payloads', async () => {
    installTestRuntime();
    const workspaceId = `ws-shape-${crypto.randomUUID()}`;
    recordRunTelemetry({
      runId: `metrics-shape-${crypto.randomUUID()}`,
      workspaceId,
      agentId: 'agent-x',
      status: 'completed',
      durationMs: 1,
      costUsd: 0.5,
    });

    const response = await GET(requestFor({ workspaceId, role: 'owner' }));
    const text = await response.text();
    const body = JSON.parse(text) as { runs: readonly Record<string, unknown>[] };
    for (const run of body.runs) {
      expect(Object.keys(run).sort()).toEqual(
        ['agentId', 'costUsd', 'durationMs', 'runId', 'status', 'workspaceId'].sort(),
      );
    }
  });
});
