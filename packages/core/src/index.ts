/**
 * `@agent-workspace/core` — shared types, configuration and validation schemas.
 *
 * Three modules, and the split is deliberate:
 *
 *   * `types.ts`   — the SDK's surface, transcribed from the R-01 research note.
 *   * `schemas.ts` — the Zod schemas the UI, the database and the runner all validate through.
 *
 * **Spec §5's compile step is no longer here.** ENG-04 (#303) moved `compileRunRequest` and
 * `CompiledSdkOptions` into `@agent-workspace/engine-claude-agent-sdk`: they are one engine's
 * option surface, and an engine's options belong to that engine's adapter. What stays is what
 * every engine's adapter and the control plane share — the agent configuration schemas, the
 * run request, and the `agent.*` mapping the control plane also runs over pre-ENG-03 rows.
 *
 * The database layer is **not** re-exported here. It has its own entry point,
 * `@agent-workspace/core/db`, so that importing a schema does not drag a Postgres client into a
 * caller that only wanted to validate a form.
 */
export const PACKAGE_NAME = '@agent-workspace/core';

export * from './types.js';
export * from './schemas.js';
export * from './net/egress-policy.js';
