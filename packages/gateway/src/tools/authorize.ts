/**
 * The tool route's authorisation (ADR-0113 C16): a run token reaches a tool connector only while
 * the run is active, the connector is in `runs.tool_connector_ids`, it belongs to the token's
 * workspace and it is enabled. The decision is a pure function of facts the resolver gathers on
 * every request, so a revocation, a run ending or a disable takes effect on the next call.
 */
import type { DatabaseRoot, RunRecord, ToolConnectorRecord } from '@agent-workspace/core/db';
import { terminalRunStatuses } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import { BUILDER_TOOL_NAMES, BUILDER_TOOLS } from '@indx-workspace/contracts/builder';
import {
  IDENTITY_ASSERTION_TTL_SECONDS,
  signIdentity,
} from '@indx-workspace/contracts/identity-assertion';
import { isStorageConnectionSecretName } from '@indx-workspace/contracts/secret-reference';
import {
  AW_CONTROL_CONNECTOR,
  OpenApiToolConfigSchema,
  PostgresToolConfigSchema,
  TOOL_GATEWAY_PROBLEM_CODES,
  toolApprovalRules,
  toolServerKeys,
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

/** The call an approval is good for, in the shape `runs.approved_tool_calls` stores it. */
type ApprovedCall = { readonly toolName: string; readonly canonicalCall: string };

/**
 * What the gateway needs to tell an approved write from a direct call (ADR-0113 SD4, amended by
 * #1304): the connector's MCP server key in this run, as compose derives it, the canonical text of
 * the calls the run may make (`runs.approved_tool_calls`), and `consume`, which uses one of them up
 * durably (ADR-0145 D2.1, #1541): `consumed` for the one caller that got it, `already-used` when
 * another caller got it first, `not-approved` when the run no longer approves it (it left
 * `running`, or there is no run).
 */
export type ToolApproval = {
  readonly serverKey: string;
  readonly approvedToolCalls: readonly string[];
  readonly consume: (call: ApprovedCall) => Promise<'consumed' | 'already-used' | 'not-approved'>;
};

/** What the gateway does with a call: run it, run it once its approval is consumed, or refuse it. */
export type ApprovalDecision =
  | { readonly kind: 'read' }
  | { readonly kind: 'write'; readonly call: ApprovedCall }
  | { readonly kind: 'refused' };

/**
 * Whether the gateway may run `operationName` with `args`. A read always may. A write may when its
 * canonical call is approved, and then names the call to consume; the engine's `canUseTool` asks the
 * same `needsApproval` and builds the same `canonicalCall`, so a call that passed it passes here, and
 * a call that skipped it does not. Arguments that are not JSON are never approved.
 */
export function approvalDecision(
  approval: ToolApproval,
  operations: OpenApiToolConfig['operations'],
  operationName: string,
  args: unknown,
): ApprovalDecision {
  const toolName = `mcp__${approval.serverKey}__${operationName}`;
  return decideByRules(approval, toolApprovalRules(approval.serverKey, operations), toolName, args);
}

/**
 * The `aw-control` tools that write or spend (#1846), as approval rules: every Builder tool whose
 * cost class is not `read`, so a tool added to `BUILDER_TOOLS` is gated here without an edit.
 */
export const AW_CONTROL_APPROVAL_RULES: readonly string[] = BUILDER_TOOL_NAMES.filter(
  (name) => BUILDER_TOOLS[name].kind !== 'read',
).map((name) => `mcp__${AW_CONTROL_CONNECTOR}__${name}`);

/** {@link approvalDecision} for the `aw-control` tool `name`, under {@link AW_CONTROL_APPROVAL_RULES}. */
export function awControlApprovalDecision(
  approval: ToolApproval,
  name: string,
  args: unknown,
): ApprovalDecision {
  return decideByRules(
    approval,
    AW_CONTROL_APPROVAL_RULES,
    `mcp__${AW_CONTROL_CONNECTOR}__${name}`,
    args,
  );
}

function decideByRules(
  approval: ToolApproval,
  rules: readonly string[],
  toolName: string,
  args: unknown,
): ApprovalDecision {
  if (!needsApproval(rules, toolName)) return { kind: 'read' };
  try {
    const call = canonicalCall(toolName, args ?? {});
    return approval.approvedToolCalls.includes(call)
      ? { kind: 'write', call: { toolName, canonicalCall: call } }
      : { kind: 'refused' };
  } catch {
    return { kind: 'refused' };
  }
}

/** An authorised connector, ready for its kind's executor. */
type AuthorizedToolConnector = (
  | {
      /** Optional, so a resolution built before `postgres` existed still reads as `openapi`. */
      readonly kind?: 'openapi';
      readonly config: OpenApiToolConfig;
      readonly parameters: Readonly<Record<string, readonly ToolParameter[]>>;
      /** Optional for the same reason as `kind`; a write is refused without it. */
      readonly approval?: ToolApproval;
    }
  | { readonly kind: 'postgres'; readonly config: PostgresToolConfig }
) & {
  /** Decrypts the connector's own credential; `null` when it has none or it is gone. */
  readonly credential: () => Promise<string | null>;
  /**
   * Present only when the connector opted in to the identity assertion (ADR-0142 D1). Signs a
   * fresh `x-aw-identity` value for this call, or `null` when it cannot: the run has no caller, or
   * the connector's secret is gone. The caller must then not dial the upstream.
   */
  readonly identity?: () => Promise<string | null>;
};

type ToolResolution =
  { readonly ok: true; readonly connector: AuthorizedToolConnector } | ToolRefusal;

/** Authorises a verified run token for one connector, on every request. */
export interface ToolConnectorResolver {
  resolve(claims: RunTokenClaims, tokenHash: string, connectorId: string): Promise<ToolResolution>;
}

/** The connector's server key in `run`, the run's approved calls and how to consume one. */
async function runApproval(
  connectors: ReturnType<DatabaseRoot['mcpServers']['forScope']>,
  runs: ReturnType<DatabaseRoot['runs']['forScope']>,
  run: RunRecord | null,
  connectorId: string,
): Promise<ToolApproval> {
  // SD13: a run's tool connectors take their keys in id order, the derivation compose uses.
  const runTools = (await connectors.listToolConnectors())
    .filter((tool) => (run?.toolConnectorIds ?? []).includes(tool.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const serverKey = toolServerKeys(runTools.map((tool) => tool.name))[
    runTools.findIndex((tool) => tool.id === connectorId)
  ];
  if (serverKey === undefined) throw new Error('an authorised tool connector must be in its run');
  return {
    serverKey,
    approvedToolCalls: (run?.approvedToolCalls ?? []).map((call) => call.canonicalCall),
    consume: (call) =>
      run === null ? Promise.resolve('not-approved') : runs.consumeApprovedCall(run.id, call),
  };
}

/**
 * Gathers the C16 facts through the token's workspace scope and decrypts only the connector's own
 * credential. It never reads a model connection or the model key.
 */
export function createDatabaseToolResolver(
  database: DatabaseRoot,
  secrets: SecretsService,
  now: () => number = () => Math.floor(Date.now() / 1000),
): ToolConnectorResolver {
  return {
    async resolve(claims, tokenHash, connectorId): Promise<ToolResolution> {
      const scope = await database.scopes.forWorkspaceId(claims.workspaceId);
      if (scope === null) return refuse('tool_run_not_active');
      const tokenActive = await database.runTokens
        .forScope(scope)
        .isActive(claims.tokenId, claims.runId, tokenHash);
      const runs = database.runs.forScope(scope);
      const run = tokenActive ? await runs.get(claims.runId) : null;
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
        const secret = await secrets.resolveById(scope, credentialSecretId);
        return secret === null ? null : secret.value.toString('utf8');
      };
      const { identitySecretName } = connector;
      const identity =
        identitySecretName === null
          ? {}
          : {
              identity: async (): Promise<string | null> => {
                if (claims.caller === undefined) return null;
                // A storage connection's credential is never a signing key, even on a row stored
                // before the contracts refused one: it reads as missing.
                if (isStorageConnectionSecretName(identitySecretName)) return null;
                const key = await secrets.resolveByName(scope, identitySecretName);
                if (key === null) return null;
                return signIdentity(
                  {
                    sub: claims.caller.sub,
                    principalKind: claims.caller.principalKind,
                    workspace: claims.workspaceId,
                    runId: claims.runId,
                    aud: connectorId,
                    exp: now() + IDENTITY_ASSERTION_TTL_SECONDS,
                  },
                  key.value.toString('utf8'),
                );
              },
            };
      if (connector.kind === 'postgres') {
        const config = PostgresConnectorConfigSchema.parse(connector.toolConfig);
        return { ok: true, connector: { kind: 'postgres', config: config.postgres, credential } };
      }
      const config = OpenApiConnectorConfigSchema.parse(connector.toolConfig);
      // Only a write needs the server key, so a read-only connector skips the lookup; without
      // `approval` `callTool` still runs every read.
      const hasWrite = toolApprovalRules('', config.openapi.operations).length > 0;
      const approval = hasWrite
        ? { approval: await runApproval(connectors, runs, run, connectorId) }
        : {};
      return {
        ok: true,
        connector: {
          kind: 'openapi',
          config: config.openapi,
          parameters: config.parameters,
          ...approval,
          credential,
          ...identity,
        },
      };
    },
  };
}
