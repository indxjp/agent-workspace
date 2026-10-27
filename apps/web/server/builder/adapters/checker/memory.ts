import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

import type { CheckerPort } from '../../ports';
import { mayCheck } from './access';
import { failedCheck, FORBIDDEN, NO_CALLER } from './failure';

export interface MemoryAgent {
  readonly versions: number;
  readonly ownerPrincipalId: string;
}

/** Answers as the pipeline's dry run does for the one rule the contract suite exercises: a missing connector. */
// ponytail: only connector references are checked; the production adapter runs the whole pipeline.
export class MemoryChecker implements CheckerPort {
  constructor(
    private readonly connectors: ReadonlySet<string>,
    private readonly agents: ReadonlyMap<string, MemoryAgent>,
  ) {}

  check: CheckerPort['check'] = (ctx, agentId, body: AgentVersionBody) => {
    if (ctx.caller.kind === 'none') return Promise.resolve(NO_CALLER);
    const agent = agentId === undefined ? undefined : this.agents.get(agentId);
    if (agentId !== undefined && agent === undefined) {
      return Promise.resolve(
        failedCheck('agent_not_found', 'This workspace has no agent with that id.', []),
      );
    }
    const target =
      agentId === undefined || agent === undefined ? undefined : { id: agentId, ...agent };
    if (!mayCheck(ctx.caller.principal, target)) return Promise.resolve(FORBIDDEN);
    const missing = body.definition.resources.connectors.filter(
      (name) => !this.connectors.has(name),
    );
    if (missing.length > 0) {
      return Promise.resolve(
        failedCheck(
          'agent_definition_references_missing',
          'The definition names resources this workspace does not have.',
          missing.map((name) => `connector:${name}`),
        ),
      );
    }
    return Promise.resolve({ ok: true, number: (agent?.versions ?? 0) + 1 });
  };
}
