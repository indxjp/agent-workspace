/**
 * The environment half of the compile step: the A.11 constants and the one function that
 * assembles `options.env` and refuses it when it breaks the sandbox rules.
 *
 * Split out of `./compile.ts` so that file reads as the list of steps §5 describes; the behaviour
 * is unchanged, and `./compile.ts` re-exports every name here.
 */
import {
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  type RunRequest,
} from '@agent-workspace/run-protocol';
import {
  QUIET_CLAUDE_ENVIRONMENT,
  quietEnvironmentVerdict,
  sandboxEnvironmentVerdict,
} from '@agent-workspace/engine';

import type { claudeSessionScope } from './scope.js';

/** The two environment variables {@link compileRunRequest} derives, never copies. */
export const SESSION_SCOPE_ENV_VARS = [
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
] as const;

/**
 * A.11's `AGENT_WORKSPACE_RUN_ID` / `AGENT_WORKSPACE_SESSION_ID` — the platform's own run and
 * Claude-session identifiers, "echoed in every event and log line" and "for resume" respectively.
 * Named here rather than folded into {@link SESSION_SCOPE_ENV_VARS}: that constant is the tenant
 * *session scope* pair (`apps/runner/src/index.ts`'s `runnerBaseEnvironment` documents it as
 * exactly two keys), and these two are a different A.11 concern — identity, not scope — so
 * extending the existing constant would make that file's own comment wrong without this task
 * being able to fix it (`index.ts` is outside this task's `Owns` globs). A future task that wants
 * a container's base environment to also exclude these two can filter by this array without
 * either file needing to change the other's meaning.
 */
export const A11_IDENTITY_ENV_VARS = [
  'AGENT_WORKSPACE_RUN_ID',
  'AGENT_WORKSPACE_SESSION_ID',
] as const;

const AGENT_WORKSPACE_RUN_ID_ENV = A11_IDENTITY_ENV_VARS[0];
const AGENT_WORKSPACE_SESSION_ID_ENV = A11_IDENTITY_ENV_VARS[1];

/**
 * A.11: *"Provider master credentials never enter a sandbox."*
 *
 * Kept as a named export because `compile.test.ts` and `packages/core`'s `RunEnvironment` both
 * spell it, and one spelling of a forbidden key is the point. The *check* is no longer written
 * here, though: ENG-04 moved it to `@agent-workspace/engine`'s `sandboxEnvironmentVerdict`,
 * which states the rule as a property of the environment — no `ANTHROPIC_API_KEY`, and every
 * `*_API_KEY` / `*_AUTH_TOKEN` holding this run's own gateway token — rather than as one
 * provider's spelling. A second adapter inherits the rule instead of re-deriving it.
 */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

type SessionScope = Extract<ReturnType<typeof claudeSessionScope>, { ok: true }>['scope'];

/**
 * The complete subprocess environment for one run, or a thrown refusal.
 *
 * `options.env` REPLACES the subprocess environment — it is not merged with `process.env`
 * (R-01 §3, a breaking change in SDK 0.2.113). `request.env` is therefore the complete
 * environment the runner decided on, and this adds derived values on top: the quiet flags (D-13,
 * so a caller cannot turn them off), the two-variable tenant session scope, plus A.11's
 * `AGENT_WORKSPACE_RUN_ID` / `AGENT_WORKSPACE_SESSION_ID`, read off the request's own `runId` /
 * `sessionId` rather than copied from `request.env` (they are derived, always last, so they
 * always win).
 *
 * A.11: "Provider master credentials never enter a sandbox." ADR-0015's explicit `else`: this is
 * not a warning and not a strip-and-continue, because either of those would start a run whose
 * environment the caller believed was safe. The check is written against the assembled
 * environment, so it also catches a future edit that adds a derived entry without noticing what
 * it collides with.
 *
 * `gateway.token` is what the second half of the rule compares against: a variable spelled like
 * a credential and holding something other than this run's own gateway token is a provider
 * credential by definition. A request with no `gateway` is checked against the
 * `ANTHROPIC_AUTH_TOKEN` it already carries. See `packages/engine/src/sandbox-env.ts`.
 */
export function compileRunEnvironment(
  request: RunRequest,
  scope: SessionScope,
): Record<string, string> {
  const env: Record<string, string> = {
    // Since SDK 0.3.304 Claude Code defers MCP tools behind ToolSearch, so a connector tool is
    // absent from the request's `tools` until the model searches for it. That needs the Messages
    // API's tool-reference support, which the model gateway does not promise for every upstream;
    // every connector tool is sent up front instead, as before. The runner may still override it.
    ENABLE_TOOL_SEARCH: 'false',
    ...request.env,
    ...QUIET_CLAUDE_ENVIRONMENT,
    [CLAUDE_CONFIG_DIR_ENV]: scope.configDir,
    [CLAUDE_CODE_PROJECT_DIR_NAME_ENV]: scope.projectKey,
    [AGENT_WORKSPACE_RUN_ID_ENV]: request.runId,
    [AGENT_WORKSPACE_SESSION_ID_ENV]: request.sessionId,
  };

  const runToken = request.gateway?.token ?? env['ANTHROPIC_AUTH_TOKEN'] ?? '';
  refuseUnlessOk(sandboxEnvironmentVerdict(env, runToken));
  refuseUnlessOk(quietEnvironmentVerdict(env));
  return env;
}

function refuseUnlessOk(
  verdict: { readonly ok: true } | { readonly ok: false; readonly reason: string },
): void {
  if (!verdict.ok) {
    throw new Error(`compileRunRequest: refusing to compile this run — ${verdict.reason}`);
  }
}
