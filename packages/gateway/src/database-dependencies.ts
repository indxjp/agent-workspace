import { openDatabaseRoot } from '@agent-workspace/core/db';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import type { createJsonLogger } from '@agent-workspace/core/telemetry';

import type { GatewayApplicationDependencies } from './application-dependencies.js';
import { createDailyCostAdmission } from './daily-cost.js';
import {
  createDatabaseDailyCostLedger,
  createDatabaseGatewayRunResolver,
  createDatabaseUsageRecorder,
} from './database.js';
import { createGoogleIdTokenSource } from './providers/google-id-token.js';
import { createScriptedModels } from './providers/registry.js';
import { createRunCeilingAdmission } from './run-ceiling.js';
import { requestLogger } from './server.js';
import type { GatewaySettings } from './settings.js';
import { createDatabaseAwControlResolver } from './tools/aw-control.js';
import { createDatabaseToolResolver } from './tools/authorize.js';
import { createPostgresExecutor, type PostgresToolExecutor } from './tools/postgres.js';
import { createDatabaseToolSandboxResolver } from './tools/sandbox.js';
import type { TokenSource } from './types.js';
import { loggedFetch } from './upstream-log.js';

type Logger = ReturnType<typeof createJsonLogger>;
type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

type GatewayStores = {
  readonly database: Awaited<ReturnType<typeof openDatabaseRoot>>;
  readonly secrets: SecretsService;
  readonly postgres: PostgresToolExecutor;
};

/** Opens the database and the secrets service; the database is closed again if the secrets fail. */
export async function openGatewayStores(env: EnvironmentRecord): Promise<GatewayStores> {
  const database = await openDatabaseRoot(env);
  let secrets: SecretsService;
  try {
    secrets = await createSecretsService(env);
  } catch (error) {
    await database.close();
    throw error;
  }
  return { database, secrets, postgres: createPostgresExecutor() };
}

type DatabaseDependenciesInput = GatewayStores & {
  readonly settings: GatewaySettings;
  readonly tokens: TokenSource | undefined;
  readonly log: Logger;
};

/** The application's dependencies, every resolver and recorder backed by the opened stores. */
export function createDatabaseApplicationDependencies(
  input: DatabaseDependenciesInput,
): GatewayApplicationDependencies {
  const { settings, tokens, log, database, secrets, postgres } = input;
  const { toolSandboxAuth, controlPlaneOrigin, runnerManagerToken, vertexProjectId } = settings;
  const scripted =
    settings.scriptedModelsDir === undefined
      ? null
      : createScriptedModels({ dir: settings.scriptedModelsDir });
  const ledger = createDatabaseDailyCostLedger(database);
  return {
    ...(toolSandboxAuth === undefined ? {} : { toolSandboxIdToken: createGoogleIdTokenSource() }),
    ...(runnerManagerToken === undefined ? {} : { runnerManagerToken }),
    ...(controlPlaneOrigin === undefined ? {} : { controlPlaneOrigin }),
    resolver: createDatabaseGatewayRunResolver(
      database,
      secrets,
      tokens === undefined || vertexProjectId === undefined
        ? undefined
        : { tokens, projectId: vertexProjectId },
    ),
    providers: { fetch: loggedFetch(log), scripted },
    tools: createDatabaseToolResolver(database, secrets),
    toolSandbox: createDatabaseToolSandboxResolver(database),
    awControl: createDatabaseAwControlResolver(database),
    postgres,
    tokenSecret: settings.tokenSecret,
    usage: createDatabaseUsageRecorder(database, settings.pricing),
    runCeiling: createRunCeilingAdmission(ledger, {
      onError(error, context) {
        log.error('run spend ceiling admission failed', { error, ...context });
      },
    }),
    dailyCost: createDailyCostAdmission(ledger, {
      now: () => new Date(),
      onError(error, context) {
        log.error('daily cost admission failed', { error, ...context });
      },
    }),
    onUsageError(error, request) {
      requestLogger(log, request).error('usage settlement failed', { error });
    },
  };
}
