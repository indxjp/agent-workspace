import { setTimeout as delay } from 'node:timers/promises';

import type {
  CliTokenResponse,
  DeviceAuthorizationResponse,
} from '@indx-workspace/contracts/cli-auth';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';

import { command, credentialFreeCommand, type Command, type CommandContext } from '../command.js';
import {
  readStoredCredential,
  removeStoredCredential,
  saveStoredCredential,
} from '../credentials.js';
import { CommandRefusedError } from '../io.js';

/** RFC 8628 §3.5: on `slow_down`, add five seconds to the interval for every later poll. */
const SLOW_DOWN_STEP_SECONDS = 5;

function sleep(context: CommandContext, seconds: number): Promise<void> {
  return context.io.sleep === undefined
    ? delay(seconds * 1000, undefined, { signal: context.signal })
    : context.io.sleep(seconds * 1000, context.signal);
}

function verificationLink(baseUrl: string, start: DeviceAuthorizationResponse): string {
  return `${baseUrl.replace(/\/+$/u, '')}${start.verificationPath}?code=${encodeURIComponent(start.userCode)}`;
}

/**
 * Poll until the person answers or the device code expires. The loop is bounded by the number of
 * intervals that fit in the code's lifetime, not by a clock, so it ends even if the server never
 * stops answering `authorization_pending`.
 */
async function pollUntilIssued(
  context: CommandContext,
  start: DeviceAuthorizationResponse,
): Promise<CliTokenResponse> {
  let intervalSeconds = start.intervalSeconds;
  const attempts = Math.ceil(start.expiresInSeconds / start.intervalSeconds) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(context, intervalSeconds);
    try {
      return await context.client.auth.pollToken(start.deviceCode, { signal: context.signal });
    } catch (error) {
      if (!(error instanceof ApiProblemError)) throw error;
      if (error.code === 'slow_down') intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      else if (error.code !== 'authorization_pending') throw error;
    }
  }
  return context.client.auth.pollToken(start.deviceCode, { signal: context.signal });
}

/**
 * Issue #242 (SDK-10, S-22) — `aw login`, `aw logout`, `aw whoami`. ADR-0083.
 *
 * `login` runs an OAuth 2.0 device authorization grant (RFC 8628): it prints a link and a code on
 * stderr, the person approves the code in a browser where they are signed in, and the CLI stores
 * the short-lived token it receives in `~/.config/agent-workspace/credentials.json` (owner-only).
 * The token is never printed — not on stdout, not on stderr, not under `--json` — and is never
 * accepted from a flag. `logout` revokes it on the server and then forgets it.
 */
export const authCommands: readonly Command[] = [
  credentialFreeCommand(
    'login',
    '',
    'Sign in as yourself through a browser; stores a short-lived token',
    async (context) => {
      // The device flow waits up to the code's lifetime for a person at a browser.
      if (!context.io.isTty) {
        throw new CommandRefusedError(
          'aw login needs a person at a terminal and a browser',
          'set AGENT_WORKSPACE_API_KEY (aw login needs a person at a browser)',
        );
      }
      const start = await context.client.auth.startDevice({ signal: context.signal });
      context.io.stderr(
        `To sign in, open ${verificationLink(context.baseUrl, start)}\n` +
          `and approve the code ${start.userCode}. Waiting…\n`,
      );
      const issued = await pollUntilIssued(context, start);
      await saveStoredCredential(context.io.homeDir, context.baseUrl, {
        token: issued.token,
        expiresAt: issued.expiresAt,
        workspaceId: issued.workspace.id,
        workspaceSlug: issued.workspace.slug,
      });
      return { value: { workspace: issued.workspace, expiresAt: issued.expiresAt } };
    },
  ),
  credentialFreeCommand(
    'logout',
    '',
    'Revoke the stored sign-in on the server and forget it',
    async (context) => {
      const stored = await readStoredCredential(context.io.homeDir, context.baseUrl);
      let revoked = false;
      if (stored !== null) {
        const client = createClient({
          baseUrl: context.baseUrl,
          auth: { kind: 'user-token', token: stored.token },
          fetch: context.io.fetch,
        });
        try {
          await client.auth.revoke({ signal: context.signal });
          revoked = true;
        } catch (error) {
          // Already revoked or expired on the server: forgetting it locally is still right.
          if (!(error instanceof ApiProblemError && error.status === 401)) throw error;
        }
      }
      const forgotten = await removeStoredCredential(context.io.homeDir, context.baseUrl);
      return { value: { signedOut: forgotten, revoked } };
    },
  ),
  command(
    'whoami',
    '',
    'Who the current credential is (the same answer as `aw me`)',
    async ({ client, signal }) => ({ value: await client.me({ signal }) }),
  ),
];
