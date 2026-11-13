import type { LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { nonBlank } from '../config.js';
import { settleAppConnector, type AppOidcClient, type RunningApp } from '../dev/app.js';
import {
  appBackendNotConfiguredNotice,
  ensureAppBackendClient,
  findAppBackendClient,
  mintAppBackendSecret,
  projectAgentIds,
  type AppBackendCredentials,
} from '../dev/app-backend.js';
import { devIssuerSubject, startDevIssuer, type DevIssuer } from '../dev/issuer.js';
import { type DevSync } from '../dev/sync.js';
import { type CliIo } from '../io.js';
import {
  oidcConfigurationMode,
  readLocalConsolePassword,
  withDevIssuer,
} from '../local-runtime/environment.js';

/** The line `aw dev` prints when the developer's own identity provider applies (DI2). */
const OWN_IDP_LINE =
  'oidc: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI are set: the local runtime signs in at your identity provider, and aw dev runs no development issuer\n';

/**
 * The app's client at the development issuer (DI5): its `client_id` is the app name, registered
 * with the redirect URI once the app's port is known. `undefined` without an issuer (DI11).
 */
export function appOidcClient(
  issuer: DevIssuer | undefined,
  appName: string,
): ((redirectUri: string) => AppOidcClient) | undefined {
  if (issuer === undefined) return undefined;
  return (redirectUri) => ({
    issuerUrl: issuer.url,
    clientId: appName,
    clientSecret: issuer.registerClient(appName, redirectUri),
  });
}

/**
 * ADR-0161 amendment DI10 (issue #2075): after the first sync, the app's `app-backend` client
 * binds the project's synced agents, created on the first `aw dev` (its secret minted then) or
 * re-bound when the set changed. Answers the pair to restart the app with, or `undefined` when the
 * app keeps the pair it was started with (or has none). A refusal is a notice: the app's sign-in
 * then says it is not configured, and never falls back to another credential.
 */
async function settleAppBackend(
  client: AgentWorkspaceClient,
  options: {
    readonly appName: string;
    readonly oidcAudience: string | undefined;
    readonly agentNames: readonly string[];
    readonly stderr: (text: string) => void;
    readonly signal: AbortSignal;
  },
): Promise<AppBackendCredentials | undefined> {
  const { appName, signal } = options;
  try {
    const ensured = await ensureAppBackendClient(client, {
      appName,
      oidcAudience: options.oidcAudience,
      agentIds: await projectAgentIds(client, options.agentNames, signal),
      existing: await findAppBackendClient(client, appName, signal),
      signal,
    });
    if (ensured.kind === 'not-configured') {
      options.stderr(appBackendNotConfiguredNotice(appName, ensured.reason));
      return undefined;
    }
    return ensured.kind === 'created'
      ? await mintAppBackendSecret(client, ensured.client.id, signal)
      : undefined;
  } catch (error) {
    if (!(error instanceof ApiProblemError)) throw error;
    options.stderr(
      `notice: app_backend_not_configured: the local runtime refused the ${appName} app’s app-backend client (${error.code}); the app’s sign-in is not configured.\n`,
    );
    return undefined;
  }
}

/** The pair of the app's existing `app-backend` client, minted for this process, or `undefined`. */
export async function existingAppBackend(
  client: AgentWorkspaceClient,
  appName: string,
  stderr: (text: string) => void,
  signal: AbortSignal,
): Promise<AppBackendCredentials | undefined> {
  try {
    const existing = await findAppBackendClient(client, appName, signal);
    return existing === undefined
      ? undefined
      : await mintAppBackendSecret(client, existing.id, signal);
  } catch (error) {
    if (!(error instanceof ApiProblemError)) throw error;
    stderr(
      `notice: app_backend_not_configured: the local runtime refused to mint the ${appName} app’s app-backend secret (${error.code}).\n`,
    );
    return undefined;
  }
}

/**
 * ADR-0161 amendment DI2: the development issuer runs only when no OIDC_* is set; with all four
 * set, one line says the developer's own identity provider applies.
 */
export async function oidcModeOf(io: CliIo, cwd: string): Promise<'dev-issuer' | 'own-idp'> {
  const mode = await oidcConfigurationMode(io.env, cwd);
  if (mode === 'own-idp') io.stderr(OWN_IDP_LINE);
  return mode;
}

/**
 * DI1: start the development issuer before the fork, because its URL is in `start`, and register
 * the console there (DI5); with the developer's own identity provider, nothing starts.
 */
export async function withIssuerStarted(
  mode: 'dev-issuer' | 'own-idp',
  start: LocalRuntimeStartMessage,
  identity: string,
  io: CliIo,
  cwd: string,
): Promise<{ readonly issuer: DevIssuer | undefined; readonly start: LocalRuntimeStartMessage }> {
  if (mode === 'own-idp') return { issuer: undefined, start };
  const issuer = await startDevIssuer({
    webPort: start.environment.port,
    defaultEmail: identity,
    readPassword: () => readLocalConsolePassword(io.env, cwd),
  });
  return { issuer, start: withDevIssuer(start, issuer, devIssuerSubject(identity)) };
}

/**
 * The `oidcAudience` of the app's `app-backend` client (DI10, DI11): the app name, its client id
 * at the development issuer, or `AW_OIDC_CLIENT_ID` with the developer's own identity provider.
 */
export function appAudience(
  issuer: DevIssuer | undefined,
  appName: string,
  env: CliIo['env'],
): string | undefined {
  return issuer === undefined ? nonBlank(env['AW_OIDC_CLIENT_ID']) : appName;
}

/**
 * The app's steps after the plan was applied: restart it with its connector id, run the first sync
 * (DI10's client binds the synced agents), then make its `app-backend` client and restart once
 * more with that pair, on the first `aw dev` only. Answers the running sync.
 */
export async function settleDevApp(options: {
  readonly client: AgentWorkspaceClient;
  readonly app: RunningApp;
  readonly appName: string;
  readonly beginSync: () => DevSync;
  readonly oidcAudience: string | undefined;
  readonly agentNames: readonly string[];
  readonly stderr: (text: string) => void;
  readonly signal: AbortSignal;
}): Promise<DevSync> {
  const { client, app, appName, signal } = options;
  await settleAppConnector(client, app, appName, signal);
  const sync = options.beginSync();
  await sync.firstSync;
  if (signal.aborted) return sync;
  const appBackend = await settleAppBackend(client, { ...options, signal });
  if (appBackend !== undefined) await settleAppConnector(client, app, appName, signal, appBackend);
  return sync;
}

/** Stop the development issuer, when one runs. */
export async function closeIssuer(issuer: DevIssuer | undefined): Promise<void> {
  if (issuer !== undefined) await issuer.close();
}
