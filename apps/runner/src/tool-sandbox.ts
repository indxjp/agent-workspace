/**
 * One tool sandbox per session (ADR-0118 TS2): the container that runs a session's code tools,
 * placed by a second driver instance beside the agent's sandbox and never inside it.
 *
 * Secrets reach it as a file written over `docker exec` standard input (TS4), never as an argument
 * or an image variable; the sandbox opens its port only once it has read and removed that file.
 * On a provider-hosted sandbox (E2B, ADR-0120 LC5) the file travels over the provider's HTTPS file
 * API with the provider's per-sandbox token. The per-run bearer token (TS3) is written after the
 * sandbox is up, replacing the previous run's, so a token stops working as soon as the next run of
 * the session registers its own or the sandbox is closed. This module never prints a manifest
 * value or a token.
 *
 * A provider that can list its sandboxes (E2B) tags each one with its workspace, session, session
 * key, tool set and the run that started it, and closing a session kills every sandbox tagged with
 * it, so a stateless manager (ADR-0126) closes what another invocation started (ADR-0132).
 */
import { withCompensation } from '@agent-workspace/core';
import {
  ToolSandboxRequestSchema,
  type ToolSandboxRequest,
} from '@indx-workspace/contracts/agent-versions';
import type {
  RuntimeConfig,
  RuntimeDriverId,
  RuntimeHandle,
} from '@agent-workspace/runtime/driver';

/** The engine key the tool driver's image map carries; nothing else is ever started from it. */
export const TOOL_SANDBOX_ENGINE = 'tool-host';

const MANIFEST_FILE = 'manifest.json';
const TOKENS_FILE = 'tokens.json';
const MIB = 1024 * 1024;
// A `stdio` server's package is fetched by `npx` on first start: the tool host waits up to 120 s
// for its servers (90 s for each `npx` start), so the runner waits no less.
const STDIO_READY_TIMEOUT_MS = 120_000;
// A sandbox outlives its run's deadline by this much, so a run's last tool call is never cut off,
// and a sandbox whose release never came (a crashed manager or control plane) ends soon after.
const TIMEOUT_MARGIN_SECONDS = 120;

/**
 * The slice of a driver a tool sandbox needs. `credential` is the caller's provider key for this
 * call only (ADR-0120 LC6); the Docker driver has none and ignores it. A stateless driver
 * (ADR-0126) also has `find`, so a manager with no table still reuses a session's sandbox.
 */
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

/** Which session a tool sandbox belongs to; `key` is `''` when the run profile is not known. */
export type ToolSandboxSession = Readonly<{ key: string; workspaceId: string; sessionId: string }>;

/** Where a request for a tool sandbox's `/mcp` goes, and the headers its provider's edge needs. */
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

/** The sandbox could not be started, or did not become ready. The message never carries a value. */
export class ToolSandboxUnavailableError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolSandboxUnavailableError';
  }
}

