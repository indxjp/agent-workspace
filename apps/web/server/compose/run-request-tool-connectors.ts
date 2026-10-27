import type { AgentToolPolicy } from '@indx-workspace/contracts/agents';
import { BUILDER_REFUSAL_CODES, type BuilderRefusalCode } from '@indx-workspace/contracts/builder';
import { ENGINE_CATALOGUE, isEngineId, mcpToolName } from '@indx-workspace/contracts/engines';
import {
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_TTL_SECONDS,
  signIdentity,
} from '@indx-workspace/contracts/identity-assertion';
import {
  AW_DEV_TOOLS_CONNECTOR,
  TOOL_NAME_MAX_LENGTH,
  TOOL_SANDBOX_CONNECTOR_URL,
  gatewayToolPath,
  isReservedConnectorName,
} from '@indx-workspace/contracts/tool-connectors';

import { DomainError } from '../errors';
import type { RunAgent } from '../agent-versions/session-version';
import { CONNECTOR_IDENTITY_UNSUPPORTED } from '../connectors/identity';
import type { RunCaller } from '../runs/caller';
import type { RuntimeSettings } from './run-request-runtime-settings';
import type { AgentRunResourceSelection, PendingToolConnector } from './resource-loader';

const LEGACY_CONNECTOR_RULE_PREFIX = /^mcp__connector-([0-9a-f-]{36})__/u;

/**
 * A stored Claude tool policy with every rule written against an MCP connector's old server key,
 * `mcp__connector-<id>__…`, pointed at the key the connector has in this run (ADR-0113 SD13,
 * #1109), so a `deny` or an `autoApprove` keeps its meaning when the key is its slug name. A rule
 * for a connector not in the run, or already in the run's key form, is left as it is.
 */
export function withRunConnectorKeys<T extends AgentToolPolicy>(
  tools: T,
  keys: Readonly<Record<string, string>>,
): T {
  const rewrite = (rules: readonly string[]): readonly string[] =>
    rules.map((rule) =>
      rule.replace(LEGACY_CONNECTOR_RULE_PREFIX, (prefix, id: string) => {
        const key = keys[id];
        return key === undefined ? prefix : `mcp__${key}__`;
      }),
    );
  return {
    ...tools,
    base: tools.base === 'claude_code_preset' ? tools.base : rewrite(tools.base),
    autoApprove: rewrite(tools.autoApprove),
    deny: rewrite(tools.deny),
  };
}

/**
 * C17's run-time half: refuse a run whose tool connectors would show the model a name over
 * {@link TOOL_NAME_MAX_LENGTH} characters, or the same name twice. `mcp__<key>__<operation>` is
 * every engine's worst case and fits by construction (16 + 41); it is checked as a guard.
 */
export function assertToolNamesFit(
  pending: readonly PendingToolConnector[],
  engineId: string,
): void {
  // An engine the catalogue does not list shows the bare tool name, the strictest for collisions.
  const form = isEngineId(engineId) ? ENGINE_CATALOGUE[engineId].mcpToolName : 'tool';
  const seen = new Set<string>();
  for (const connector of pending) {
    for (const operation of connector.operationNames) {
      const name = mcpToolName(form, connector.key, operation);
      const worst = `mcp__${connector.key}__${operation}`;
      if (
        seen.has(name) ||
        name.length > TOOL_NAME_MAX_LENGTH ||
        worst.length > TOOL_NAME_MAX_LENGTH
      ) {
        throw new DomainError({
          category: 'validation',
          code: 'connector_tool_name_collision',
          publicMessage:
            `connector_tool_name_collision: the tool ${JSON.stringify(name)} of connector ` +
            `${connector.connectorId} collides with another connector's tool or is longer than ` +
            `${String(TOOL_NAME_MAX_LENGTH)} characters on engine ${engineId}`,
        });
      }
      seen.add(name);
    }
  }
}

