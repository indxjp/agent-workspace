/**
 * The OpenAI Agents engine's policy arm on the private `/run` contract (ENG-09, #308).
 *
 * `RunRequest.policy` is `unknown` in the port, and this is where it stops being unknown for this
 * engine. The arm is **parsed**, never cast, for the reason the Claude arm is: it arrives from an
 * `agents.policy` JSONB column through an HTTP body. A value this schema refuses is
 * `engine_policy_invalid`, a typed refusal before any output frame.
 *
 * ## What the arm carries
 *
 * Two optional model settings — the same fields, over the same values, as the `openai-agents` arm
 * of `@indx-workspace/contracts`' `AgentPolicySchema` — and nothing that names a tool. The tool set is compiled from the
 * portable `permissions` alone (`./tools.ts`), so there is no engine-native tool grammar to store:
 *
 *   * `reasoningEffort` — the Responses API's `reasoning.effort`, which the SDK takes as
 *     `modelSettings.reasoning.effort`;
 *   * `parallelToolCalls` — `modelSettings.parallelToolCalls`.
 *
 * Handoffs, guardrails and `needsApproval` are deliberately absent: they are not platform concepts
 * (ADR-0065 D9), so a stored policy has no way to ask for them. `.strict()` makes a body that tries
 * a refusal rather than a silently ignored field.
 */
import { engineSettingsSchema } from '@indx-workspace/contracts/engines';
import type { z } from 'zod';

/** Derived from the catalogue's `openai-agents` settings, so the arm and the catalogue cannot drift (#992). */
export const OpenAiAgentsRunPolicy = engineSettingsSchema('openai-agents');
export type OpenAiAgentsRunPolicy = z.infer<typeof OpenAiAgentsRunPolicy>;
