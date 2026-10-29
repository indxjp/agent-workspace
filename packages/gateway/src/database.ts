import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

import type {
  GatewayRunResolver,
  GatewayUsageRecord,
  RunResolution,
  UsageRecorder,
} from './auth.js';
import type { DailyCostLedger } from './daily-cost.js';
import { calculateUsageCost, priceFor, type ModelPrice, type PricingCatalog } from './pricing.js';
import { registryProviderId } from './providers/registry.js';

/** Bind normalized gateway usage to the tenant-scoped, idempotent run repository. */
export function createDatabaseUsageRecorder(
  database: DatabaseRoot,
  pricing: PricingCatalog,
): UsageRecorder {
  // Best-effort: only takes effect while the run is still `pending` (see
  // `RunRepository.markAccountingFailed`), so it can never clobber usage a successful `record`
  // already settled. Failures here are swallowed — the caller's own error is what must propagate
  // to `onUsageError`, and a broken failure-mark must not mask it.
  const markFailed = async (runId: string, reason: string): Promise<void> => {
    try {
      const workspaceId = await database.findRunWorkspace(runId);
      if (workspaceId === null) return;
      const scope = await database.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return;
      await database.runs.forScope(scope).markAccountingFailed(runId, reason);
    } catch {
      // Best-effort; see above.
    }
  };

  return {
    async record(usage: GatewayUsageRecord): Promise<void> {
      try {
        const workspaceId = await database.findRunWorkspace(usage.runId);
        if (workspaceId === null) {
          throw new Error(`cannot settle usage for missing run ${usage.runId}`);
        }
        const scope = await database.scopes.forWorkspaceId(workspaceId);
        if (scope === null) {
          throw new Error(`cannot settle usage for run ${usage.runId}: workspace no longer exists`);
        }
        // A missing catalogue entry is not a settlement failure (issue #134): the response is
        // still recorded, at zero cost, with the run's accounting state saying that zero is
        // unpriced rather than measured. `priceFor` fails closed for every OTHER caller — the
        // one place a missing price is expected and handled is here.
        //
        // An upstream that finished but reported no usage is priced the same way, for the same
        // reason: its zeros were never measured, so the run settles `unavailable` rather than
        // claiming a real zero-cost turn (ADR-0068 D9).
        let price: ModelPrice | null;
        try {
          price = usage.metered ? priceFor(pricing, usage.provider, usage.model) : null;
        } catch {
          price = null;
        }
        const outcome = await database.runs.forScope(scope).recordUsage(usage.runId, {
          providerResponseId: usage.providerResponseId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          toolCalls: usage.toolCalls,
          wireProtocol: usage.wireProtocol,
          costUsd: price === null ? '0.000000' : calculateUsageCost(price, usage),
          costCurrency: 'USD',
          priceTableVersion: price === null ? null : pricing.version,
        });
        if (outcome.kind === 'not-found') {
          throw new Error(`cannot settle usage for missing run ${usage.runId}`);
        }
        if (outcome.kind === 'price-version-conflict') {
          throw new Error(
            `run ${usage.runId} was already settled with pricing ${outcome.existingVersion}; refusing mixed pricing ${pricing.version}`,
          );
        }
      } catch (error) {
        await markFailed(usage.runId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    fail(runId: string, reason: string): Promise<void> {
      return markFailed(runId, reason);
    },
  };
}

function modelConnectionSecretName(id: string): string {
  return `MODEL_CONNECTION_${id.replace(/-/g, '').toUpperCase()}`;
}

/** Resolve the token subject through tenant-scoped repositories and decrypt its one provider key. */
export function createDatabaseGatewayRunResolver(
  database: DatabaseRoot,
  secrets: SecretsService,
): GatewayRunResolver {
  return {
    async resolve(claims, tokenHash): Promise<RunResolution> {
      const scope = await database.scopes.forWorkspaceId(claims.workspaceId);
      if (scope === null) return { state: 'missing' };

      const active = await database.runTokens
        .forScope(scope)
        .isActive(claims.tokenId, claims.runId, tokenHash);
      if (!active) return { state: 'revoked' };

      const [run, agent, connection] = await Promise.all([
        database.runs.forScope(scope).get(claims.runId),
        database.agents.forScope(scope).get(claims.agentId),
        database.modelConnections.forScope(scope).get(claims.modelConnectionId),
      ]);
      if (run === null) return { state: 'missing' };
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        return { state: 'revoked' };
      }
      if (agent === null || connection === null) return { state: 'deleted' };
      if (run.agentId !== claims.agentId || connection.workspaceId !== claims.workspaceId) {
        return { state: 'missing' };
      }

      const secret = await secrets.resolveByName(
        scope,
        modelConnectionSecretName(claims.modelConnectionId),
      );
      if (secret === null) return { state: 'deleted' };
      return {
        state: 'active',
        providerId: registryProviderId(connection.provider),
        connectionProvider: connection.provider,
        credential: secret.value.toString('utf8'),
        settings: connection.config,
      };
    },
  };
}

/**
 * The gateway appends exactly one terminal `run.status` event and trims nothing: the retention
 * limit is web's, and web reads no deployment override the gateway could share (its run store takes
 * the default), so a trim here could only disagree with it. With this limit the repository's cutoff
 * is never positive, so the event is appended and no earlier event is deleted.
 */
const KEEP_EVERY_EVENT = Number.MAX_SAFE_INTEGER;

/** The usage ledger and run end the daily cost cap reads and writes, tenant-scoped like the rest. */
export function createDatabaseDailyCostLedger(database: DatabaseRoot): DailyCostLedger {
  const scopeOf = async (workspaceId: string) => {
    const scope = await database.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error(`daily cost cap: workspace ${workspaceId} did not resolve`);
    return scope;
  };
  return {
    async sumCostUsd(workspaceId, from, to) {
      return database.runs.forScope(await scopeOf(workspaceId)).usageCostUsd(from, to);
    },
    async endRun(workspaceId, runId, error) {
      await database.runs
        .forScope(await scopeOf(workspaceId))
        .finish(runId, 'failed', error, KEEP_EVERY_EVENT);
    },
  };
}
