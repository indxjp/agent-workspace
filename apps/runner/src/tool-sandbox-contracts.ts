import {
  ToolSandboxRequestSchema,
  type ToolSandboxRequest,
} from '@indx-workspace/contracts/agent-versions';
import type {
  RuntimeConfig,
  RuntimeDriverId,
  RuntimeHandle,
} from '@agent-workspace/runtime/driver';

export const TOOL_SANDBOX_ENGINE = 'tool-host';
export const TOKENS_FILE = 'tokens.json';

export interface ToolSandboxDriver {
  /** `tags` are recorded with the sandbox for `destroyTagged`; they never hold a secret. */
  create(
    config: RuntimeConfig,
    credential?: string,
    tags?: Readonly<Record<string, string>>,
  ): Promise<RuntimeHandle>;
  destroy(runtime: RuntimeHandle, credential?: string): Promise<void>;
  isLive(runtime: RuntimeHandle): Promise<boolean>;
  writeFile(
    runtime: RuntimeHandle,
    name: string,
    content: string,
    credential?: string,
  ): Promise<void>;
  find?(config: RuntimeConfig, credential?: string): Promise<RuntimeHandle | undefined>;
  /** Everything `create` refuses before the provider is called, for a driver that has one. */
  assertCreatable?(config: RuntimeConfig, credential?: string): void;
  /** Destroys every sandbox at the provider tagged with all of `tags`, whoever created it. */
  destroyTagged?(tags: Readonly<Record<string, string>>, credential?: string): Promise<void>;
}

export type ToolSandboxSession = Readonly<{ key: string; workspaceId: string; sessionId: string }>;

export type ToolSandboxUpstream = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

export type ToolSandboxes = Readonly<{
  /**
   * Start (or reuse) the allocation's tool sandbox and register the run's token. Returns its
   * origin. `key` is the allocation's session key (`profile:sessionId`), so two profiles of one
   * session never share or revoke each other's sandbox.
   */
  open(
    session: Readonly<{
      key: string;
      workspaceId: string;
      sessionId: string;
      workspacesRoot: string;
      timeoutSeconds?: number;
      /** The provider key of this call (LC6), for a driver that has a provider. */
      providerCredential?: string;
      /** `scheme://host` the caller reached this manager at, for an origin the manager serves. */
      publicBase?: string;
    }>,
    request: ToolSandboxRequest,
  ): Promise<string>;
  /**
   * Remove the allocation's tool sandbox, by its session key. A driver that tags its sandboxes
   * also kills every sandbox of the session, whichever invocation started it. A session without
   * one is a no-op.
   */
  close(session: ToolSandboxSession, providerCredential?: string): Promise<void>;
  /**
   * Remove the tool sandboxes `run` itself started (issue #832), so its provider slot is freed when
   * the run ends. A sandbox the run only reused, such as the live one of an earlier run of the
   * session whose new run was refused, is left alone. A run that started none is a no-op.
   */
  release?(
    run: Readonly<{ workspaceId: string; runId: string }>,
    providerCredential?: string,
  ): Promise<void>;
  /**
   * The `/mcp` endpoint of the tool sandbox an id stands for, or `undefined` for an id this manager
   * did not hand out. Only a provider-hosted tool sandbox has one: the manager serves it, so the
   * provider's access token never reaches the gateway or the database.
   */
  upstream?(id: string): ToolSandboxUpstream | undefined;
}>;

export type OpenSession = Parameters<ToolSandboxes['open']>[0];

export type SandboxAllocation = Readonly<{
  key: string;
  handle: RuntimeHandle;
  startedBy?: string;
}>;

export class ToolSandboxUnavailableError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolSandboxUnavailableError';
  }
}

export function unavailable(what: string, error: unknown): ToolSandboxUnavailableError {
  return error instanceof ToolSandboxUnavailableError
    ? error
    : new ToolSandboxUnavailableError(
        `${what}: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
}

export function parseToolSandboxRequest(value: unknown): ToolSandboxRequest {
  const parsed = ToolSandboxRequestSchema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || 'toolSandbox');
    throw new Error(`toolSandbox is invalid: ${[...new Set(paths)].join(', ')}`);
  }
  return parsed.data;
}

export type ToolSandboxOptions = Readonly<{
  driver: ToolSandboxDriver;
  /**
   * Where the gateway reaches the sandbox: the container's name on the tool network, or (with
   * `upstream`) `publicBase` plus the manager's `/tool-sandboxes/<id>` route.
   */
  origin: (handle: RuntimeHandle, publicBase: string) => string;
  /** The driver id a sandbox's run spec names; `docker` unless a provider places the sandbox. */
  driverId?: RuntimeDriverId;
  /** Set for a provider-hosted sandbox: the `/mcp` URL and the headers its edge needs. */
  upstream?: (handle: RuntimeHandle) => ToolSandboxUpstream;
  /** The handle a sealed id stands for (a stateless driver); otherwise this table's own. */
  recover?: (id: string) => RuntimeHandle | undefined;
  fetch?: typeof globalThis.fetch;
  /**
   * Whether an `/mcp` answer means the host is serving. Default: any answer, or below 500 with
   * `upstream`. Cloud Run's tool host answers 503 until it has its manifest, so it passes
   * `status < 500`.
   */
  servingWhen?: (status: number) => boolean;
  readyTimeoutMs?: number;
  /** The most a sandbox lives after the last run that opened it (ADR-0132's backstop). */
  timeoutSeconds?: number;
}>;
