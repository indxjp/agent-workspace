import type { SecretsService } from '@agent-workspace/core/secrets';
import type { FeatureId } from '@indx-workspace/contracts/features';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { installApplicationContext } from '../application-context';
import { createRepositoryRuntimeProfileStoreProvider } from '../runtimes/store';
import type { WebSettings } from '../settings';
import { log } from '../telemetry/logger';
import { clearFeatureSwitches, configureFeatureSwitches } from '../features/wiring';
import {
  builderProvisioner,
  provisioningAfterConnectionWrites,
  provisioningAfterSetup,
} from './builder-provisioning';
import { configuredPath } from './config';
import { workspaceFeaturesRuntime, workspaceFeatureSwitches } from './feature-switches';
import { wireAgents } from './wiring/agents';
import { wireBuilder } from './wiring/builder';
import { wireProjects, wireShares } from './wiring/projects';
import { RUN_DOMAINS_DISABLED, wireRunDomains } from './wiring/run-api';
import { wireRunResources } from './wiring/run-resources';
import { wireRunRuntime } from './wiring/run-runtime';
import { wireSubsystems } from './wiring/subsystems';
import { wireAgentTeams } from './wiring/agent-teams';
import { wireDemoOperator } from './wiring/demo-operator';
import { demoRuntimeDriverOf, demoSkillsOf, wireEmailLink } from './wiring/email-link';
import { wireStore } from './wiring/store';
import { wireWebhooks } from './wiring/webhooks';

/** The opened database root, typed by what the agent wiring takes so this file names no persistence package. */
type DatabaseRoot = Parameters<typeof wireAgents>[0]['root'];

/** Everything `registerOpenedDatabase` needs once the database root is open. */
interface OpenedDatabaseInput {
  readonly root: DatabaseRoot;
  readonly sessionSecret: string;
  readonly policyCeiling: ProjectPolicy | null;
  readonly deploymentFeatures: readonly FeatureId[];
  readonly settings: WebSettings;
  readonly captureSecretsService: (service: SecretsService | null) => void;
  readonly stopOnClose: (stop: () => void) => void;
}

type Wired = Awaited<ReturnType<typeof wireOpenedDatabase>>;
type Builders = ReturnType<typeof builderProvisioner>;

/** Wire the agent, subsystem and run-resource layers into the one record the later wirers read. */
async function wireOpenedDatabase(input: OpenedDatabaseInput) {
  const { root, sessionSecret, policyCeiling, captureSecretsService, stopOnClose } = input;
  const agentWiring = await wireAgents({ root, sessionSecret, policyCeiling });
  const subsystems = await wireSubsystems({
    ...agentWiring,
    root,
    policyCeiling,
    captureSecretsService,
    stopOnClose,
  });
  return {
    ...agentWiring,
    ...subsystems,
    ...wireRunResources({ ...agentWiring, ...subsystems, root }),
    root,
    policyCeiling,
    stopOnClose,
  };
}

/** The domains the demo templates and the email-link sign-in seed their workspaces through. */
function demoDomainsOf(wired: Wired) {
  const { root } = wired;
  return {
    agents: wired.agentsRuntime.agents,
    agentResources: wired.agentsRuntime.agentResources,
    agentGrants: wired.agentsRuntime.agentGrants,
    connectors: wired.connectors.kind === 'serving' ? wired.connectors.runtime.connectors : null,
    files: wired.files.kind === 'serving' ? wired.files.runtime : {},
    models: wired.modelsApi?.models ?? null,
    runtimeProfiles: createRepositoryRuntimeProfileStoreProvider({
      repositories: root.runtimeProfiles,
      scopes: root.scopes,
    }),
    runtimeDriver: demoRuntimeDriverOf({
      runnerManager: wired.runnerManager !== null,
      env: process.env,
    }),
    skills: demoSkillsOf(wired.skills),
  };
}

