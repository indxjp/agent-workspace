/**
 * Whole Builder chats (issue #1848 slice 3). Each chat is a checked-in script of assistant turns
 * (`tests/builder/scripted/<chat>.json`) replayed by the gateway's scripted model; every `aw-control` tool use
 * goes to `POST /api/builder/mcp` with the run's own token, through the e2e harness. The assertions
 * read tool results and journal rows, never the scripted text. No provider, key or network is used.
 * Chat 6, the turn limit, is in `tests/builder/turn-limit.test.ts`: the engine enforces it, not this route.
 */
import { fileURLToPath } from 'node:url';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import {
  BUILDER_CHECK_FIXES,
  BUILDER_DEFAULT_LIMITS,
  BUILDER_REFUSAL_CODES,
} from '@indx-workspace/contracts/builder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRunStore } from '../../../runs/memory-store';
import { WORKSPACE, builderDoor, scriptedModelFile, toolResults, type Door } from './harness';

const SCRIPTS = fileURLToPath(new URL('../../../../../../tests/builder/scripted', import.meta.url));
const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);

const rowsOf = (door: Door, runId: string) =>
  door.journal
    .filter((row) => row.runId === runId)
    .map(({ tool, outcome, code }) => ({ tool, outcome, code }));

const MISSING = {
  ok: false,
  code: 'agent_definition_references_missing',
  details: ['connector:erp'],
  fix: BUILDER_CHECK_FIXES.missingReferences,
};

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  vi.stubGlobal('fetch', () =>
    Promise.reject(new Error('the scripted chats must not reach the network')),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('[US-BLD-01][api][chat] the expense-refunds conversation, up to the question', () => {
  it('reads the catalog and an example, fails the check on connector:erp, and saves nothing', async () => {
    const model = await scriptedModelFile(SCRIPTS, 'expense-refunds-happy');
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, model);

    const results = toolResults(await door.runScripted(token, model));

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(results[2]).toMatchObject(MISSING);
    // The chat stops at the ask; the next describe plays on from the person's "yes".
    expect(rowsOf(door, runId)).toEqual([
      { tool: 'catalog_list', outcome: 'ok', code: null },
      { tool: 'examples_get', outcome: 'ok', code: null },
      { tool: 'draft_check', outcome: 'check_failed', code: 'agent_definition_references_missing' },
    ]);
  });
});

describe('[US-BLD-01][api][chat] the expense-refunds conversation, after the person says yes', () => {
  it('passes the check on crm, pauses at draft_save, saves once when approved, and closes', async () => {
    const model = await scriptedModelFile(SCRIPTS, 'expense-refunds-happy');
    const door = builderDoor({
      runStore: new InMemoryRunStore(),
      scopes: scopes(),
    });
    const { runId, token } = await door.start({ role: 'builder' }, model);
    const asked = await door.runScripted(token, model, { gated: true });

    const yes = [...asked, { role: 'user', content: 'yes' }];
    const paused = await door.runScripted(token, model, { gated: true, history: yes });

    expect(toolResults(paused).slice(3)).toEqual([expect.objectContaining({ ok: true })]);
    expect(door.versions.versionCount()).toBe(0);
    const decided = await door.decide(runId, 'approve');
    // The continuation re-asks the paused call with the history up to it, as the engine does.
    const continued = await door.start({ role: 'builder' }, model, decided.runId);
    const closed = await door.runScripted(continued.token, model, {
      gated: true,
      history: paused.slice(0, -1),
    });

    expect(toolResults(closed).slice(4)).toEqual([
      expect.objectContaining({ ok: true, version: 1, pointer: 'local' }),
    ]);
    expect(door.versions.versionCount()).toBe(1);
    expect(door.auditEvents.filter((event) => event.action === 'agent-created')).toHaveLength(1);
    expect(rowsOf(door, runId).slice(3)).toEqual([
      { tool: 'draft_check', outcome: 'ok', code: null },
    ]);
    // The continuation run holds the approval's own refused row, then the one approved save.
    expect(rowsOf(door, decided.runId)).toEqual([
      { tool: 'draft_save', outcome: 'refused', code: 'approval_required' },
      { tool: 'draft_save', outcome: 'ok', code: null },
    ]);
    expect(closed.at(-1)).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(closed.at(-1))).not.toContain('tool_use');
  });
});

describe('[US-BLD-02][api][chat] a named error leads to a question, not a guess', () => {
  it('makes one failed check naming connector:erp, then no further tool call', async () => {
    const model = await scriptedModelFile(SCRIPTS, 'missing-connector-asks');
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, model);

    expect(toolResults(await door.runScripted(token, model))).toEqual([
      expect.objectContaining(MISSING),
    ]);
    expect(rowsOf(door, runId)).toEqual([
      { tool: 'draft_check', outcome: 'check_failed', code: 'agent_definition_references_missing' },
    ]);
  });
});

describe('[US-BLD-02][api][run] five failed checks stop the Builder', () => {
  it('refuses the sixth draft_check with check_limit_reached; the journal holds the five and the refusal', async () => {
    const { maxFailedChecksInARow } = BUILDER_DEFAULT_LIMITS;
    const model = await scriptedModelFile(SCRIPTS, 'five-failures-stop');
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, model);

    const results = toolResults(await door.runScripted(token, model));

    expect(results).toHaveLength(maxFailedChecksInARow + 1);
    for (const result of results.slice(0, maxFailedChecksInARow)) {
      expect(result).toMatchObject({ ok: false, code: 'agent_definition_references_missing' });
    }
    expect(results[maxFailedChecksInARow]).toMatchObject({
      ok: false,
      code: 'check_limit_reached',
    });
    expect(rowsOf(door, runId)).toEqual([
      ...Array.from({ length: maxFailedChecksInARow }, () => ({
        tool: 'draft_check',
        outcome: 'check_failed',
        code: 'agent_definition_references_missing',
      })),
      { tool: 'draft_check', outcome: 'refused', code: 'check_limit_reached' },
    ]);
  });
});

describe('[US-BLD-04][api][run] a Viewer cannot save', () => {
  it("refuses a Viewer's draft_save with not_permitted before any executor runs", async () => {
    const model = await scriptedModelFile(SCRIPTS, 'viewer-cannot-save');
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'viewer' }, model);

    expect(toolResults(await door.runScripted(token, model))).toEqual([
      expect.objectContaining({
        ok: false,
        code: 'not_permitted',
        fix: BUILDER_REFUSAL_CODES.not_permitted.fix,
      }),
    ]);
    expect(rowsOf(door, runId)).toEqual([
      { tool: 'draft_save', outcome: 'refused', code: 'not_permitted' },
    ]);
  });
});

describe('[US-BLD-02][api][run] the Builder recovers from bad tool arguments', () => {
  it('answers an extra workspaceId with invalid_arguments, then passes the corrected retry', async () => {
    const model = await scriptedModelFile(SCRIPTS, 'bad-tool-args-recover');
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, model);

    const results = toolResults(await door.runScripted(token, model));

    expect(results).toEqual([
      expect.objectContaining({ ok: false, code: 'invalid_arguments' }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(rowsOf(door, runId)).toEqual([
      { tool: 'draft_check', outcome: 'refused', code: 'invalid_arguments' },
      { tool: 'draft_check', outcome: 'ok', code: null },
    ]);
  });
});
