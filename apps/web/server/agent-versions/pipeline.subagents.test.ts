import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearEnginesRegisteredForTests } from '../engines/registry';
import { FIXTURE_POLICY, versionRequest } from './fixtures';
import {
  agent,
  refusalOf,
  storeWith,
  storeWithAgents,
  validate,
  withBody,
} from './pipeline.test-support';
import type { WorkspaceAgentVersionStore } from './store';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentVersion', () => {
  describe('4c. subagents', () => {
    const naming = (...names: string[]) =>
      withBody(versionRequest(), { subagents: names.map((name) => ({ name })) });
    const unusable = (details: string[]) => ({
      error: { code: 'agent_subagent_unusable', details },
    });

    it('refuses a subagent no agent of the workspace carries', async () => {
      const store = await storeWithAgents([{ name: 'Researcher' }]);
      const refusal = refusalOf(await validate(naming('ghost'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['subagent:ghost']));
    });

    it('refuses a subagent that declares subagents itself (nesting)', async () => {
      const store = await storeWithAgents([{ name: 'b', subagents: ['c'] }, { name: 'c' }]);
      const refusal = refusalOf(await validate(naming('b'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['subagent:b']));
    });

    it('refuses a back-reference: the subagent already names the agent being saved', async () => {
      const store = await storeWithAgents([
        { name: 'Support triage' },
        { name: 'b', subagents: ['Support triage'] },
      ]);
      const refusal = refusalOf(await validate(naming('b'), { store }));
      expect(refusal.body).toMatchObject(unusable(['subagent:b', 'parent:b']));
    });

    it("refuses an agent that is already someone's subagent gaining subagents", async () => {
      const store = await storeWithAgents([
        { name: 'ok' },
        { name: 'Support triage' },
        { name: 'parent-z', subagents: ['Support triage'] },
        { name: 'parent-a', subagents: ['Support triage'] },
      ]);
      const refusal = refusalOf(await validate(naming('ok'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['parent:parent-a', 'parent:parent-z']));
    });

    it('lists the unusable subagents first and then the parents', async () => {
      const store = await storeWithAgents([
        { name: 'Support triage' },
        { name: 'parent', subagents: ['Support triage'] },
      ]);
      const refusal = refusalOf(await validate(naming('ghost'), { store }));
      expect(refusal.body).toMatchObject(unusable(['subagent:ghost', 'parent:parent']));
    });

    it('does not count the agent being saved as its own parent', async () => {
      const store = await storeWithAgents([{ name: 'ok' }]);
      const subject = agent();
      const parents = vi.spyOn(store, 'subagentParents');
      await validate(naming('ok'), { store, subject });
      expect(parents).toHaveBeenCalledWith('Support triage', subject.id);
    });

    it('lists every unusable name in body order and skips the usable ones', async () => {
      const store = await storeWithAgents([{ name: 'ok' }, { name: 'nested', subagents: ['ok'] }]);
      const refusal = refusalOf(await validate(naming('nested', 'ok', 'ghost'), { store }));
      expect(refusal.body).toMatchObject(unusable(['subagent:nested', 'subagent:ghost']));
    });

    it('answers a dry run exactly as a save', async () => {
      const store = await storeWithAgents([{ name: 'b', subagents: ['c'] }, { name: 'c' }]);
      const saved = refusalOf(await validate(naming('b', 'ghost'), { store }));
      const base = naming('b', 'ghost');
      const dry = refusalOf(await validate({ ...base, dryRun: true }, { store }));
      expect(dry).toEqual(saved);
    });

    it('refuses a subagent whose version has no description', async () => {
      const store = await storeWithAgents([{ name: 'mute', described: false }, { name: 'ok' }]);
      const refusal = refusalOf(await validate(naming('mute', 'ok'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['subagent:mute']));
    });

    it('saves a usable subagent on an engine that delegates', async () => {
      const store = await storeWithAgents([{ name: 'ok' }]);
      expect((await validate(naming('ok'), { store })).ok).toBe(true);
    });

    it('lets a usable subagent through to the capability check', async () => {
      const store = await storeWithAgents([{ name: 'ok' }]);
      const base = naming('ok');
      const pi = { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits } as const;
      const onPi = versionRequest({ policy: pi });
      const refusal = refusalOf(
        await validate(
          { ...base, body: { ...onPi.body, subagents: base.body.subagents } },
          { store },
        ),
      );
      expect(refusal.body).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['subagents'] },
      });
    });

    it('never asks for agents when the body names no subagent', async () => {
      const store = await storeWith();
      const agentsByName = vi.fn<WorkspaceAgentVersionStore['agentsByName']>();
      const subagentParents = vi.fn<WorkspaceAgentVersionStore['subagentParents']>();
      expect(
        (await validate(versionRequest(), { store: { ...store, agentsByName, subagentParents } }))
          .ok,
      ).toBe(true);
      expect(agentsByName).not.toHaveBeenCalled();
      expect(subagentParents).not.toHaveBeenCalled();
    });
  });
});
