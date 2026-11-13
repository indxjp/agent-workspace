import { expect } from 'vitest';
import { asRecord, asString } from '../../../tests/formal/vectors';
import { SSE_HEADERS } from '../server/runs/sse';
import {
  OTHER_RUN,
  OTHER_WORKSPACE,
  OWNER,
  prepareScenario,
  RUN,
  SESSION,
  WORKSPACE,
} from './behaviour-runs.test-support';

type ScenarioFixture = Awaited<ReturnType<typeof prepareScenario>>;
interface ScenarioAssertion {
  readonly fixture: ScenarioFixture;
  readonly response: Response;
  readonly result: Record<string, unknown>;
  readonly id: string;
}

export async function assertScenarioResponse(context: ScenarioAssertion) {
  const { fixture, response, result, id } = context;
  expect(response.status, id).toBe(result['status']);
  await assertStoredRuns(fixture, result, id);
  if (result['code'] !== null) {
    const body = asRecord(await response.json(), id);
    expect(asRecord(body['error'], 'error')['code'], id).toBe(result['code']);
    return;
  }
  const kind = asString(result['bodyKind'], 'bodyKind');
  if (kind === 'stream') {
    await assertStream(response);
    return;
  }
  const body = asRecord(await response.json(), id);
  expect(JSON.stringify(body)).not.toMatch(/"(?:tokenSecret|tokenHash|secret)"/u);
  if (kind === 'start') await assertStartedRun(context, body);
  else if (kind === 'list') assertListedRuns(context, body);
  else if (kind === 'revoke') {
    expect(body['revoked']).toBe(result['revoked']);
    expect(body['outcome']).toBe(result['revokeOutcome']);
  } else await assertReadRun(fixture, body);
}

async function assertStoredRuns(
  { route, role, store, foreignBefore }: ScenarioFixture,
  result: Record<string, unknown>,
  id: string,
) {
  const workspaceRuns = await store.listRuns(WORKSPACE, { limit: 200 });
  const foreignRuns = await store.listRuns(OTHER_WORKSPACE, { limit: 200 });
  const extraOwnerFixture = route === 'list' && (role === 'builder' || role === 'viewer') ? 1 : 0;
  expect(workspaceRuns.items.length + foreignRuns.items.length - extraOwnerFixture, id).toBe(
    result['runCount'],
  );
  if (foreignBefore !== null) expect(await store.get(OTHER_RUN)).toEqual(foreignBefore);
}

async function assertStream(response: Response) {
  expect(Object.fromEntries(response.headers.entries())).toEqual(
    Object.fromEntries(
      Object.entries(SSE_HEADERS).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  );
  await response.body?.cancel();
}

async function assertStartedRun(
  { fixture: { store }, response, result }: ScenarioAssertion,
  body: Record<string, unknown>,
) {
  const run = asRecord(body['run'], 'run');
  expect(run['status']).toBe('queued');
  expect(response.headers.get('location')).toBe(body['events']);
  const stored = await store.get(asString(run['id'], 'run.id'));
  expect(stored?.workspaceId).toBe(WORKSPACE);
  expect(stored?.ownerPrincipalId).toBe(
    result['createdOwnerId'] === 'owner' ? OWNER : result['createdOwnerId'],
  );
  expect(stored?.sessionId).toBe(
    result['createdSessionId'] === 'se1' ? SESSION : result['createdSessionId'],
  );
}

function assertListedRuns(
  { fixture: { listStore, role }, result }: ScenarioAssertion,
  body: Record<string, unknown>,
) {
  expect(Array.isArray(body['runs'])).toBe(true);
  const input = listStore.mock.calls[0]?.[1];
  if (input === undefined) throw new Error('listRuns was not called');
  expect(input.filter?.ownerPrincipalId ?? null).toBe(
    result['ownerFilter'] === null ? null : OWNER,
  );
  if (role === 'builder' || role === 'viewer') {
    const rows = body['runs'];
    if (!Array.isArray(rows)) throw new Error('runs is not an array');
    expect(rows).toHaveLength(1);
    expect(asRecord(rows[0], 'listed run')['id']).toBe(RUN);
  }
}

async function assertReadRun({ route, store }: ScenarioFixture, body: Record<string, unknown>) {
  const run = asRecord(body['run'], 'run');
  expect(run['id']).toBe(RUN);
  if (route === 'interrupt') {
    expect(run['status']).toBe('cancelled');
    expect((await store.get(RUN))?.status).toBe('cancelled');
  }
}
