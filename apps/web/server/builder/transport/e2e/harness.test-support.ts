import { createHarnessState } from './harness-state.test-support';
import { createHarnessAgents } from './harness-agents.test-support';
import { createHarnessRunApi } from './harness-run-api.test-support';
import { createHarnessFeatures } from './harness-features.test-support';
import { spyPorts, createHarnessCall } from './harness-call.test-support';
import { createHarnessLifecycle } from './harness-lifecycle.test-support';
import { createScriptedRunner } from './harness-replay.test-support';
import { recordingCeilingFor } from '../../../policy-ceiling/fixtures';
import { builderRunReader, productionBuilderPorts } from '../composition';
import { createBuilderCallerVerifier } from '../mcp';
import { createInMemoryConnectorsStoreProvider } from '../../../connectors/memory-store';
import { createInMemoryModelsStoreProvider } from '../../../models/store';
import { createInMemoryRuntimeProfileStoreProvider } from '../../../runtimes/memory-store';
import {
  WORKSPACE,
  BUILDER_AGENT,
  type Door,
  type BuilderDoorOptions,
} from './harness-contract.test-support';
import type { Transcript } from './harness-contract.test-support';
import { toolResults as collectToolResults } from './harness-scripts.test-support';

export {
  WORKSPACE,
  type Transcript,
  type Door,
  type BuilderDoorOptions,
} from './harness-contract.test-support';

export {
  scriptedModel,
  scriptedModelFile,
  approvedFor,
  type GatedTool,
  gatedInputs,
  toolUse,
} from './harness-scripts.test-support';

export function toolResults(transcript: Transcript): unknown[] {
  return collectToolResults(transcript);
}

export function builderDoor(options: BuilderDoorOptions): Door {
  const { scopes } = options;
  const state = createHarnessState(scopes, () => versions);
  const { tokens, database, directory, journal, responses, responseHeaders, portCalls } = state;
  const agentStores = createHarnessAgents();
  const { agents, versions } = agentStores;
  const run = createHarnessRunApi(options);
  const { runStore, runApi } = run;
  const ports = productionBuilderPorts({
    agents,
    deploymentPolicy: options.ceiling ?? null,
    versions: {
      versions,
      ceiling:
        options.ceiling == null
          ? { kind: 'disabled' }
          : { kind: 'enforced', ceilingFor: recordingCeilingFor(options.ceiling).ceilingFor },
      toolHost: false,
      toolDomainsRefusal: null,
    },
    connectors: options.connectors ?? createInMemoryConnectorsStoreProvider(),
    models: createInMemoryModelsStoreProvider([WORKSPACE]),
    runtimeProfiles: createInMemoryRuntimeProfileStoreProvider(),
    skills: () => Promise.resolve({ status: 200, body: { skills: [] } }),
    storageConnections: () => null,
    toolBundles: () => null,
    journal: { repositories: database.builderToolCalls, scopes },
    directory,
    approvals: {
      scopes,
      runs: {
        forScope: () => ({ get: (id: string) => runStore?.get(id) ?? Promise.resolve(null) }),
      },
    },
    runApi: () => runApi,
  });
  const readRun = builderRunReader(database);
  const workspaceFeatures = createHarnessFeatures(scopes);
  const deps = {
    verifyCaller: createBuilderCallerVerifier({
      tokens,
      database,
      directory,
      agents: {
        forWorkspace: () => ({
          get: async (id: string) =>
            id !== BUILDER_AGENT
              ? await agents.forWorkspace(WORKSPACE).get(id)
              : {
                  ownerPrincipalId: 'principal-owner',
                  ...(options.runAgent ?? { name: 'builder', builtin: 'builder' as const }),
                },
        }),
      },
      ceiling: options.ceiling ?? null,
    }),
    ports: spyPorts({ ...ports, ...options.override }, portCalls),
    readRun: (run: Parameters<ReturnType<typeof builderRunReader>>[0]) => {
      portCalls.push('readRun');
      return readRun(run);
    },
  };
  const call = createHarnessCall(deps, responses, responseHeaders);
  const lifecycle = createHarnessLifecycle({ ...state, ...agentStores, ...run, ports });

  return {
    ports: deps.ports,
    journal,
    versions,
    workspaceFeatures,
    launched: run.launched,
    get auditEvents() {
      return versions.audits();
    },
    responses,
    responseHeaders,
    portCalls,
    end: lifecycle.end,
    revoke: lifecycle.revoke,
    decide: lifecycle.decide,
    seedAgent: lifecycle.seedAgent,
    agent: lifecycle.agent,
    start: lifecycle.start,
    call,
    runScripted: createScriptedRunner({ tokens, call, requireRunApi: run.requireRunApi }),
  };
}