/**
 * The run's MCP servers, with the tool host's connector (ADR-0115) told which run and agent call
 * it: the host reads `x-aw-run-id` and `x-aw-agent` into each code tool's context. The agent name
 * is percent-encoded, because a header value must be a ByteString and a name may be any Unicode.
 *
 * With `sandbox` (ADR-0118 TS3) the connector's entry is replaced by the gateway's tool sandbox
 * route and the run token: the agent sandbox never holds the tool host's own credential, and the
 * connector's stored URL, a reserved placeholder there, is never dialled.
 */
export function withToolHostRunHeaders(
  resources: AgentRunResourceSelection,
  runId: string,
  agent: string,
  sandbox?: { readonly url: string; readonly token: string },
): AgentRunResourceSelection['mcpServers'] {
  const names = resources.connectorNames ?? {};
  const agentHeader = encodeURIComponent(agent);
  return Object.fromEntries(
    Object.entries(resources.mcpServers).map(([key, server]) => {
      if (names[key] !== AW_DEV_TOOLS_CONNECTOR || !('url' in server)) return [key, server];
      if (sandbox !== undefined) {
        return [
          key,
          {
            type: 'http' as const,
            url: sandbox.url,
            headers: { authorization: `Bearer ${sandbox.token}`, 'x-aw-agent': agentHeader },
          },
        ];
      }
      return [
        key,
        {
          ...server,
          headers: { ...server.headers, 'x-aw-run-id': runId, 'x-aw-agent': agentHeader },
        },
      ];
    }),
  );
}

function hasOptedInConnector(resources: AgentRunResourceSelection): boolean {
  return (
    Object.keys(resources.mcpServers).some(
      (key) => resources.connectorIdentities?.[key] !== undefined,
    ) || (resources.toolConnectors ?? []).some((connector) => connector.identity === true)
  );
}

/**
 * ADR-0142 D1: a connector that opted in is never dialled without an identity. A run that reaches
 * one without a caller (an API key with no `subject`, a browser token minted by a key) is refused
 * before a token is issued, rather than reaching the connector unauthenticated.
 */
export function assertCallerForIdentity(
  resources: AgentRunResourceSelection,
  caller: RunCaller | null,
): void {
  if (caller !== null || !hasOptedInConnector(resources)) return;
  throw new DomainError({
    category: 'validation',
    code: CONNECTOR_IDENTITY_UNSUPPORTED,
    publicMessage:
      `${CONNECTOR_IDENTITY_UNSUPPORTED}: this run has a connector that asks for the caller's ` +
      'identity and no caller to assert; start it as a signed-in member, or with an API key that ' +
      'sets "subject"',
  });
}

/**
 * The Builder's door (`aw-control`, design §04) is the platform's, not a workspace connector's: a
 * run of any agent, the Builder included, that reaches a workspace or project connector of that
 * name is refused before a token is issued, so such a connector never receives a request. The
 * platform server comes only from the gateway forwarder (#1846 slice 2c). Connector names and the
 * server keys derived from them are compared as the reserved-name guard does (trimmed,
 * case-insensitive), and the refusal names no connector.
 */
export function assertMayReachAwControl(resources: AgentRunResourceSelection): void {
  const tools = resources.toolConnectors ?? [];
  const names = [
    ...Object.values(resources.connectorNames ?? {}),
    ...Object.keys(resources.mcpServers),
    ...tools.flatMap((connector) => [connector.name, connector.key]),
  ];
  if (!names.some(isReservedConnectorName)) return;
  const code: BuilderRefusalCode = 'not_allowed_to_build';
  throw new DomainError({
    category: 'forbidden',
    code,
    publicMessage: `${code}: ${BUILDER_REFUSAL_CODES[code].fix}`,
  });
}

