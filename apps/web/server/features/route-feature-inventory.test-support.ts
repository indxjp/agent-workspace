/**
 * The workspace the route inventory (`route-feature-inventory.test.ts`) drives its routes against:
 * an owner, an empty deployment, and one fixture per credential a door takes (trigger secret, API
 * key, OAuth token, run token). Nothing here knows which feature is switched off.
 */
import { createHash } from 'node:crypto';

import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import type { TriggerRecord, TriggerRepository } from '@agent-workspace/core/db';
import { createRunTokenCodec, type RunTokenCodec } from '@agent-workspace/gateway/tokens';
import { vi } from 'vitest';

import { applicationContext } from '../application-context';
import { installTestDomains, installTestRunApi } from '../application-context-fixtures';
import { createBuilderCallerVerifier } from '../builder/transport/mcp';
import type { EndpointClientsRuntime } from '../endpoint-clients/wiring';
import { installEmptyDeployment } from '../empty-deployment-fixture';
import type { RunTokenDatabase } from '../gateway/run-token-verifier';
import { mintClientSecret } from '../oauth/tokens';
import { Principal } from '../rbac/principal';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import type { RunPrincipal } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { ToolEndpointEnvironment } from '../tool-endpoint/env';
import type { TriggersRuntime } from '../triggers/wiring';

export const ORIGIN = 'https://control-plane.test';
export const OWNER = { email: 'owner@features.test' };
export const UUID = '00000000-0000-4000-8000-000000000000';

const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RUN_TOKEN_SECRET = 'inventory-run-token-signing-secret-at-least-thirty-two-bytes';
const RUN = 'run-1';
const SESSION = 'session-1';
const AGENT = 'agent-1';
const OWNER_PRINCIPAL_ID = 'principal-owner';
const BUILDER_EXTERNAL_PATH = '/mcp/builder';
const FIXTURE_NOW_MS = 1_000;

/** What the routes' doors need from the installed workspace. */
export interface InventoryWorkspace {
  readonly teardown: () => void;
  readonly runToken: string;
  readonly triggerSecret: string;
}

function ownerPrincipal(): RunPrincipal {
  return {
    principalId: OWNER_PRINCIPAL_ID,
    ownerPrincipalId: OWNER_PRINCIPAL_ID,
    userId: null,
    workspaceId: TEST_WORKSPACE_ID,
    role: 'owner',
    scope: null,
  };
}

function installRunApi(principal: RunPrincipal): void {
  installTestRunApi({
    authenticate: () => Promise.resolve(principal),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(false),
    store: new InMemoryRunStore(),
    launch: () => undefined,
    recordRunFeedback: () => Promise.resolve(),
    listAgentFeedback: () => Promise.resolve([]),
  });
}

