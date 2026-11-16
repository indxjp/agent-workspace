/**
 * SDK conformance, observability: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import { negotiateContractsVersion, servedContractsHeaders } from './versioning/contracts-version';
import { ApiProblemSchema, CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { ContractsVersionUnsupportedError, createClient } from '@indx-workspace/sdk';
import {
  AUDIT_ACTIONS,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AuditEventListResponseSchema,
  RunTelemetryListResponseSchema,
} from '@indx-workspace/contracts/observability';
import { FEATURE_IDS, WorkspaceFeaturesSchema } from '@indx-workspace/contracts/features';
import {
  type AuditEventRepository,
  type AuditEventRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { auditActions as serverAuditActions } from '@agent-workspace/core/db/unscoped';
import { GET as getAuditEvents } from '../app/api/audit-events/route';
import { GET as getMetrics } from '../app/api/metrics/route';
import { keysetPageOf } from './pagination/testing';
import { installRbacHarness, TEST_WORKSPACE_ID } from './rbac/testing';
import { recentRunTelemetry, recordRunTelemetry } from './telemetry/runtime';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';
import { listWorkspaceFeatures } from './workspaces/features';

const OBSERVABILITY_WORKSPACE = 'aaaaaaaa-0b5e-4aaa-8aaa-aaaaaaaaaaaa';

const OBSERVABILITY_AGENT = '11111111-0b5e-4111-8111-111111111111';

const OBSERVABILITY_PRINCIPAL = '99999999-0b5e-4999-8999-999999999999';

const OBSERVABILITY_VIEWER = 'viewer@observability.example.test';

/** One row as the PostgreSQL repository's `list` returns it: a `Date`, not a string, for `createdAt`. */
type ServerAuditRow = Awaited<ReturnType<AuditEventRepository['list']>>['items'][number];

const auditRows: readonly ServerAuditRow[] = [
  {
    id: '77777777-0b5e-4777-8777-777777777777',
    workspaceId: OBSERVABILITY_WORKSPACE,
    actorUserId: '88888888-0b5e-4888-8888-888888888888',
    actorPrincipalId: OBSERVABILITY_PRINCIPAL,
    actorLabel: 'Ito',
    action: 'agent-changed',
    subjectId: OBSERVABILITY_AGENT,
    subjectLabel: 'Customer Support Agent',
    details: null,
    createdAt: new Date('2026-09-21T10:00:01.000Z'),
  },
  {
    id: '77777777-0b5e-4777-8777-777777777778',
    workspaceId: OBSERVABILITY_WORKSPACE,
    actorUserId: null,
    actorPrincipalId: null,
    actorLabel: 'system',
    action: 'public-sharing-policy-changed',
    subjectId: null,
    subjectLabel: 'Public sharing',
    details: null,
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
  },
];

/**
 * Drive the real route with an in-memory repository that records the limit it was asked for,
 * so what is proved is the handler's own body and its query parsing, not a re-statement of them.
 */
async function callAuditRoute(
  search: string,
  options: {
    readonly role?: 'owner' | 'admin' | 'builder' | 'viewer' | null;
    readonly configured?: boolean;
  } = {},
): Promise<{ readonly status: number; readonly body: unknown; readonly limits: number[] }> {
  const limits: number[] = [];
  const repository: AuditEventRepository = {
    write: () => Promise.resolve(),
    count: () => Promise.resolve(auditRows.length),
    list: (input = {}) => {
      const limit = input.limit ?? AUDIT_LIST_DEFAULT_LIMIT;
      limits.push(limit);
      return Promise.resolve(keysetPageOf(auditRows, { limit, cursor: input.cursor ?? null }));
    },
  };
  const repositories: AuditEventRepositoryProvider = { forScope: () => repository };
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: TEST_WORKSPACE_ID, slug: 'observability' },
  ]);
  const role = options.role === undefined ? 'owner' : options.role;
  const harness = installRbacHarness(
    role === null
      ? []
      : [{ email: OBSERVABILITY_VIEWER, name: 'Caller', workspaceId: TEST_WORKSPACE_ID, role }],
  );
  try {
    if (options.configured === false) {
      clearApplicationContext();
    } else {
      installTestDomains({ audit: { scopes, repositories } });
    }
    const response = await harness.call(getAuditEvents, {
      method: 'GET',
      path: `/api/audit-events${search}`,
      as: role === null ? null : { email: OBSERVABILITY_VIEWER },
    });
    return { status: response.status, body: response.body, limits };
  } finally {
    harness.teardown();
  }
}

describe('observability', () => {
  it('renders the metrics projection into the published shape through the real route', async () => {
    const harness = installRbacHarness([
      {
        email: OBSERVABILITY_VIEWER,
        name: 'Viewer',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'viewer',
      },
    ]);
    try {
      recordRunTelemetry({
        runId: '33333333-0b5e-4333-8333-333333333333',
        workspaceId: TEST_WORKSPACE_ID,
        agentId: OBSERVABILITY_AGENT,
        status: 'completed',
        durationMs: 4000,
        costUsd: 0.001234,
      });
      recordRunTelemetry({
        runId: '33333333-0b5e-4333-8333-333333333334',
        workspaceId: TEST_WORKSPACE_ID,
        agentId: OBSERVABILITY_AGENT,
        status: 'failed',
        durationMs: 12,
        costUsd: null,
      });
      const response = await harness.call(getMetrics, {
        method: 'GET',
        path: '/api/metrics',
        as: { email: OBSERVABILITY_VIEWER },
      });
      expect(response.status, response.text).toBe(200);
      const parsed = RunTelemetryListResponseSchema.safeParse(response.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(parsed.data?.runs).toEqual(recentRunTelemetry(TEST_WORKSPACE_ID));
      expect(parsed.data?.runs.length).toBeGreaterThanOrEqual(2);
    } finally {
      harness.teardown();
    }
  });

  it('renders the audit rows into the published shape through the real route', async () => {
    const { status, body, limits } = await callAuditRoute('?limit=2');
    expect(status).toBe(200);
    const parsed = AuditEventListResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.events.map((event) => event.id)).toEqual(auditRows.map((row) => row.id));
    expect(parsed.data?.events[0]?.createdAt).toBe('2026-09-21T10:00:01.000Z');
    expect(parsed.data?.nextCursor).toBeNull();
    expect(limits).toEqual([2]);
  });
});

