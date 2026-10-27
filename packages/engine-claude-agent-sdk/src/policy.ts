/**
 * The Claude engine's policy arm on the private `/run` contract (ENG-04b, #325).
 *
 * `RunRequest.policy` is `unknown` in `packages/core` and in the port, and this is where it stops
 * being unknown — for this engine and for no other. The arm is *parsed*, never cast: it arrives
 * from an `agents.policy` JSONB column through an HTTP body, and ADR-0015's first rule is to parse
 * before comparing. A policy this schema refuses becomes `engine_policy_invalid`, a typed refusal
 * with a stable code that the runner turns into a `run-error` frame before any output.
 *
 * ## What the arm carries, and what it deliberately does not
 *
 * Four fields, and each is something only the Claude Agent SDK's grammar can express:
 *
 *   * `tools` — the agent's **stored** narrowing (`AgentToolPolicySchema`), or `null` for an agent whose
 *     `policy` column is NULL. It is the stored value verbatim and *not* the effective policy: the
 *     permission floor, the file-grant denials and the connector auto-approvals are added by
 *     `./tools.ts`'s `compileClaudeToolPolicy`, here, inside the adapter.
 *   * `fileGrantDeny` — the read-only-grant denials the *control plane* derived, kept as a
 *     compose-side guard (`applyFileGrantPolicy`). This adapter derives the same list itself from
 *     the request's grants and de-duplicates the two, so the field can only ever narrow and never
 *     widen. `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md` records when
 *     it may be dropped: once no supported runner image predates ENG-04's own grant compilation.
 *   * `requireApproval` and `approvedToolCalls` — the approval gate (ADR-0145 D2.1, D3): the tools
 *     that stop the run, and the exact calls a person already approved.
 *
 * There is no `scope` and no `agent`. The tenant session scope is derived from `cwd` and
 * `request.projectKey` by `./scope.ts`, and everything portable is `RunRequest.portable`.
 */
import {
  AgentToolPolicySchema,
  DenyingToolRuleSchema,
  RequireApprovalRuleSchema,
} from '@indx-workspace/contracts/agents';
import { engineSettingsSchema } from '@indx-workspace/contracts/engines';
import { z } from 'zod';

/**
 * Starts from the catalogue's `claude-agent-sdk` settings (none today), so a setting added to the
 * catalogue reaches this arm without a second edit (#992); `.strict()` stays explicit.
 */
export const ClaudeRunPolicy = engineSettingsSchema('claude-agent-sdk')
  .extend({
    /** The agent's stored narrowing, or `null` when its `policy` column is NULL. */
    tools: AgentToolPolicySchema.nullable(),
    /**
     * The compose-side file-grant guard's denials. Validated with the same rule grammar the stored
     * policy's `deny` uses, so a malformed entry is refused here rather than handed to the SDK.
     */
    fileGrantDeny: z.array(DenyingToolRuleSchema).default([]),
    /**
     * Tools whose calls stop the run until a person approves them (ADR-0145). Names the whole tool;
     * `./tools.ts`'s `splitApprovals` keeps every rule that could approve one out of `allowedTools`.
     */
    requireApproval: z.array(RequireApprovalRuleSchema).default([]),
    /** Offer the `handoff_to_person` tool (ADR-0145 D4). The control plane sends the key only when it is on. */
    handoff: z.boolean().default(false),
    /** The canonical texts (`canonicalCall`) of the calls already approved for this run. */
    approvedToolCalls: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ClaudeRunPolicy = z.infer<typeof ClaudeRunPolicy>;
