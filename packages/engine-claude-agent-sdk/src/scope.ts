/**
 * Where the Claude Agent SDK keeps its own configuration, and the tenant session scope this
 * adapter derives from that (ENG-04b, #325).
 *
 * `.claude` used to be hard-coded in four places — the control plane's `sandboxFor`, the runner's
 * resource materialisation, the runner's `sessionScopedWorkspacePaths` and
 * `packages/runtime/src/env.ts` — each of them naming a directory belonging to an engine none of
 * them imports. ENG-04 (#324) made the adapter *declare* it; this unit made everyone else *ask*,
 * which is why the name is now written down exactly once, here.
 *
 * ## Why the config directory left the private `/run` contract
 *
 * Until ENG-04b the body carried `scope: { projectKey, configDir }` and the control plane computed
 * `configDir` as `${cwd}/.claude`. The two halves are not the same kind of value, and that is what
 * the split makes visible:
 *
 *   * `projectKey` is the **platform's** tenant namespace. Every engine's session state is keyed by
 *     it (`EngineSessionKey`), §25 requires that two tenants on one workspace path never share one,
 *     and only the control plane knows which tenant a run belongs to. It stays on the wire.
 *   * `configDir` is **this engine's** directory. It is a pure function of `cwd` and a constant this
 *     module owns, so putting it on the wire meant asking the control plane to know one engine's
 *     layout — and getting a different answer from a second adapter would have been silent.
 *
 * The derived string is byte-identical to the one compose used to send, which is what keeps
 * `CLAUDE_CONFIG_DIR` — and therefore which transcript file a resume finds — unchanged.
 */
import { validateTenantSessionScope, type TenantSessionScope } from '@agent-workspace/run-protocol';

/**
 * The directory, relative to `cwd`, the Claude Agent SDK keeps its own configuration in.
 *
 * `CLAUDE_CONFIG_DIR`. R-01 §6 verified live that a session's transcript is one JSONL file under
 * it, and R-01 §7 that the SDK silently ignores the tenant project-key override when it cannot use
 * the directory — so this is not a tidiness rule: a tenant file that changed what is in here would
 * change which tenant namespace a session is keyed under.
 */
export const CLAUDE_PROTECTED_CONFIG_DIRECTORY = '.claude';

/**
 * This run's tenant session scope, derived from the sandbox root and the platform's project key.
 *
 * Returns a **verdict** rather than throwing, because its caller is `compile`, whose contract is
 * that a request this engine will not run is a typed refusal and not an exception. Both of the
 * SDK's failure modes here are silent (R-01 §7 rules 1 and 2): a `CLAUDE_CODE_PROJECT_DIR_NAME`
 * that fails the SDK's own validator, or one set without `CLAUDE_CONFIG_DIR`, is *ignored* and the
 * session is keyed under the sanitised `cwd` — colliding with every other tenant on the same
 * workspace path. Nothing throws and nothing is logged, so the check has to happen before the run
 * starts and it has to be ours.
 */
export function claudeSessionScope(
  cwd: string,
  projectKey: string,
):
  | { readonly ok: true; readonly scope: TenantSessionScope }
  | { readonly ok: false; readonly reason: string } {
  const verdict = validateTenantSessionScope({
    projectKey,
    configDir: `${cwd}/${CLAUDE_PROTECTED_CONFIG_DIRECTORY}`,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, scope: { projectKey: verdict.projectKey, configDir: verdict.configDir } };
}
