import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import { describe, expect, it } from 'vitest';

import { versionRequest } from '../../../agent-versions/fixtures';
import type { Role } from '../../../rbac/roles';
import type { CallContext, CheckerPort } from '../../ports';

/** A valid draft named `name` that references exactly these connectors. */
export function draftBody(name: string, connectors: readonly string[] = []): AgentVersionBody {
  return AgentVersionBodySchema.parse(
    versionRequest({ name, resources: { connectors: [...connectors] } }).body,
  );
}

export interface CheckerFixture {
  readonly port: CheckerPort;
  /** A valid draft naming exactly these connectors; the workspace holds `crm` and no `erp`. */
  readonly bodyWith: (connectors: readonly string[]) => AgentVersionBody;
  /** An agent with two saved versions, owned by `agentOwner`. */
  readonly agentWithTwoVersions: string;
  readonly agentOwner: string;
  readonly unknownAgentId: string;
  /** A call as a fresh principal with `role`, or as `principalId` when given; `null` is no caller. */
  readonly ctxOf: (role: Role | null, principalId?: string) => CallContext;
}

/** Memory and production answer a draft check the same way. */
export function describeCheckerConformance(
  label: string,
  make: () => Promise<CheckerFixture>,
): void {
  describe(`CheckerPort: ${label}`, () => {
    it('accepts a valid new draft as version 1', async () => {
      const { port, bodyWith, ctxOf } = await make();
      expect(await port.check(ctxOf('builder'), undefined, bodyWith(['crm']))).toEqual({
        ok: true,
        number: 1,
      });
    });

    it("numbers a Builder's draft of their own agent after its latest version", async () => {
      const { port, bodyWith, ctxOf, agentWithTwoVersions, agentOwner } = await make();
      expect(
        await port.check(ctxOf('builder', agentOwner), agentWithTwoVersions, bodyWith(['crm'])),
      ).toEqual({ ok: true, number: 3 });
    });

    it('refuses a Viewer, for a new agent and for an existing one, before the pipeline', async () => {
      const { port, bodyWith, ctxOf, agentWithTwoVersions, agentOwner } = await make();
      const forbidden = {
        ok: false,
        code: 'forbidden',
        message: 'The person may not change this agent, so a draft of it cannot be checked.',
        details: [],
        fix: 'The person cannot change this agent; stop and tell them.',
      };
      // `erp` is missing: a refusal that reached the pipeline would answer its code instead.
      expect(await port.check(ctxOf('viewer'), undefined, bodyWith(['erp']))).toEqual(forbidden);
      expect(
        await port.check(ctxOf('viewer', agentOwner), agentWithTwoVersions, bodyWith(['erp'])),
      ).toEqual(forbidden);
    });

    it("refuses a Builder's check of another person's agent", async () => {
      const { port, bodyWith, ctxOf, agentWithTwoVersions } = await make();
      expect(
        await port.check(ctxOf('builder'), agentWithTwoVersions, bodyWith(['erp'])),
      ).toMatchObject({ ok: false, code: 'forbidden' });
    });

    it('lets an Admin or Owner check any agent', async () => {
      const { port, bodyWith, ctxOf, agentWithTwoVersions } = await make();
      for (const role of ['admin', 'owner'] as const) {
        expect(await port.check(ctxOf(role), agentWithTwoVersions, bodyWith(['crm']))).toEqual({
          ok: true,
          number: 3,
        });
        expect(await port.check(ctxOf(role), undefined, bodyWith(['crm']))).toEqual({
          ok: true,
          number: 1,
        });
      }
    });

    it('refuses a missing connector with the pipeline code, its details and a fix', async () => {
      const { port, bodyWith, ctxOf } = await make();
      expect(await port.check(ctxOf('builder'), undefined, bodyWith(['crm', 'erp']))).toEqual({
        ok: false,
        code: 'agent_definition_references_missing',
        message: 'The definition names resources this workspace does not have.',
        details: ['connector:erp'],
        fix: 'Call catalog_list to see what exists, or ask the person.',
      });
    });

    it('refuses an agent the workspace does not have', async () => {
      const { port, bodyWith, ctxOf, unknownAgentId } = await make();
      expect(await port.check(ctxOf('builder'), unknownAgentId, bodyWith(['crm']))).toEqual({
        ok: false,
        code: 'agent_not_found',
        message: 'This workspace has no agent with that id.',
        details: [],
        fix: 'Fix the problems listed in details and call draft_check again.',
      });
    });

    it('refuses a run with no person behind it', async () => {
      const { port, bodyWith, ctxOf } = await make();
      expect(await port.check(ctxOf(null), undefined, bodyWith(['crm']))).toMatchObject({
        ok: false,
        code: 'no_caller',
      });
    });
  });
}