/** The demo, email-link and store seams, which share one client identity. */
function wireSignInSurfaces(input: OpenedDatabaseInput, wired: Wired) {
  const { root, sessionSecret, settings } = input;
  const directory = wired.principalIdentity.rbac.directory;
  const demoDomains = demoDomainsOf(wired);
  const clientIdentity = { trustedProxyHops: settings.trustedProxyHops, sessionSecret };
  return {
    emailLink: wireEmailLink({ root, directory, domains: demoDomains, settings, clientIdentity }),
    demoOperator: wireDemoOperator({
      settings,
      templates: {
        scopes: root.scopes,
        directory,
        domains: demoDomains,
        settings,
        workspaces: root,
      },
      maintenance: { root, settings },
    }),
    store: wireStore({ root, settings, clientIdentity }),
  };
}

/** Every application-context seam that does not need the run runtime. */
function contextWithoutRunRuntime(input: OpenedDatabaseInput, wired: Wired, builders: Builders) {
  const { root, deploymentFeatures, stopOnClose } = input;
  const { principalIdentity } = wired;
  return {
    // ADR-0104 acceptance (issues #1516, #1517): the team routes need the database, and the
    // member endpoint the lead run's token and the directory its caller is read from.
    agentTeams: wireAgentTeams(root, {
      tokenSecret: configuredPath('GATEWAY_TOKEN_SECRET'),
      directory: principalIdentity.rbac.directory,
    }),
    agents: { ...wired.agentsRuntime, runtimeSwitchAudit: wired.runtimeSwitchAudit },
    agentVersions: wired.agentVersions,
    audit: wired.audit,
    builder: wireBuilder({
      ...wired,
      tokenSecret: configuredPath('GATEWAY_TOKEN_SECRET'),
      directory: principalIdentity.rbac.directory,
    }),
    cliAuth: principalIdentity.cliAuth,
    connectors: wired.connectors,
    ...wireSignInSurfaces(input, wired),
    endpointClients: wired.endpointClients,
    files: wired.files,
    invitations: principalIdentity.invitations,
    models: provisioningAfterConnectionWrites(wired.models, builders),
    oauth: wired.oauth,
    projects: wireProjects(wired),
    rbac: principalIdentity.rbac,
    runtimes: wired.runtimes,
    secrets: wired.secrets,
    sessions: wired.sessions,
    setup: provisioningAfterSetup(wired.setup, builders),
    skills: wired.skills,
    storageConnections: wired.storageConnections,
    workspaceFeatures: workspaceFeaturesRuntime(root, deploymentFeatures, (id) =>
      builders.provision(id),
    ),
    workspaces: principalIdentity.workspaces,
    shares: wireShares(wired),
    // N-3 (ADR-SDK-18-N3-250): the registry needs no run runtime; its worker sends what stopped
    // runs wrote, and stops on close like the stale-run sweep.
    webhooks: wireWebhooks(root, wired.secretsService, { log, stopOnClose }),
  };
}

/**
 * Wire every seam on an open database root and install the application context. Throws on an
 * unexpected installer failure; the caller closes what was opened.
 */
export async function registerOpenedDatabase(input: OpenedDatabaseInput): Promise<void> {
  const { root, deploymentFeatures, settings, stopOnClose } = input;
  const wired = await wireOpenedDatabase(input);
  const featureSwitches = workspaceFeatureSwitches(root, deploymentFeatures);
  const builders = builderProvisioner({
    root,
    agents: wired.agents,
    agentVersions: wired.agentVersions,
    switches: featureSwitches,
  });
  const context = contextWithoutRunRuntime(input, wired, builders);
  // The run API, the A2A and tool endpoints, `POST /api/tokens`, the triggers and the public
  // surfaces need the run runtime; with none they are disabled (503). One install, after
  // everything is built, so no route ever reads a half-composed context.
  const runRuntime = await wireRunRuntime(wired);
  configureFeatureSwitches(featureSwitches);
  stopOnClose(clearFeatureSwitches);
  installApplicationContext({
    ...context,
    ...(runRuntime === null
      ? RUN_DOMAINS_DISABLED
      : wireRunDomains({ ...wired, ...runRuntime, demo: settings.demo })),
  });
  log.info('[compose] project, session and sharing APIs installed');
  // After the install, so the Builder's writes see the composed context; a failure only warns.
  await builders.provisionAll();
}
