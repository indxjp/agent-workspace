/**
 * The seam between `/api/auth/cli-*` (issue #242, SDK-10, S-22) and the `cli_sessions`
 * repository — the same registry shape `apps/web/server/tokens/runtime.ts` uses.
 */
import type { CliSessionRepository } from '@agent-workspace/core/db';
import { defineSlot } from '../runtime-slot';

export interface CliAuthRuntime {
  readonly sessions: CliSessionRepository;
  /** The deployment's session secret; the device code's MAC key. */
  readonly secret: string;
}

const slot = defineSlot<CliAuthRuntime>('__agentWorkspaceCliAuthRuntime__');

export function configureCliAuthRuntime(runtime: CliAuthRuntime): void {
  slot.set(runtime);
}

export function clearCliAuthRuntime(): void {
  slot.clear();
}

export function currentCliAuthRuntime(): CliAuthRuntime | null {
  return slot.current();
}