/**
 * Each opted-in http/sse MCP server with a freshly signed `x-aw-identity` (ADR-0142 D1, D2), `aud`
 * its connector id. The platform header is spread last and any stored spelling of it is dropped,
 * so a stored header can never stand in for the assertion.
 *
 * ponytail: these servers are dialled directly by the engine, so the assertion is signed once at
 * compose and lives {@link IDENTITY_ASSERTION_TTL_SECONDS} seconds; a run that outlives it (possible
 * when `GATEWAY_TOKEN_TTL_SECONDS` exceeds it) reaches the connector with an expired assertion
 * (it fails closed). Upgrade: route MCP connectors through the gateway, which signs per call.
 */
export async function withIdentityHeaders(
  servers: AgentRunResourceSelection['mcpServers'],
  identities: AgentRunResourceSelection['connectorIdentities'],
  caller: RunCaller | null,
  workspace: string,
  runId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AgentRunResourceSelection['mcpServers']> {
  const entries = await Promise.all(
    Object.entries(servers).map(async ([key, server]) => {
      const identity = identities?.[key];
      if (identity === undefined || !('url' in server)) return [key, server] as const;
      if (caller === null) throw new Error('an opted-in connector needs a caller identity');
      const assertion = await signIdentity(
        {
          sub: caller.sub,
          principalKind: caller.principalKind,
          workspace,
          runId,
          aud: identity.connectorId,
          exp: nowSeconds + IDENTITY_ASSERTION_TTL_SECONDS,
        },
        identity.key,
      );
      const stored = Object.entries(server.headers ?? {}).filter(
        ([name]) => name.toLowerCase() !== IDENTITY_ASSERTION_HEADER,
      );
      return [
        key,
        {
          ...server,
          headers: { ...Object.fromEntries(stored), [IDENTITY_ASSERTION_HEADER]: assertion },
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * A run whose version pins code tools needs the tool host's connector among its servers, and a
 * sandbox to run them in when that connector is the deployment's reserved placeholder. Without
 * either the tools would silently not exist, so the run fails and names them instead (ADR-0118
 * TS8). A connector at a real tool host, such as `aw dev`'s loopback one, keeps the header path of
 * earlier pins (TS7).
 *
 * @returns whether the connector's entry is swapped for the gateway's tool sandbox route.
 */
export function codeToolsServedBySandbox(
  runAgent: RunAgent,
  settings: RuntimeSettings,
  resources: AgentRunResourceSelection,
): boolean {
  const tools = runAgent.toolBundles.map((bundle) => bundle.tool).join(', ');
  const key = Object.entries(resources.connectorNames ?? {}).find(
    ([, name]) => name === AW_DEV_TOOLS_CONNECTOR,
  )?.[0];
  const server = key === undefined ? undefined : resources.mcpServers[key];
  if (server === undefined) {
    throw new DomainError({
      category: 'validation',
      code: 'code_tool_connector_missing',
      publicMessage: `code_tool_connector_missing: the code tools ${tools} are served through the connector ${AW_DEV_TOOLS_CONNECTOR}, which this run does not have (it may be disabled, or outside the deployment policy).`,
    });
  }
  if (settings.toolSandbox === true) return true;
  if ('url' in server && server.url === TOOL_SANDBOX_CONNECTOR_URL) {
    throw new DomainError({
      category: 'validation',
      code: 'code_tool_needs_host',
      publicMessage: `code_tool_needs_host: the code tools ${tools} need a tool sandbox, and this run's runtime has none (the operator enables it with AGENT_WORKSPACE_TOOL_HOST_IMAGE on the web and the runner).`,
    });
  }
  return false;
}

/**
 * Each tool connector as an `http` MCP server at the gateway (ADR-0113 SD2, C16). The run token is
 * its only credential; the connector's own credential never leaves the gateway.
 */
export function toolMcpServersFor(
  pending: readonly PendingToolConnector[],
  gatewayBaseUrl: string,
  token: string,
): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  return Object.fromEntries(
    pending.map((connector) => [
      connector.key,
      {
        type: 'http' as const,
        url: `${gatewayBaseUrl}${gatewayToolPath(connector.connectorId)}`,
        headers: { authorization: `Bearer ${token}` },
      },
    ]),
  );
}
