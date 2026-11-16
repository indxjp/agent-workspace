import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createAgentFromVersion } from '../../../agent-versions/create-from-version';
import { createInMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import { type AgentStoreProvider } from '../../../agents/store';
import { handleToolCall } from '../../shell';
import { callContextOf } from '../../testing/context';
import { BuilderAuthorization, makeMemoryPorts } from '../../testing/ports';
import { MemoryApproval } from '../approval/memory';
import { draftBody } from '../checker/checker.contract';
import { createChecker } from '../checker/production';
import { MemoryPolicy } from '../policy/memory';
import { MemoryAgentStore } from './memory';
import { createAgentStore } from './production';
import { describeAgentStoreConformance } from './store.contract';

import { productionFixture, withAgentReadOverride } from './production.test-support';

describeAgentStoreConformance('the memory adapter', () => {
  const store = new MemoryAgentStore();
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  return Promise.resolve({
    port: store,
    ctx: callContextOf(workspaceId, 'builder', principalId),
    viewer: callContextOf(workspaceId, 'viewer'),
    noCaller: callContextOf(workspaceId, null),
    otherWorkspace: callContextOf(crypto.randomUUID(), 'builder', principalId),
    personId: principalId,
    markBuiltin: (agentId) => Promise.resolve(store.markBuiltin(workspaceId, agentId)),
    inspect: (agentId) => Promise.resolve(store.inspect(workspaceId, agentId)),
    auditEvents: (agentId) =>
      Promise.resolve(store.auditEvents(workspaceId).filter((row) => row.subjectId === agentId)),
    seedProduction: (agentId, version) =>
      Promise.resolve(store.seedProduction(workspaceId, agentId, version)),
  });
});

describeAgentStoreConformance('the production adapter over in-memory stores', () => {
  const stored = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({ agents: stored });
  // The memory store has no built-in rows; the adapter only reads the marker off what `get` returns.
  const builtinIds = new Set<string>();
  const agents: AgentStoreProvider = withAgentReadOverride(stored, (agent, agentId) =>
    builtinIds.has(agentId) ? { ...agent, builtin: 'builder' } : agent,
  );
  return Promise.resolve(
    productionFixture({
      agents: agents,
      versions: versions,
      person: {
        workspaceId: crypto.randomUUID(),
        otherWorkspaceId: crypto.randomUUID(),
        principalId: crypto.randomUUID(),
        userId: null,
      },
      markBuiltin: (agentId) => Promise.resolve(void builtinIds.add(agentId)),
      auditEvents: (agentId) =>
        Promise.resolve(
          versions
            .audits()
            .filter((row) => row.action === 'agent-created' && row.subjectId === agentId)
            .map((row) => ({ ...row, details: row.details ?? null })),
        ),
    }),
  );
});

describe('the workspace creation quota counts a console creation (#1851)', () => {
  it("refuses the Builder's next new agent once the console has used the limit", async () => {
    const agents = createInMemoryAgentStoreProvider();
    const versions = createInMemoryAgentVersionStoreProvider({ agents });
    const workspaceId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const pipeline = () => ({});
    const port = createAgentStore({
      agents,
      versions,
      pipeline,
      actorLabel: (_workspaceId, id) => Promise.resolve(id),
    });
    const store = await versions.forWorkspace(workspaceId);
    if (store === null) throw new Error('the workspace resolves');
    // The console route: the version pipeline with no Builder origin, so it writes no agent-created row.
    const fromConsole = await createAgentFromVersion(
      { version: { body: draftBody('From the console'), summary: 's', via: 'api' } },
      { principalId, ownerPrincipalId: principalId, userId: null, actorLabel: 'a person' },
      { ...pipeline(), store, agents: agents.forWorkspace(workspaceId) },
    );
    expect(fromConsole.status).toBe(201);

    const approval = new MemoryApproval();
    const ctx = callContextOf(workspaceId, 'builder', principalId);
    const args = { body: draftBody('From the Builder') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const result = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      makeMemoryPorts({
        approval,
        store: port,
        policy: new MemoryPolicy({ creationsPerWorkspacePerDay: 1 }),
      }),
    );

    expect(result).toMatchObject({ ok: false, code: 'quota_exceeded' });
  });
});

describe('the Builder cannot save to an archived agent (#1851)', () => {
  it('refuses draft_save as agent_archived and writes no version, pointer move or audit row', async () => {
    const stored = createInMemoryAgentStoreProvider();
    const archived = new Set<string>();
    // The memory store cannot write `archived_at`, so the rows of `archived` are marked as they are read.
    const agents: AgentStoreProvider = withAgentReadOverride(stored, (agent, agentId) =>
      archived.has(agentId)
        ? { ...agent, archivedAt: new Date('2026-10-01T00:00:00.000Z') }
        : agent,
    );
    const versions = createInMemoryAgentVersionStoreProvider({ agents });
    const workspaceId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const port = createAgentStore({
      agents,
      versions,
      pipeline: () => ({}),
      actorLabel: (_workspaceId, id) => Promise.resolve(id),
    });
    const ctx = callContextOf(workspaceId, 'builder', principalId);
    const made = await port.save(ctx, { body: draftBody('Frozen') });
    if (!made.ok) throw new Error(`the first save failed: ${made.code}`);
    archived.add(made.agentId);
    const before = {
      versions: versions.versionCount(),
      pointers: versions.pointerCount(),
      audits: versions.audits().length,
    };

    const approval = new MemoryApproval();
    // The memory authorization knows no agents; the person owns this one.
    const authorization = new BuilderAuthorization();
    authorization.access = () => Promise.resolve('allowed');
    const args = { agentId: made.agentId, baseVersion: made.version, body: draftBody('Edited') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const checker = createChecker({ agents, versions, pipeline: () => ({}) });
    const result = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      makeMemoryPorts({ approval, authorization, checker, store: port }),
    );

    expect(result).toMatchObject({ ok: false, code: 'agent_archived' });
    // The store refuses on its own too, whatever the check before it said.
    expect(
      await port.save(ctx, { agentId: made.agentId, baseVersion: made.version, body: args.body }),
    ).toMatchObject({ ok: false, code: 'agent_archived' });
    expect({
      versions: versions.versionCount(),
      pointers: versions.pointerCount(),
      audits: versions.audits().length,
    }).toEqual(before);
    expect(await port.localVersion(ctx, made.agentId)).toBe(made.version);
  });
});

describe('what the Builder store may reach', () => {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const sources = (dir: string) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.|\.contract\./u.test(file))
      .map((file) => ({ file, text: readFileSync(path.join(dir, file), 'utf8') }));

  /** `text` with the `BUILDER_PROMPT` template literal sliced out; throws if it is not there. */
  const withoutPrompt = (text: string) => {
    const start = text.indexOf('export const BUILDER_PROMPT = `');
    const end = text.indexOf('\n`;\n', start);
    if (start < 0 || end < 0) throw new Error('definition.ts no longer declares BUILDER_PROMPT');
    return text.slice(0, start) + text.slice(end + '\n`;\n'.length);
  };

  it('never promotes, rolls back or deletes an agent', () => {
    // definition.ts stays scanned without its prompt, prose that tells the model it cannot promote.
    const scanned = sources(path.join(server, 'builder')).map(({ file, text }) => ({
      file,
      text: file === path.join('agent', 'definition.ts') ? withoutPrompt(text) : text,
    }));
    expect(scanned.map(({ file }) => file)).toContain(path.join('agent', 'definition.ts'));
    const named = scanned.filter(({ text }) => /promote|rollback|deleteAgent/iu.test(text));
    expect(named.map(({ file }) => file)).toEqual([]);
  });
});
