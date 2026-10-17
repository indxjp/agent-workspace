/**
 * One Power Platform custom-connector definition per remote MCP server: an OpenAPI 2.0 document
 * with `x-ms-agentic-protocol: mcp-streamable-1.0` (Learn:
 * https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent) and
 * the connection parameters (VERIFY against https://learn.microsoft.com/connectors/custom-connectors/paconn-cli).
 * A secret is named, never carried: no value is ever emitted.
 */

export interface McpConnectorInput {
  readonly name: string;
  readonly agentName: string;
  readonly url: string;
  readonly secretRef: string | undefined;
}

export type McpConnectorResult =
  | {
      readonly ok: true;
      readonly swagger: Readonly<Record<string, unknown>>;
      readonly apiProperties: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly reason: string };

export function buildMcpConnector(input: McpConnectorInput): McpConnectorResult {
  const url = new URL(input.url);
  if (url.search !== '') {
    return {
      ok: false,
      reason: 'a Power Platform connector host and base path cannot carry a query string',
    };
  }
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : url.pathname;
  const { secretRef } = input;

  const swagger = {
    swagger: '2.0',
    info: {
      title: input.name,
      description: `MCP server ${input.name} for ${input.agentName}`,
      version: '1.0.0',
    },
    host: url.host,
    basePath: '/',
    schemes: [url.protocol.slice(0, -1)],
    paths: {
      [path === '' ? '/' : path]: {
        post: {
          summary: input.name,
          'x-ms-agentic-protocol': 'mcp-streamable-1.0',
          operationId: 'InvokeMCP',
          responses: { '200': { description: 'Success' } },
        },
      },
    },
    ...(secretRef === undefined
      ? {}
      : {
          securityDefinitions: { api_key: { type: 'apiKey', in: 'header', name: 'Authorization' } },
          security: [{ api_key: [] }],
        }),
  };

  const apiProperties = {
    properties: {
      connectionParameters:
        secretRef === undefined
          ? {}
          : {
              api_key: {
                type: 'securestring',
                uiDefinition: {
                  displayName: secretRef,
                  description: `The value of secret ${secretRef}, as 'Bearer <token>'`,
                  tooltip: `Agent Workspace secret ${secretRef}`,
                  constraints: { tabIndex: 2, clearText: false, required: 'true' },
                },
              },
            },
      iconBrandColor: '#007ee5',
      capabilities: [],
      publisher: 'Agent Workspace',
      stackOwner: 'Agent Workspace',
    },
  };

  return { ok: true, swagger, apiProperties };
}