function webhookTrigger(): TriggerRecord {
  return {
    id: UUID,
    workspaceId: TEST_WORKSPACE_ID,
    agentId: UUID,
    name: 'inbox',
    kind: 'webhook',
    promptTemplate: 'Handle this: {{body}}',
    cron: null,
    timezone: null,
    enabled: true,
    outputSchema: null,
    subject: null,
    ownerPrincipalId: OWNER_PRINCIPAL_ID,
    hasSecret: true,
    lastFiredAt: null,
    scheduleFrom: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function emptyTriggerRepository(): TriggerRepository {
  return {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    create: () => Promise.resolve({ kind: 'agent-not-found' }),
    update: () => Promise.resolve({ kind: 'not-found' }),
    setSecretHash: () => Promise.resolve({ kind: 'not-found' }),
    countDeliveriesSince: () => Promise.resolve(0),
    countUnfinishedRuns: () => Promise.resolve(0),
    markFired: () => Promise.resolve(false),
    remove: () => Promise.resolve(false),
    claimDelivery: () => Promise.resolve({ kind: 'claimed' }),
    recordDeliveryRun: () => Promise.resolve(false),
    releaseDelivery: () => Promise.resolve(false),
    pruneDeliveries: () => Promise.resolve(0),
  };
}

function installTriggers(secretHash: string): void {
  const repository = emptyTriggerRepository();
  const trigger = webhookTrigger();
  const triggers: TriggersRuntime = {
    repository: () => Promise.resolve(repository),
    findForIngress: () => Promise.resolve({ trigger, secretHash }),
    owner: () => Promise.resolve(null),
    agentOwnership: () => Promise.resolve('unknown'),
    zoomTokens: null,
    now: () => new Date(0),
  };
  installTestDomains({ triggers: { kind: 'serving', runtime: triggers } });
}

function installToolEndpoint(principal: RunPrincipal): void {
  const toolEndpoint: ToolEndpointEnvironment = {
    identify: () =>
      Promise.resolve({
        principal: { ...principal, role: 'builder', scope: { kind: 'mcp-project', id: CLIENT } },
        via: 'api-key',
        apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        label: 'inventory key',
        oauth: null,
      }),
    agentOwnership: () => Promise.resolve('unknown'),
    productionToolBundles: () => Promise.resolve([]),
    route: () => Promise.reject(new Error('no sandbox is opened')),
    closeSandbox: () => Promise.resolve(),
    fetch: () => Promise.reject(new Error('nothing is fetched')),
    now: () => Date.now(),
  };
  const endpointClients: Partial<EndpointClientsRuntime> = { get: () => Promise.resolve(null) };
  installTestDomains({
    toolEndpoint: { kind: 'serving', environment: toolEndpoint },
    endpointClients: endpointClients as EndpointClientsRuntime,
  });
}

/** Members keep their own identity, except that `/mcp/builder` takes them as an OAuth client. */
function installOAuthBuilderRbac(): void {
  const context = applicationContext();
  if (context === null) throw new Error('the application context is not installed');
  const memberRbac = context.rbac;
  installTestDomains({
    rbac: {
      directory: memberRbac.directory,
      identify: async (request) => {
        const member = await memberRbac.identify(request);
        if (member === null || new URL(request.url).pathname !== BUILDER_EXTERNAL_PATH) {
          return member;
        }
        return Principal.fromOAuthToken(
          member,
          { kind: 'builder', id: CLIENT },
          { clientId: CLIENT, audience: `${ORIGIN}${BUILDER_EXTERNAL_PATH}` },
        );
      },
    },
  });
}

function runTokenDatabase(tokenId: string, tokenHash: string): RunTokenDatabase<WorkspaceScope> {
  return {
    scopes: createInMemoryWorkspaceScopeResolver([{ id: TEST_WORKSPACE_ID, slug: 'inventory' }]),
    runTokens: {
      forScope: () => ({
        isActive: (id, runId, presentedHash) =>
          Promise.resolve(id === tokenId && runId === RUN && presentedHash === tokenHash),
      }),
    },
    runs: {
      forScope: () => ({
        get: () =>
          Promise.resolve({
            sessionId: SESSION,
            workspaceId: TEST_WORKSPACE_ID,
            agentId: AGENT,
            status: 'running' as const,
          }),
      }),
    },
  };
}

async function issueRunToken(tokens: RunTokenCodec): Promise<string> {
  return tokens.issue({
    runId: RUN,
    sessionId: SESSION,
    workspaceId: TEST_WORKSPACE_ID,
    agentId: AGENT,
    modelConnectionId: 'connection-1',
  });
}

async function installBuilder(harness: RbacHarness): Promise<string> {
  const tokens = createRunTokenCodec({ secret: RUN_TOKEN_SECRET, now: () => FIXTURE_NOW_MS });
  const runToken = await issueRunToken(tokens);
  const verified = await tokens.verify(runToken);
  if (!verified.ok) throw new Error('the fixture run token did not verify');
  const tokenHash = createHash('sha256').update(runToken).digest('hex');
  installTestDomains({
    builder: {
      verifyCaller: createBuilderCallerVerifier({
        tokens,
        database: runTokenDatabase(verified.claims.tokenId, tokenHash),
        directory: harness.directory,
        agents: {
          forWorkspace: () => ({
            get: () =>
              Promise.resolve({
                name: 'Builder',
                ownerPrincipalId: OWNER_PRINCIPAL_ID,
                builtin: 'builder',
              }),
          }),
        },
        ceiling: null,
      }),
      ports: null,
      readRun: () => Promise.resolve(null),
    },
  });
  return runToken;
}

/** Installs the workspace and every door's fixture; the feature switches are left to the caller. */
export async function installInventoryWorkspace(): Promise<InventoryWorkspace> {
  vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
  const harness = installRbacHarness([
    { email: OWNER.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
  ]);
  installEmptyDeployment();
  const minted = await mintClientSecret();
  const principal = ownerPrincipal();
  installRunApi(principal);
  installTriggers(minted.secretHash);
  installToolEndpoint(principal);
  installOAuthBuilderRbac();
  const runToken = await installBuilder(harness);
  return {
    teardown: () => harness.teardown(),
    runToken,
    triggerSecret: minted.presented,
  };
}
