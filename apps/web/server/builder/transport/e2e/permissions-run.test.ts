/**
 * [US-BLD-04][api][run] A Builder run never does more than the person who started it: a Viewer's
 * run reads but cannot write, a run an API key started with no person behind it gets `no_caller` on
 * every write (issue #1846 slice 4).
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { draftBody } from '../../adapters/checker/checker.contract';
import { WORKSPACE, builderDoor, scriptedModel, toolResults, toolUse, type Door } from './harness';

const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);

const SAVE = { body: draftBody('Order desk', ['crm']) };
const TRIAL = { agentId: '00000000-0000-4000-8000-000000000001', version: 1, input: 'Hello.' };
const MODEL = 'scripted:builder-permissions';

/** Neither an answer that left the door nor a journal row may carry the run's token. */
function expectNoTokenIn(door: Door, token: string): void {
  expect(door.responses.length).toBeGreaterThan(0);
  for (const text of [...door.responses, ...door.journal.map((row) => JSON.stringify(row))]) {
    expect(text).not.toContain(token);
  }
}

const rowsOf = (door: Door, runId: string) => door.journal.filter((row) => row.runId === runId);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[US-BLD-04][api][run] a Builder run never does more than the person who started it', () => {
  it("a Viewer's scripted run lists what a Viewer may read and is refused draft_save", async () => {
    const model = await scriptedModel('builder-viewer', {
      turns: [
        {
          toolUses: [
            toolUse('catalog_list', { kinds: ['engines', 'connectors'] }),
            toolUse('draft_save', SAVE),
          ],
        },
        { text: 'You may look, but saving needs a Builder.' },
      ],
    });
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'viewer' }, model);

    const [listed, saved] = toolResults(await door.runScripted(token, model));

    // A Viewer reads engines and not connectors, exactly as the console's GET routes answer.
    expect(listed).toMatchObject({ ok: true });
    const entries = (listed as { entries: { kind: string }[] }).entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.kind === 'engines')).toBe(true);
    // The access rule refuses before any executor runs; #1847 s2 makes the write path real, and
    // this refusal must hold then too.
    expect(saved).toMatchObject({ ok: false, code: 'not_permitted' });
    expect(rowsOf(door, runId).map(({ tool, outcome, code }) => ({ tool, outcome, code }))).toEqual(
      [
        { tool: 'catalog_list', outcome: 'ok', code: null },
        { tool: 'draft_save', outcome: 'refused', code: 'not_permitted' },
      ],
    );
    expectNoTokenIn(door, token);
  });

  it("a Builder-role member's draft_save passes every rule and stops at the ask for approval", async () => {
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, MODEL);

    await expect(door.call(token, 'draft_save', SAVE)).resolves.toMatchObject({
      isError: true,
      result: { ok: false, code: 'approval_required' },
    });
    expect(rowsOf(door, runId)).toHaveLength(1);
    expectNoTokenIn(door, token);
  });

  it('a run an API key started with no subject gets no_caller on writes and reads nothing', async () => {
    const door = builderDoor({ scopes: scopes() });
    const { runId, token } = await door.start({ apiKey: true }, MODEL);

    for (const [tool, args] of [
      ['draft_save', SAVE],
      ['trial_run', TRIAL],
    ] as const) {
      await expect(door.call(token, tool, args)).resolves.toMatchObject({
        isError: true,
        result: { ok: false, code: 'no_caller' },
      });
    }
    // The pre-check answers before the shell, so no write attempt is journalled.
    expect(rowsOf(door, runId)).toHaveLength(0);

    // A read gets past the pre-check and the core's no-caller rule, but the production
    // authorization adapter fails closed for a run with no person, so it is refused, journalled.
    const listed = await door.call(token, 'catalog_list', { kinds: ['connectors'] });
    expect(listed.result).toMatchObject({ ok: false, code: 'not_permitted' });
    expect(rowsOf(door, runId)).toEqual([
      expect.objectContaining({ tool: 'catalog_list', outcome: 'refused', code: 'not_permitted' }),
    ]);
    expectNoTokenIn(door, token);
  });
});
