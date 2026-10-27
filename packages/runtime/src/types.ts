/**
 * `packages/runtime/src/types.ts` — spec §15.1's `RuntimeProfile`.
 *
 * A runtime profile is *"the reusable, human-readable answer to 'how much machine, and how much
 * network'"* (§15). §15.1 prints its schema as a plain TypeScript interface; it is transcribed
 * here, unchanged in member names, optionality and type text (`spec-transcription.test.ts`
 * checks this mechanically), as a `type` rather than an `interface` for the same reason
 * `driver.ts` gives for `RuntimeHandle` and `RuntimeCapabilities` — consistency with
 * `packages/run-protocol/src/types.ts`.
 *
 * Runtime HTTP boundaries validate values before constructing this type. The runner manager's
 * schema lives beside that boundary in `apps/runner/src/runtime-run-spec.ts`; this module remains
 * the dependency-light driver contract.
 */
import type { RuntimeDriverId } from './driver.js';

/**
 * §15.1, verbatim. `driverConfig` is the "escape hatch" the spec describes as *"validated per
 * driver with Zod, hidden under 'Advanced'"* — that validation is W3-CP-06's, per the header
 * comment above; this package only carries the shape.
 */
export type RuntimeProfile = {
  readonly id: string;
  readonly name: string;

  readonly driver: RuntimeDriverId;
  /** Which stored runtime connection (cluster, session pool, ECR image...) to use. */
  readonly runtimeConnectionId?: string;

  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;

  readonly networkPolicy: 'none' | 'restricted' | 'open';
  readonly allowedDomains?: string[];

  readonly filesystem: 'read-only' | 'read-write';
  readonly persistPaths?: string[];

  readonly timeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;

  /** Escape hatch. Validated per driver with Zod, hidden under "Advanced". */
  readonly driverConfig?: Record<string, unknown>;
};
