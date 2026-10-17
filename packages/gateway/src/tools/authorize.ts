/**
 * The tool route's authorisation (ADR-0113 C16): a run token reaches a tool connector only while
 * the run is active, the connector is in `runs.tool_connector_ids`, it belongs to the token's
 * workspace and it is enabled. The decision is a pure function of facts the resolver gathers on
 * every request, so a revocation, a run ending or a disable takes effect on the next call.
 */
import type { DatabaseRoot, RunRecord, ToolConnectorRecord } from '@agent-workspace/core/db';
import { terminalRunStatuses } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import {
  OpenApiToolConfigSchema,
  PostgresToolConfigSchema,
  TOOL_GATEWAY_PROBLEM_CODES,
  type OpenApiToolConfig,
  type PostgresToolConfig,
} from '@indx-workspace/contracts/tool-connectors';
import { z } from 'zod';

import type { RunTokenClaims } from '../tokens/run-token.js';

type ToolRefusalCode = 'tool_run_not_active' | 'tool_not_in_run';

export type ToolRefusal = {
  readonly ok: false;
  readonly status: (typeof TOOL_GATEWAY_PROBLEM_CODES)[ToolRefusalCode];
  readonly code: ToolRefusalCode;
};

export type ToolAuthorization = { readonly ok: true } | ToolRefusal;

/** What {@link authorizeToolCall} decides from. `null` is "not found in the token's workspace". */
export type ToolAuthorizationFacts = {
  readonly tokenActive: boolean;
  readonly run: Pick<RunRecord, 'status' | 'toolConnectorIds'> | null;
  readonly connector: Pick<ToolConnectorRecord, 'workspaceId' | 'kind' | 'enabled'> | null;
  readonly workspaceId: string;
  readonly connectorId: string;
};

const TERMINAL: ReadonlySet<string> = new Set(terminalRunStatuses);

function refuse(code: ToolRefusalCode): ToolRefusal {
  return { ok: false, status: TOOL_GATEWAY_PROBLEM_CODES[code], code };
}

/**
 * C16, after the token's signature and expiry were verified. Every connector refusal is the same
 * `403 tool_not_in_run`, so the route never reveals whether a connector exists elsewhere.
 */
export function authorizeToolCall(facts: ToolAuthorizationFacts): ToolAuthorization {
  if (!facts.tokenActive || facts.run === null || TERMINAL.has(facts.run.status)) {
    return refuse('tool_run_not_active');
  }
  const { connector } = facts;
  if (
    !(facts.run.toolConnectorIds ?? []).includes(facts.connectorId) ||
    connector === null ||
    connector.workspaceId !== facts.workspaceId ||
    !connector.enabled ||
    // ponytail: postgres answers tool_not_in_run until the formal model's toolDecision admits it
    // (formal/AgentWorkspace/Behaviour/GatewayIngress.lean); its executor is wired below
    connector.kind !== 'openapi'
  ) {
    return refuse('tool_not_in_run');
  }
  return { ok: true };
}

/** One parameter of an exposed operation, as S2-02c's normaliser stores it. */
const ToolParameterSchema = z
  .object({
    name: z.string().min(1),
    in: z.string().min(1),
    required: z.boolean(),
    style: z.string().optional(),
    schema: z.unknown().optional(),
  })
  .strict()
  .readonly();

export type ToolParameter = z.infer<typeof ToolParameterSchema>;

/** The persisted `tool_config` of an `openapi` connector: S2-02c writes exactly these two keys. */
const OpenApiConnectorConfigSchema = z
  .object({
    openapi: OpenApiToolConfigSchema,
    parameters: z.record(z.string(), z.array(ToolParameterSchema).readonly()),
  })
  .strict()
  .readonly();

/** The persisted `tool_config` of a `postgres` connector: S2-02c writes exactly this key. */
const PostgresConnectorConfigSchema = z
  .object({ postgres: PostgresToolConfigSchema })
  .strict()
  .readonly();

/** An authorised connector, ready for its kind's executor. */
type AuthorizedToolConnector = (
  | {
      /** Optional, so a resolution built before `postgres` existed still reads as `openapi`. */
      readonly kind?: 'openapi';
      readonly config: OpenApiToolConfig;
      readonly parameters: Readonly<Record<string, readonly ToolParameter[]>>;
    }
  | { readonly kind: 'postgres'; readonly config: PostgresToolConfig }
) & {
  /** Decrypts the connector's own credential; `null` when it has none or it is gone. */
  readonly credential: () => Promise<string | null>;
};

type ToolResolution =
  { readonly ok: true; readonly connector: AuthorizedToolConnector } | ToolRefusal;

/** Authorises a verified run token for one connector, on every request. */
export interface ToolConnectorResolver {
  resolve(claims: RunTokenClaims, tokenHash: string, connectorId: string): Promise<ToolResolution>;
}

/**
 * Gathers the C16 facts through the token's workspace scope and decrypts only the connector's own
 * credential. It never reads a model connection or the model key.
 */
export function createDatabaseToolResolver(
  database: DatabaseRoot,
  secrets: SecretsService,
): ToolConnectorResolver {
  return {
    async resolve(claims, tokenHash, connectorId): Promise<ToolResolution> {
      const scope = await database.scopes.forWorkspaceId(claims.workspaceId);
      if (scope === null) return refuse('tool_run_not_active');
      const tokenActive = await database.runTokens
        .forScope(scope)
        .isActive(claims.tokenId, claims.runId, tokenHash);
      const run = tokenActive ? await database.runs.forScope(scope).get(claims.runId) : null;
      const connectors = database.mcpServers.forScope(scope);
      const connector = run === null ? null : await connectors.getToolConnector(connectorId);
      const decision = authorizeToolCall({
        tokenActive,
        run,
        connector,
        workspaceId: claims.workspaceId,
        connectorId,
      });
      if (!decision.ok) return decision;
      if (connector === null) throw new Error('an authorised tool connector must exist');

      // A row that fails this parse was written by something other than S2-02c's admission: a
      // defect, answered as the server's generic 500 rather than a refusal.
      const { credentialSecretId } = connector;
      const credential = async (): Promise<string | null> => {
        if (credentialSecretId === null) return null;
        // Secrets resolve by name; `list` is metadata only and maps the id to that name.
        const named = (await secrets.list(scope)).find((entry) => entry.id === credentialSecretId);
        if (named === undefined) return null;
        const secret = await secrets.resolveByName(scope, named.name);
        return secret === null ? null : secret.value.toString('utf8');
      };
      if (connector.kind === 'postgres') {
        const config = PostgresConnectorConfigSchema.parse(connector.toolConfig);
        return { ok: true, connector: { kind: 'postgres', config: config.postgres, credential } };
      }
      const config = OpenApiConnectorConfigSchema.parse(connector.toolConfig);
      return {
        ok: true,
        connector: {
          kind: 'openapi',
          config: config.openapi,
          parameters: config.parameters,
          credential,
        },
      };
    },
  };
}
