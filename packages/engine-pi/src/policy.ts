/**
 * The pi engine's policy arm on the private `/run` contract (ENG-08, #307).
 *
 * `RunRequest.policy` is `unknown` in the port, and this is where it stops being unknown for this
 * engine. The arm is **parsed**, never cast: it arrives from an `agents.policy` JSONB column through
 * an HTTP body. A value this schema refuses is `engine_policy_invalid`, a typed refusal before any
 * output frame.
 *
 * ## What the arm carries
 *
 * One optional model setting — the same field, over the same values, as the `pi` arm of
 * `@indx-workspace/contracts`' `AgentPolicySchema` — and nothing that names a tool. The tool set
 * is compiled from the portable `permissions` alone (`./tools.ts`):
 *
 *   * `thinkingLevel` — pi's `createAgentSession({ thinkingLevel })`, clamped by pi to the model.
 *
 * `withheldPermissions` is not forwarded: compose has already applied it to the portable
 * permissions (`policyNarrowedPermissions`), so the adapter sees its effect, not the list.
 */
import { engineSettingsSchema } from '@indx-workspace/contracts/engines';
import type { z } from 'zod';

/** Derived from the catalogue's `pi` settings, so the arm and the catalogue cannot drift (#992). */
export const PiRunPolicy = engineSettingsSchema('pi');
export type PiRunPolicy = z.infer<typeof PiRunPolicy>;
