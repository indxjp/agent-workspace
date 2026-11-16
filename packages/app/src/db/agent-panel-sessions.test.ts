/**
 * The agent panel's sessions (issue #1509): the in-memory twin always, and the PostgreSQL store
 * against `TEST_DATABASE_URL` when it is set, on a schema `migrateApp` creates from the same SQL
 * the app template's first migration holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import { memoryAgentPanelSessions } from '../testing/memory-agent-panel-sessions.js';
import { createTestAppSchema, type TestAppSchema } from '../testing/pg-test-schema.js';
import {
  agentPanelSessionsOf,
  createAgentPanelSessionsSql,
  type AgentPanelKey,
  type AgentPanelSessionStore,
} from './agent-panel-sessions.js';

const RECORD = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const OTHER_WORKSPACE = '00000000-0000-4000-8000-000000000002';
const KEY: AgentPanelKey = {
  workspaceId: FAKE_WORKSPACE_ID,
  resource: 'ticket',
  recordId: RECORD,
  agent: 'triage',
  principalId: 'principal-a',
};

/** The same behaviour, whichever store keeps the sessions. */
function behavesAsTheSessionStore(store: () => AgentPanelSessionStore): void {
  it('finds nothing before a save, then the latest session, and keeps every older one', async () => {
    expect(await store().find(KEY)).toBeNull();
    await store().save(KEY, 'session-1');
    expect(await store().find(KEY)).toBe('session-1');
    await store().save(KEY, 'session-2');
    expect(await store().find(KEY)).toBe('session-2');
    await store().save(KEY, 'session-2');
    expect(await store().find(KEY)).toBe('session-2');
    expect([...(await store().sessionsOf(KEY.workspaceId, KEY.resource, RECORD))].sort()).toEqual([
      'session-1',
      'session-2',
    ]);
  });

  it("keeps each person's own session: one never finds or replaces another's", async () => {
    const other = { ...KEY, principalId: 'principal-b' };
    expect(await store().find(other)).toBeNull();
    await store().save(other, 'session-b');
    expect(await store().find(other)).toBe('session-b');
    expect(await store().find(KEY)).toBe('session-2');
    expect([...(await store().sessionsOf(KEY.workspaceId, KEY.resource, RECORD))].sort()).toEqual([
      'session-1',
      'session-2',
      'session-b',
    ]);
  });

  it('keeps sessions per agent, and none across workspaces, resources or records', async () => {
    await store().save({ ...KEY, agent: 'writer' }, 'session-w');
    expect(await store().find({ ...KEY, agent: 'writer' })).toBe('session-w');
    expect([...(await store().sessionsOf(KEY.workspaceId, 'ticket', RECORD))].sort()).toEqual([
      'session-1',
      'session-2',
      'session-b',
      'session-w',
    ]);
    expect(await store().find({ ...KEY, workspaceId: OTHER_WORKSPACE })).toBeNull();
    expect(await store().find({ ...KEY, resource: 'note' })).toBeNull();
    expect(await store().sessionsOf(OTHER_WORKSPACE, 'ticket', RECORD)).toEqual([]);
    expect(
      await store().sessionsOf(KEY.workspaceId, 'ticket', '0f5c2a8e-1b2c-4d3e-8f90-000000000000'),
    ).toEqual([]);
  });
}

describe('createAgentPanelSessionsSql', () => {
  it('keys the table by workspace, resource, record, agent, person and session, with no foreign key', () => {
    const text = createAgentPanelSessionsSql('service-desk');
    expect(text).toContain('CREATE TABLE IF NOT EXISTS "app_service_desk"."agent_panel_sessions"');
    expect(text).toContain(
      'PRIMARY KEY ("workspace_id", "resource", "record_id", "agent", "principal_id", "session_id")',
    );
    expect(text).not.toContain('REFERENCES');
    expect(() => createAgentPanelSessionsSql('Not An App')).toThrow(RangeError);
  });
});

describe('memoryAgentPanelSessions', () => {
  const store = memoryAgentPanelSessions();
  behavesAsTheSessionStore(() => store);
});

const rawUrl = process.env['TEST_DATABASE_URL'];
const url = rawUrl === undefined || rawUrl.trim() === '' ? undefined : rawUrl;

if (url === undefined) {
  console.warn(
    '[db/agent-panel-sessions.test.ts] SKIPPED the PostgreSQL half — TEST_DATABASE_URL is not ' +
      'set, so agentPanelSessionsOf was NOT exercised against a real PostgreSQL.',
  );
}

describe.skipIf(url === undefined)('agentPanelSessionsOf against real PostgreSQL', () => {
  let schema: TestAppSchema | undefined;
  let store: AgentPanelSessionStore | undefined;
  const ready = (): AgentPanelSessionStore => {
    if (store === undefined) throw new Error('the test schema was not created');
    return store;
  };

  beforeAll(async () => {
    schema = await createTestAppSchema(url ?? '', []);
    store = agentPanelSessionsOf({ db: schema.db, appName: schema.appName });
  });

  afterAll(async () => {
    await schema?.drop();
  });

  behavesAsTheSessionStore(ready);
});
