import { createHash, randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { withCleanup } from '@agent-workspace/core';
import { type RuntimeConfig } from '@agent-workspace/runtime/driver';
import {
  assertSomePolicyDeclared,
  body,
  configFor,
  json,
  providerCredentialOf,
  waitUntilInvocable,
} from './manager-support.js';
import type { ManagerContext } from './manager-context.js';

export async function verifyRuntime(
  context: ManagerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { options, expectedDriver, runtimeRequestUrl, readinessPath, authHeaders, doFetch } =
    context;
  assertSomePolicyDeclared(options.driver, expectedDriver);
  const config = configFor(await body(req), options.workspacesRoot, expectedDriver);
  const fingerprint = runtimeVerificationFingerprint(
    config,
    options.configurationFingerprint ?? 'unspecified',
  );
  const credential = providerCredentialOf(req);
  const handle = await options.driver.create(config, credential);
  const nonce = randomUUID();
  await withCleanup(
    async () => {
      await waitUntilInvocable(
        handle,
        (h) => options.driver.isLive(h),
        runtimeRequestUrl,
        readinessPath,
        authHeaders,
        doFetch,
        options.verificationTimeoutMs ?? 30_000,
      );
      const echoed = await doFetch(runtimeRequestUrl(handle, '/verify/echo'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders(handle)) },
        body: JSON.stringify({ nonce }),
        redirect: 'error',
      });
      const value = (await echoed.json()) as { nonce?: unknown };
      if (!echoed.ok || value.nonce !== nonce) throw new Error('runtime echo verification failed');
      json(res, 200, {
        fingerprint,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      });
    },
    () => options.driver.destroy(handle, credential),
  );
}

function runtimeVerificationFingerprint(
  config: RuntimeConfig,
  configurationFingerprint = 'unspecified',
): string {
  // Session/workspace identifiers prove isolation during the live probe but must not make the
  // verification identity random. The release decision is tied to enforceable policy plus the
  // exact image/driver configuration.
  return createHash('sha256')
    .update(JSON.stringify({ configurationFingerprint, runSpec: config.runSpec }))
    .digest('hex');
}
