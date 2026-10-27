/**
 * [US-BLD-04][api][run] A token that is no longer good is refused at the door: once the run has
 * ended, or once the token is revoked, every tool answers the typed `not_permitted` refusal, writes
 * no journal row and reaches no port (issue #1846 slice 4).
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { draftBody } from '../../adapters/checker/checker.contract';
import { WORKSPACE, builderDoor, type Door } from './harness';

const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);
const MODEL = 'scripted:builder-refusals';

const CALLS = [
  ['catalog_list', { kinds: ['engines'] }],
  ['draft_check', { body: draftBody('Order desk', ['crm']) }],
  ['draft_save', { body: draftBody('Order desk', ['crm']) }],
] as const;

async function expectRefusedBeforeAnyPort(door: Door, token: string): Promise<void> {
  for (const [tool, args] of CALLS) {
    const answer = await door.call(token, tool, args);
    expect(answer).toMatchObject({ status: 403, isError: true, result: { code: 'not_permitted' } });
  }
  expect(door.responses.join('')).not.toContain(token);
  expect(door.journal).toHaveLength(0);
  expect(door.portCalls).toEqual([]);
}

describe('[US-BLD-04][api][run] a token that is no longer good is refused', () => {
  it('control: the same call on a live run reaches the ports and is journalled', async () => {
    const door = builderDoor({ featureOn: true, scopes: scopes() });
    const { token } = await door.start({ role: 'builder' }, MODEL);

    await expect(door.call(token, 'catalog_list', { kinds: ['engines'] })).resolves.toMatchObject({
      status: 200,
      result: { ok: true },
    });
    expect(door.portCalls).not.toEqual([]);
    expect(door.journal).toHaveLength(1);
  });

  it('a run that has ended is refused with not_permitted, journals nothing and reaches no port', async () => {
    const door = builderDoor({ featureOn: true, scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, MODEL);
    door.end(runId);

    await expectRefusedBeforeAnyPort(door, token);
  });

  it('a revoked token is refused with not_permitted, journals nothing and reaches no port', async () => {
    const door = builderDoor({ featureOn: true, scopes: scopes() });
    const { token } = await door.start({ role: 'builder' }, MODEL);
    await door.revoke(token);

    await expectRefusedBeforeAnyPort(door, token);
  });
});
