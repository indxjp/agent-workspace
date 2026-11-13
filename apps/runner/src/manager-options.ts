import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import { type ManagedRuntimeDriver } from './manager-support.js';
import { type ToolSandboxes } from './tool-sandbox.js';

export type RunnerManagerOptions = Readonly<{
  token: string;
  driver: ManagedRuntimeDriver;
  workspacesRoot: string;
  runtimeOrigin?: (handle: RuntimeHandle) => string;
  /**
   * Resolve one runtime-contract path to its complete upstream URL.
   *
   * Most drivers expose a stable origin, so the default simply appends `path` to
   * {@link runtimeOrigin}. Azure Container Apps dynamic sessions are different: the session
   * identifier is routing data and must be present on every request, including readiness and
   * verification probes. Supplying this seam keeps that provider-specific URL shape out of the
   * generic manager and, importantly, prevents a later `/run`, `/interrupt`, or `/files` proxy
   * from accidentally bypassing the identifier that `/ping` used.
   */
  runtimeRequestUrl?: (handle: RuntimeHandle, path: string) => string;
  /** The only `runSpec.driver` this manager's `driver` will accept. Defaults to `docker`. */
  expectedDriver?: string;
  /**
   * Extra headers attached to every request this manager makes to a runtime — `/healthz` and
   * `/verify/echo` during verification, and every proxied `/run`, `/interrupt`, `/files` call.
   * `docker` and `kubernetes` runtimes sit on a private network the manager already trusts and
   * need nothing here; `cloud-run-service` runtimes are private Cloud Run services and need a
   * Google-signed identity token scoped to that exact service URL (see
   * `@agent-workspace/runtime`'s `fetchCloudRunIdentityToken`).
   */
  runtimeAuthHeaders?: (handle: RuntimeHandle) => Promise<Record<string, string>>;
  /** Stable non-secret identity for the configured image/driver implementation. */
  configurationFingerprint?: string;
  fetch?: typeof globalThis.fetch;
  verificationTimeoutMs?: number;
  /**
   * The path polled during `/verify` to decide a runtime is ready. Defaults to `/healthz`, the
   * spec §14.3 liveness route every runtime image implements. `cloud-run-service` sets this to
   * `/ping` — the same handler, mounted at a second path (`apps/runner/src/server.ts`) — because
   * Google Cloud's edge intercepts the literal path `/healthz` on a `*.a.run.app` default domain
   * and answers with its own generic 404 before the request reaches any container; confirmed
   * across independent services in `docs/adr/ADR-cloud-run-service-driver.md`. `/ping` is not a
   * reserved path there, so it reaches the runtime like any other. `docker` and `kubernetes`
   * runtimes are not behind that edge and are unaffected by this option's default.
   */
  readinessPath?: string;
  /**
   * Starts a session's tool sandbox when an allocation carries `toolSandbox` (ADR-0118 TS2). Unset,
   * such an allocation is refused with `503 tool_sandbox_unavailable`: a deployment that cannot
   * isolate code tools must say so rather than run a session without them.
   */
  toolSandboxes?: ToolSandboxes;
  /** Why an allocation carrying `toolSandbox` is refused when {@link toolSandboxes} is unset. */
  toolSandboxRefusal?: string;
}>;
