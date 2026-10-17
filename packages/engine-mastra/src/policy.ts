/**
 * The Mastra engine's policy arm on the private `/run` contract (ENG-10, #309).
 *
 * `RunRequest.policy` is `unknown` in the port, and this is where it stops being unknown for this
 * engine. The arm is **parsed**, never cast: it arrives from an `agents.policy` JSONB column through
 * an HTTP body. A value this schema refuses is `engine_policy_invalid`, a typed refusal before any
 * output frame.
 *
 * ## What the arm carries
 *
 * One optional setting — the same field, over the same bounds, as the `mastra` arm of
 * `@indx-workspace/contracts`' `AgentPolicySchema` — and nothing that names a tool, a memory
 * option or an observability exporter. The tool set is compiled from the portable `permissions`
 * alone (`./tools.ts`), and memory and telemetry are fixed by the adapter (ADR-0084):
 *
 *   * `toolCallConcurrency` — Mastra's `toolCallConcurrency` on `agent.stream()`.
 *
 * `withheldPermissions` is not forwarded: compose has already applied it to the portable
 * permissions (`policyNarrowedPermissions`), so the adapter sees its effect, not the list.
 */
import { engineSettingsSchema } from '@indx-workspace/contracts/engines';
import type { z } from 'zod';

/** Derived from the catalogue's `mastra` settings, so the arm and the catalogue cannot drift (#992). */
export const MastraRunPolicy = engineSettingsSchema('mastra');
export type MastraRunPolicy = z.infer<typeof MastraRunPolicy>;
