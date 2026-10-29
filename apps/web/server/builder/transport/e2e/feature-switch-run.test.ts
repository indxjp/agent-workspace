/**
 * [US-BLD-04][api][run] The workspace's `builder` switch (ADR-0160) governs both Builder doors
 * through the real composition: off answers 404 `feature_disabled` before any port, on serves a
 * read, and a switch-off in the middle of a run refuses the run's next tool call (issue #1846
 * slice 3).
 */
import { randomUUID } from 'node:crypto';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearFeatureSwitches } from '../../../features/runtime';

import { draftBody } from '../../adapters/checker/checker.contract';
import { InMemoryRunStore } from '../../../runs/memory-store';
import { serveExternalBuilderMcp, type ExternalPrincipal } from '../external';
import { WORKSPACE, builderDoor, scriptedModel, toolResults, toolUse, type Door } from './harness';

const ORIGIN = 'https://aw.example.test';
const MODEL = 'scripted:builder-feature-switch';
const SAVE = { body: draftBody('Refund desk', ['crm']) };
const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);
const switchOff = (door: Door) => door.workspaceFeatures.replaceDisabled(['builder']);
const FEATURE_DISABLED = { status: 404, isError: true, result: { code: 'feature_disabled' } };

/** A refused answer must not carry the run's token, nor any token the caller presented. */
function expectNoTokenIn(texts: readonly string[], tokens: readonly string[]): void {
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) for (const token of tokens) expect(text).not.toContain(token);
}

afterEach(() => {
  vi.unstubAllEnvs();
  // The switches live in a process slot the harness installs; leave none behind for the next test.
  clearFeatureSwitches();
});

describe('[US-BLD-04][api][run] POST /api/builder/mcp follows the workspace switch', () => {
  it('serves a read tool call while the Builder is on (the default)', async () => {
    const door = builderDoor({ scopes: scopes() });
    const { token } = await door.start({ role: 'builder' }, MODEL);

    await expect(door.call(token, 'catalog_list', { kinds: ['engines'] })).resolves.toMatchObject({
      status: 200,
      result: { ok: true },
    });
    expect(door.journal).toHaveLength(1);
  });

  it('answers 404 feature_disabled before any port while the Builder is off', async () => {
    const door = builderDoor({ scopes: scopes() });
    const { token } = await door.start({ role: 'builder' }, MODEL);
    await switchOff(door);

    for (const [tool, args] of [
      ['catalog_list', { kinds: ['engines'] }],
      ['draft_save', SAVE],
    ] as const) {
      await expect(door.call(token, tool, args)).resolves.toMatchObject(FEATURE_DISABLED);
    }
    expect(door.portCalls).toEqual([]);
    expect(door.journal).toHaveLength(0);
    expectNoTokenIn(door.responses, [token]);
  });
});

describe('[US-BLD-04][api][run] POST /mcp/builder follows the workspace switch', () => {
  const principal: ExternalPrincipal = {
    via: 'oauth-token',
    oauth: { clientId: 'client-1', audience: `${ORIGIN}/mcp/builder` },
    scope: { kind: 'builder', id: 'client-1' },
    workspaceId: WORKSPACE,
    principalId: 'principal-builder',
    ownerPrincipalId: 'principal-builder',
    userId: 'user-builder',
    role: 'builder',
    apiKeyId: null,
  };
  const read = async (door: Door) => {
    vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
    const response = await serveExternalBuilderMcp(
      new Request(`${ORIGIN}/mcp/builder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer awo_live_x' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'catalog_list', arguments: { kinds: ['engines'] } },
        }),
      }),
      { identify: () => Promise.resolve(principal), ports: door.ports },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('serves a read tool call while the Builder is on, and refuses it once it is off', async () => {
    const door = builderDoor({ scopes: scopes() });
    const served = await read(door);
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ result: { isError: false } });

    const callsWhileOn = [...door.portCalls];
    const journalWhileOn = door.journal.length;

    await switchOff(door);
    const refused = await read(door);
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: { code: 'feature_disabled' } });
    expectNoTokenIn([JSON.stringify(refused.body)], ['awo_live_x']);
    // Refused before any port: the one served read is the only call that reached one.
    expect(door.portCalls).toEqual(callsWhileOn);
    expect(door.journal).toHaveLength(journalWhileOn);
  });
});

describe('[US-BLD-04][api][run] switching the Builder off in the middle of a run', () => {
  it('refuses the next tool call, writes nothing, and serves it again once the Builder is back on', async () => {
    const store = new InMemoryRunStore();
    const door = builderDoor({ runStore: store, scopes: scopes() });
    // An approved save: the call is admitted, so the switch is the only thing that can refuse it.
    const paused = await scriptedModel(`builder-pause-${randomUUID()}`, {
      turns: [{ toolUses: [toolUse('draft_save', SAVE)] }, { text: 'Saved.' }],
    });
    const pausedRun = await door.start({ role: 'builder' }, paused);
    await door.runScripted(pausedRun.token, paused, { gated: true });
    const decided = await door.decide(pausedRun.runId, 'approve');
    const { token } = await door.start({ role: 'builder' }, paused, decided.runId);

    const reads = await scriptedModel(`builder-reads-${randomUUID()}`, {
      turns: [{ toolUses: [toolUse('catalog_list', { kinds: ['engines'] })] }, { text: 'Read.' }],
    });
    expect(toolResults(await door.runScripted(token, reads))).toMatchObject([{ ok: true }]);
    expect(door.journal).toHaveLength(1);

    const before = door.portCalls.length;
    const versionsBefore = door.versions.versionCount();
    const responsesBefore = door.responses.length;
    await switchOff(door);

    const next = await scriptedModel(`builder-next-${randomUUID()}`, {
      turns: [
        {
          toolUses: [toolUse('draft_save', SAVE), toolUse('catalog_list', { kinds: ['engines'] })],
        },
        { text: 'Refused.' },
      ],
    });
    expect(toolResults(await door.runScripted(token, next))).toMatchObject([
      { ok: false, code: 'feature_disabled' },
      { ok: false, code: 'feature_disabled' },
    ]);
    expect(door.portCalls).toHaveLength(before);
    expect(door.journal).toHaveLength(1);
    expect(door.auditEvents).toHaveLength(0);
    expect(door.versions.versionCount()).toBe(versionsBefore);

    // The same refusal over the door's own wire: 404 feature_disabled, nothing written, no new row.
    await expect(door.call(token, 'draft_save', SAVE)).resolves.toMatchObject(FEATURE_DISABLED);
    expect(door.versions.versionCount()).toBe(versionsBefore);
    expect(door.journal).toHaveLength(1);
    expectNoTokenIn(door.responses.slice(responsesBefore), [token]);

    await door.workspaceFeatures.replaceDisabled([]);
    await expect(door.call(token, 'draft_save', SAVE)).resolves.toMatchObject({
      status: 200,
      result: { ok: true },
    });
    expect(door.auditEvents).toHaveLength(1);
  });
});