/** `error` as an unavailable tool sandbox: its message after `what`, and it as the cause. */
function unavailable(what: string, error: unknown): ToolSandboxUnavailableError {
  return error instanceof ToolSandboxUnavailableError
    ? error
    : new ToolSandboxUnavailableError(
        `${what}: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
}

/** The request body's `toolSandbox`, parsed with a message that names paths and never values. */
export function parseToolSandboxRequest(value: unknown): ToolSandboxRequest {
  const parsed = ToolSandboxRequestSchema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || 'toolSandbox');
    throw new Error(`toolSandbox is invalid: ${[...new Set(paths)].join(', ')}`);
  }
  return parsed.data;
}

/** The workspace tmpfs the sandbox needs: the manifest, the decoded bundles, and head room. */
function diskMbFor(request: ToolSandboxRequest): number {
  const bytes = request.manifest.tools.reduce((sum, tool) => sum + tool.bundleBase64.length, 0);
  return Math.max(64, Math.ceil((bytes * 3) / MIB) + 16);
}

export function createToolSandboxes(
  options: Readonly<{
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
    readyTimeoutMs?: number;
    /** The most a sandbox lives after the last run that opened it (ADR-0132's backstop). */
    timeoutSeconds?: number;
  }>,
): ToolSandboxes {
  const doFetch = options.fetch ?? globalThis.fetch;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  /** `startedBy` is `<workspaceId>/<runId>` of the run that started the sandbox, when this table saw it. */
  const sandboxes = new Map<
    string,
    Readonly<{ key: string; handle: RuntimeHandle; startedBy?: string }>
  >();
  // One start at a time per allocation, so two runs of it cannot start two sandboxes.
  const queue = new Map<string, Promise<unknown>>();
  const upstreamOf = options.upstream;

  /**
   * Any HTTP answer from `/mcp` means the host is serving: it refuses a request with no token. A
   * provider's edge answers a closed port itself (E2B: 502), so there only a 4xx or below counts.
   * The sandbox must still be live after that answer, so one that answered and then exited is
   * refused.
   */
  async function waitUntilServing(
    handle: RuntimeHandle,
    publicBase: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const target = upstreamOf?.(handle) ?? {
      url: `${options.origin(handle, publicBase)}/mcp`,
      headers: {},
    };
    let lastStatus: number | undefined;
    while (Date.now() < deadline) {
      if (!(await options.driver.isLive(handle))) {
        throw new ToolSandboxUnavailableError(
          'the tool sandbox stopped before it served: a tool bundle did not start',
        );
      }
      const answered = await doFetch(target.url, {
        method: 'POST',
        headers: { ...target.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(2_000),
      }).then(
        async (response) => {
          await response.body?.cancel();
          lastStatus = response.status;
          return upstreamOf === undefined || response.status < 500;
        },
        () => false,
      );
      if (answered) {
        if (await options.driver.isLive(handle)) return;
        throw new ToolSandboxUnavailableError(
          'the tool sandbox stopped after it answered: a tool bundle did not start',
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new ToolSandboxUnavailableError(
      `the tool sandbox did not become ready in time (${lastStatus === undefined ? 'no answer' : `last answer HTTP ${String(lastStatus)}`})`,
    );
  }

  /**
   * The profile id names the allocation and the tool set, so a stateless driver finds the same
   * sandbox again, and a changed tool set (a new key) is a new sandbox rather than a reuse of one
   * that holds the old secrets.
   */
  function configFor(
    session: Parameters<ToolSandboxes['open']>[0],
    request: ToolSandboxRequest,
  ): RuntimeConfig {
    const domains = request.allowedDomains ?? [];
    const deadlineSeconds =
      options.timeoutSeconds === undefined
        ? session.timeoutSeconds
        : Math.min(session.timeoutSeconds ?? options.timeoutSeconds, options.timeoutSeconds);
    const timeoutSeconds =
      deadlineSeconds === undefined ? undefined : deadlineSeconds + TIMEOUT_MARGIN_SECONDS;
    return {
      sessionId: session.sessionId,
      engine: TOOL_SANDBOX_ENGINE,
      workspacePath: `${session.workspacesRoot}/tool-sandbox/${encodeURIComponent(session.key)}`,
      runtimeProfileId: `tool-sandbox:${session.key}:${request.key}`,
      runSpec: {
        runtimeProfileId: 'tool-sandbox',
        driver: options.driverId ?? 'docker',
        // No declared domain means no egress at all (TS5).
        networkPolicy: domains.length === 0 ? 'none' : 'restricted',
        filesystem: 'read-write',
        diskMb: diskMbFor(request),
        ...(domains.length === 0 ? {} : { allowedDomains: domains }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      },
    };
  }

  async function start(
    session: Parameters<ToolSandboxes['open']>[0],
    request: ToolSandboxRequest,
  ): Promise<RuntimeHandle> {
    const credential = session.providerCredential;
    const handle = await options.driver
      .create(configFor(session, request), credential, {
        ...sessionTags(session),
        awSessionKey: session.key,
        awTools: request.key,
        awRun: request.run.runId,
      })
      .catch((error: unknown) => {
        throw unavailable('the tool sandbox could not be started', error);
      });
    await withCompensation(
      async () => {
        try {
          await options.driver.writeFile(
            handle,
            MANIFEST_FILE,
            JSON.stringify(request.manifest),
            credential,
          );
          await waitUntilServing(
            handle,
            session.publicBase ?? '',
            request.manifest.stdioServers.length > 0
              ? Math.max(readyTimeoutMs, STDIO_READY_TIMEOUT_MS)
              : readyTimeoutMs,
          );
        } catch (error) {
          throw unavailable('the tool sandbox could not be prepared', error);
        }
      },
      () => options.driver.destroy(handle, credential),
    );
    return handle;
  }

  /** No secret: the tool set is named by its key, a digest. */
  function sessionTags(session: Omit<ToolSandboxSession, 'key'>): Record<string, string> {
    return { awWorkspace: session.workspaceId, awSession: session.sessionId };
  }

  async function open(
    session: Parameters<ToolSandboxes['open']>[0],
    request: ToolSandboxRequest,
  ): Promise<string> {
    const credential = session.providerCredential;
    try {
      // Refuse what the provider cannot place (a declared domain on E2B) before it is called.
      options.driver.assertCreatable?.(configFor(session, request), credential);
    } catch (error) {
      throw unavailable('the tool sandbox could not be started', error);
    }
    /** The session's previous sandbox holds old secrets: no new one starts while it may live on. */
    const removePrevious = (handle: RuntimeHandle) =>
      options.driver.destroy(handle, credential).catch((error: unknown) => {
        throw new ToolSandboxUnavailableError(
          "the session's previous tool sandbox could not be removed",
          { cause: error },
        );
      });
    // A driver that can find the sandbox asks the provider, which every invocation shares.
    let current = options.driver.find === undefined ? sandboxes.get(session.key) : undefined;
    if (current !== undefined && current.key !== request.key) {
      // The session's tool set changed (a new version): the old sandbox holds the old secrets.
      sandboxes.delete(session.key);
      await removePrevious(current.handle);
      current = undefined;
    }
    if (current === undefined && options.driver.find !== undefined) {
      // Another invocation of a stateless manager may have started it: it has its manifest already.
      const found = await options.driver.find(configFor(session, request), credential);
      if (found !== undefined) {
        current = { key: request.key, handle: found };
      }
    }
    if (current !== undefined && !(await options.driver.isLive(current.handle))) {
      sandboxes.delete(session.key);
      await removePrevious(current.handle);
      current = undefined;
    }
    let started = false;
    if (current === undefined) {
      // Whatever the provider still holds for this session key is an older tool set (or one
      // another invocation lost): it holds the old secrets, so it goes before the new one starts.
      await options.driver
        .destroyTagged?.({ ...sessionTags(session), awSessionKey: session.key }, credential)
        .catch((error: unknown) => {
          throw new ToolSandboxUnavailableError(
            "the session's previous tool sandbox could not be removed",
            { cause: error },
          );
        });
      current = {
        key: request.key,
        handle: await start(session, request),
        startedBy: `${session.workspaceId}/${request.run.runId}`,
      };
      started = true;
    }
    // Recorded, so a `close` on this invocation destroys it.
    sandboxes.set(session.key, current);
    const { handle } = current;
    await withCompensation(
      () =>
        options.driver
          .writeFile(handle, TOKENS_FILE, JSON.stringify([request.run.token]), credential)
          .catch((error: unknown) => {
            throw unavailable('the run token could not be registered', error);
          }),
      async () => {
        if (!started) return;
        // Nothing records or reaches this sandbox yet: killing it now, not at its timeout, is the
        // only way its provider slot is freed.
        sandboxes.delete(session.key);
        await options.driver.destroy(handle, credential);
      },
    );
    return options.origin(handle, session.publicBase ?? '');
  }

  return {
    open(session, request) {
      const previous = queue.get(session.key) ?? Promise.resolve();
      const next = previous.then(
        () => open(session, request),
        () => open(session, request),
      );
      queue.set(session.key, next);
      void next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async close(session, providerCredential) {
      const { key } = session;
      await queue.get(key)?.catch(() => undefined);
      queue.delete(key);
      const current = sandboxes.get(key);
      sandboxes.delete(key);
      await withCompensation(
        async () => {
          if (options.driver.destroyTagged !== undefined) {
            await options.driver.destroyTagged(sessionTags(session), providerCredential);
          } else if (current !== undefined) {
            await options.driver.destroy(current.handle, providerCredential);
          }
        },
        async () => {
          // The sandbox outlives the close: at least the run token it holds stops working.
          if (current !== undefined) {
            await options.driver.writeFile(current.handle, TOKENS_FILE, '[]', providerCredential);
          }
        },
      );
    },
    async release(run, providerCredential) {
      const startedBy = `${run.workspaceId}/${run.runId}`;
      const started = [...sandboxes].filter(([, entry]) => entry.startedBy === startedBy);
      for (const [key] of started) sandboxes.delete(key);
      if (options.driver.destroyTagged !== undefined) {
        // Another invocation of a stateless manager may have started it: the provider knows.
        await options.driver.destroyTagged(
          { awWorkspace: run.workspaceId, awRun: run.runId },
          providerCredential,
        );
      } else {
        await Promise.all(
          started.map(([, entry]) => options.driver.destroy(entry.handle, providerCredential)),
        );
      }
    },
    ...(upstreamOf === undefined
      ? {}
      : {
          upstream(id: string) {
            const handle =
              options.recover?.(id) ??
              [...sandboxes.values()].find((entry) => entry.handle.id === id)?.handle;
            return handle === undefined ? undefined : upstreamOf(handle);
          },
        }),
  };
}