describe('observability', () => {
  it('pins the paged shape: a limit=1 walk parses page by page and ends on nextCursor null', async () => {
    const first = AuditEventListResponseSchema.parse((await callAuditRoute('?limit=1')).body);
    expect(first.events.map((event) => event.id)).toEqual([auditRows[0]?.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = AuditEventListResponseSchema.parse(
      (await callAuditRoute(`?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).body,
    );
    expect(second.events.map((event) => event.id)).toEqual([auditRows[1]?.id]);
    expect(second.nextCursor).toBeNull();
    const refused = await callAuditRoute('?cursor=not-a-cursor');
    expect(refused.status).toBe(400);
    expect(ApiProblemSchema.parse(refused.body).error.code).toBe('invalid_cursor');
  });

  it('applies the default limit the contract publishes and refuses the bounds it states', async () => {
    const defaulted = await callAuditRoute('');
    expect(defaulted.status).toBe(200);
    expect(defaulted.limits).toEqual([AUDIT_LIST_DEFAULT_LIMIT]);

    const ceiling = await callAuditRoute(`?limit=${String(AUDIT_LIST_MAX_LIMIT)}`);
    expect(ceiling.status).toBe(200);
    expect(ceiling.limits).toEqual([AUDIT_LIST_MAX_LIMIT]);

    for (const outOfRange of ['0', String(AUDIT_LIST_MAX_LIMIT + 1), '1.5', 'ten']) {
      const refused = await callAuditRoute(`?limit=${outOfRange}`);
      expect(refused.status, outOfRange).toBe(400);
      expect(ApiProblemSchema.parse(refused.body).error.code).toBe('invalid_limit');
      expect(refused.limits).toEqual([]);
    }
  });

  it('refuses every role but Owner in the standard envelope, and a missing session and runtime too', async () => {
    for (const role of ['admin', 'builder', 'viewer'] as const) {
      const refused = await callAuditRoute('', { role });
      expect(refused.status, role).toBe(403);
      expect(ApiProblemSchema.parse(refused.body).error.code, role).toBe('forbidden');
      expect(refused.limits, role).toEqual([]);
    }

    const anonymous = await callAuditRoute('', { role: null });
    expect(anonymous.status).toBe(401);
    expect(ApiProblemSchema.parse(anonymous.body).error.code).toBe('unauthenticated');

    // The audit domain and the RBAC gate live in one application context, so with none installed
    // the gate answers first.
    const unconfigured = await callAuditRoute('', { configured: false });
    expect(unconfigured.status).toBe(503);
    expect(ApiProblemSchema.parse(unconfigured.body).error.code).toBe(
      'rbac_runtime_not_configured',
    );
  });
});

describe('observability', () => {
  it('restates the same audit actions as the contract', () => {
    expect([...serverAuditActions]).toEqual([...AUDIT_ACTIONS]);
  });

  it('records the workspace feature switches under an action the contract lists', () => {
    expect(serverAuditActions).toContain('workspace-features-changed');
    expect(AUDIT_ACTIONS).toContain('workspace-features-changed');
  });

  it('renders the workspace features into a body the contract accepts', () => {
    const parsed = WorkspaceFeaturesSchema.safeParse(listWorkspaceFeatures(FEATURE_IDS, ['files']));
    expect(parsed.success).toBe(true);
  });
});

/**
 * Issue #244 (SDK-12, S-7): the `426` the edge renders is the one the SDK reads. The body goes
 * through `ApiProblemSchema`, and the whole answer — body and served-range headers — through a real
 * client, which must raise the typed refusal with both versions.
 */
describe('contracts version negotiation (issue #244, SDK-12, S-7)', () => {
  it('pins the 426 body to the envelope and the SDK reads it as ContractsVersionUnsupportedError', async () => {
    const negotiation = negotiateContractsVersion('0.0.1');
    if (negotiation.kind !== 'refused') throw new Error('expected a refusal');
    expect(negotiation.status).toBe(426);
    expect(ApiProblemSchema.parse(negotiation.body).error.code).toBe(
      'contracts_version_unsupported',
    );

    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(negotiation.body), {
            status: negotiation.status,
            headers: { 'content-type': 'application/json', ...servedContractsHeaders() },
          }),
        ),
    });
    const failure: unknown = await client.me().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractsVersionUnsupportedError);
    // The client here is on the served version, so the headers alone judge it served; the typed
    // error still carries the server's message, which names the refused version and the range.
    const refusal = failure as ContractsVersionUnsupportedError;
    expect(refusal.message).toContain('0.0.1');
    expect(refusal.message).toContain(CONTRACTS_VERSION);
  });
});
