import type { BuilderDecision } from '@indx-workspace/contracts/builder';

import type { ToolCall } from './call';
import type { Facts } from './facts';
import { RULES } from './rules';

/** What to do with one tool call: the first rule that answers decides, otherwise the tool runs. */
export function decide(call: ToolCall, facts: Facts): BuilderDecision {
  for (const rule of RULES) {
    const decision = rule(call, facts);
    if (decision) return decision;
  }
  return { kind: 'run', tool: call.tool };
}
