/**
 * Test support for {@link ApplicationContext}: a route test wires only the domains it exercises.
 * No route imports it.
 */
import type { AgentVersionsRuntime } from './agent-versions/runtime';
import { createInMemoryAgentStoreProvider } from './agents/memory-store';
import type { AgentsRuntime } from './agents/runtime';
import {
  applicationContext,
  installApplicationContext,
  type ApplicationContext,
} from './application-context';
import type { RunApiEnvironment } from './runs/environment';
import type { SessionApiEnvironment } from './sessions/environment';
import { InMemorySessionStateStore } from './sessions/state-memory-store';

function unwired<K extends keyof ApplicationContext>(domain: K): ApplicationContext[K] {
  return new Proxy({} as ApplicationContext[K], {
    get() {
      throw new Error(`The ${domain} domain is not wired in this test.`);
    },
  });
}

/**
 * The domains a test wires. `agents` defaults its ceiling to `disabled` and its runtime-switch audit
 * sink to `null` (no `AW_DEPLOYMENT_POLICY`, no runtimes API); a test of either passes it.
 * `agentVersions` needs only its store: the rest defaults to a deployment
 * with no ceiling and no tool host, which is what most route tests exercise. `sessions` needs only
 * its authenticator, access check and transcript store: the rest defaults to an empty state store,
 * no session rows (every workspace lookup misses), no granted files and the interval retention
 * driver. `skills` defaults to `unavailable`, not a throwing proxy: the agent-version and tool-bundle
 * paths read it best-effort, and a deployment without skills storage is what those tests exercise.
 * `files` defaults to `unavailable` for the same reason: session retention purges attachments and
 * the ownership resolvers read the catalogue best-effort. `surfaces` defaults to `disabled`: the
 * proxy's CORS answer and the run API's visitor limits read it on every request, best-effort.
 * `runs` defaults to `disabled`: the shell page and the A2A card read it best-effort, and a
 * deployment with no run runtime answers `503 run_api_not_configured`.
 * `rbac` has no quiet default: every authorisation decision reads it, so a test that reaches the
 * gate without wiring it throws rather than passing on a silent `503`.
 */
type TestDomains = Partial<Omit<ApplicationContext, 'agents' | 'agentVersions' | 'sessions'>> & {
  readonly agents?: Omit<AgentsRuntime, 'ceiling' | 'runtimeSwitchAudit'> & Partial<AgentsRuntime>;
  readonly agentVersions?: Pick<AgentVersionsRuntime, 'versions'> & Partial<AgentVersionsRuntime>;
  readonly sessions?: Pick<SessionApiEnvironment, 'authenticate' | 'canAccessSession' | 'store'> &
    Partial<SessionApiEnvironment>;
};

/**
 * Install `domains` over the context already installed, so two calls wire two domains the way the
 * per-domain slots used to. A domain nobody wired throws on first use.
 */
export function installTestDomains({
  agents,
  agentVersions,
  sessions,
  ...domains
}: TestDomains): void {
  const base = applicationContext() ?? {
    a2a: unwired('a2a'),
    agents: unwired('agents'),
    agentVersions: unwired('agentVersions'),
    audit: unwired('audit'),
    builder: {
      verifyCaller: () => Promise.resolve({ ok: false, code: 'not_permitted', reads: false }),
      ports: null,
      readRun: () => Promise.resolve(null),
    },
    cliAuth: unwired('cliAuth'),
    connectors: unwired('connectors'),
    endpointClients: unwired('endpointClients'),
    files: { kind: 'unavailable' },
    invitations: unwired('invitations'),
    models: unwired('models'),
    oauth: unwired('oauth'),
    projects: unwired('projects'),
    rbac: unwired('rbac'),
    runs: { kind: 'disabled' },
    runtimes: unwired('runtimes'),
    secrets: unwired('secrets'),
    sessions: unwired('sessions'),
    setup: unwired('setup'),
    shares: unwired('shares'),
    skills: { kind: 'unavailable' },
    storageConnections: { kind: 'unavailable' },
    surfaces: { kind: 'disabled' },
    tokens: unwired('tokens'),
    toolEndpoint: unwired('toolEndpoint'),
    triggers: unwired('triggers'),
    workspaceFeatures: unwired('workspaceFeatures'),
    workspaces: unwired('workspaces'),
  };
  installApplicationContext({
    ...base,
    ...domains,
    ...(agents === undefined
      ? {}
      : { agents: { ceiling: { kind: 'disabled' }, runtimeSwitchAudit: null, ...agents } }),
    ...(agentVersions === undefined
      ? {}
      : {
          agentVersions: {
            ceiling: { kind: 'disabled' },
            toolHost: false,
            toolDomainsRefusal: null,
            ...agentVersions,
          },
        }),
    ...(sessions === undefined
      ? {}
      : {
          sessions: {
            stateStore: new InMemorySessionStateStore(),
            sessions: { forWorkspaceId: () => Promise.resolve(null) },
            runFileGrants: () => Promise.resolve([]),
            retention: { kind: 'interval' },
            ...sessions,
          },
        }),
  });
}

/**
 * Serve `environment` as the run API over whatever context is installed. With none installed it also
 * wires an agents runtime that reads every agent as absent: a run route's ownership check then
 * answers `unknown`, as it did while the run API had its own slot and no agents runtime was wired.
 */
export function installTestRunApi(environment: RunApiEnvironment): void {
  installTestDomains({
    ...(applicationContext() === null ? { agents: noAgents() } : {}),
    runs: { kind: 'serving', environment },
  });
}

function noAgents(): NonNullable<TestDomains['agents']> {
  return {
    resolveWorkspace: () =>
      Promise.reject(new Error('The agents domain is not wired in this test.')),
    agents: createInMemoryAgentStoreProvider(),
  };
}

/**
 * Take the run API back out, as the per-domain slot's reset did: the rest of an installed context
 * stays, and with none installed nothing is installed.
 */
export function resetTestRunApi(): void {
  const context = applicationContext();
  if (context !== null) installApplicationContext({ ...context, runs: { kind: 'disabled' } });
}
