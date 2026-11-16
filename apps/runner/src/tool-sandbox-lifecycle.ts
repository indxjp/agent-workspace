import { TOKENS_FILE } from './tool-sandbox-contracts.js';
import { withCompensation } from '@agent-workspace/core';
import { type ToolSandboxRequest } from '@indx-workspace/contracts/agent-versions';
import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import {
  type OpenSession,
  type SandboxAllocation,
  ToolSandboxUnavailableError,
  unavailable,
} from './tool-sandbox-contracts.js';
import type { SandboxContext } from './tool-sandbox-context.js';
import { configFor, sessionTags } from './tool-sandbox-config.js';
import { waitUntilServing, probe, targetOf } from './tool-sandbox-readiness.js';

const MANIFEST_FILE = 'manifest.json';

const STDIO_READY_TIMEOUT_MS = 120_000;

async function startSandbox(
  context: SandboxContext,
  session: OpenSession,
  request: ToolSandboxRequest,
): Promise<RuntimeHandle> {
  const credential = session.providerCredential;
  const handle = await context.options.driver
    .create(configFor(context, session, request), credential, {
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
        await context.options.driver.writeFile(
          handle,
          MANIFEST_FILE,
          JSON.stringify(request.manifest),
          credential,
        );
        await waitUntilServing(
          context,
          handle,
          session.publicBase ?? '',
          request.manifest.stdioServers.length > 0
            ? Math.max(context.readyTimeoutMs, STDIO_READY_TIMEOUT_MS)
            : context.readyTimeoutMs,
        );
      } catch (error) {
        throw unavailable('the tool sandbox could not be prepared', error);
      }
    },
    () => context.options.driver.destroy(handle, credential),
  );
  return handle;
}

async function reuseOrRemoveSandbox(
  context: SandboxContext,
  session: OpenSession,
  request: ToolSandboxRequest,
): Promise<SandboxAllocation | undefined> {
  const credential = session.providerCredential;
  /** The session's previous sandbox holds old secrets: no new one starts while it may live on. */
  const removePrevious = (handle: RuntimeHandle) =>
    context.options.driver.destroy(handle, credential).catch((error: unknown) => {
      throw new ToolSandboxUnavailableError(
        "the session's previous tool sandbox could not be removed",
        { cause: error },
      );
    });
  // A driver that can find the sandbox asks the provider, which every invocation shares.
  let current =
    context.options.driver.find === undefined ? context.sandboxes.get(session.key) : undefined;
  if (current !== undefined && current.key !== request.key) {
    // The session's tool set changed (a new version): the old sandbox holds the old secrets.
    context.sandboxes.delete(session.key);
    await removePrevious(current.handle);
    current = undefined;
  }
  if (current === undefined && context.options.driver.find !== undefined) {
    // Another invocation of a stateless manager may have started it: it has its manifest already.
    const found = await context.options.driver.find(
      configFor(context, session, request),
      credential,
    );
    if (found !== undefined) {
      current = { key: request.key, handle: found };
    }
  }
  if (current === undefined) return;
  // A live host that lost its manifest answers 503 and must be replaced before token registration.
  const isServing =
    (await context.options.driver.isLive(current.handle)) &&
    (await probe(context, targetOf(context, current.handle, session.publicBase ?? '')));
  if (isServing) return current;
  context.sandboxes.delete(session.key);
  await removePrevious(current.handle);
  return undefined;
}

async function registerRunToken(
  context: SandboxContext,
  input: {
    session: OpenSession;
    request: ToolSandboxRequest;
    handle: RuntimeHandle;
    started: boolean;
  },
): Promise<void> {
  const { session, request, handle, started } = input;
  const credential = session.providerCredential;
  await withCompensation(
    () =>
      context.options.driver
        .writeFile(handle, TOKENS_FILE, JSON.stringify([request.run.token]), credential)
        .catch((error: unknown) => {
          throw unavailable('the run token could not be registered', error);
        }),
    async () => {
      if (!started) return;
      // Nothing records or reaches this sandbox yet: killing it now, not at its timeout, is the
      // only way its provider slot is freed.
      context.sandboxes.delete(session.key);
      await context.options.driver.destroy(handle, credential);
    },
  );
}

export async function openSandbox(
  context: SandboxContext,
  session: OpenSession,
  request: ToolSandboxRequest,
): Promise<string> {
  const credential = session.providerCredential;
  try {
    // Refuse what the provider cannot place (a declared domain on E2B) before it is called.
    context.options.driver.assertCreatable?.(configFor(context, session, request), credential);
  } catch (error) {
    throw unavailable('the tool sandbox could not be started', error);
  }
  let current = await reuseOrRemoveSandbox(context, session, request);
  let started = false;
  if (current === undefined) {
    // Whatever the provider still holds for this session key is an older tool set (or one
    // another invocation lost): it holds the old secrets, so it goes before the new one starts.
    await context.options.driver
      .destroyTagged?.({ ...sessionTags(session), awSessionKey: session.key }, credential)
      .catch((error: unknown) => {
        throw new ToolSandboxUnavailableError(
          "the session's previous tool sandbox could not be removed",
          { cause: error },
        );
      });
    current = {
      key: request.key,
      handle: await startSandbox(context, session, request),
      startedBy: `${session.workspaceId}/${request.run.runId}`,
    };
    started = true;
  }
  // Recorded, so a `close` on this invocation destroys it.
  context.sandboxes.set(session.key, current);
  const { handle } = current;
  await registerRunToken(context, { session, request, handle, started });
  return context.options.origin(handle, session.publicBase ?? '');
}
