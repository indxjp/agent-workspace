import {
  type PortableCodeToolDeclaration,
  type PortableAgentContext,
  own,
} from './convert-contract.js';
import { type AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

import { PortableToolSchema } from '@indx-workspace/contracts/portable-agent';
import { type ProjectConnector } from '@indx-workspace/contracts/project-file';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import { issuesFromZod } from '../define/errors.js';
import { CODE_TOOL_DEFAULT_TIMEOUT_MS } from '../define/references.js';
import { type OpenApiToolDefinition } from '../define/version-body.js';

/** The one `./` prefix `openapiTool()` allows on a spec path; `PortableRelativePathSchema` refuses it. */
const CURRENT_DIRECTORY_PREFIX = /^\.\//u;

function openApiToolOf(tool: OpenApiToolDefinition): unknown {
  return {
    kind: 'openapi',
    name: tool.name,
    specRef: tool.spec.replace(CURRENT_DIRECTORY_PREFIX, ''),
    allow: [...tool.allow],
    ...(tool.baseUrl === undefined ? {} : { baseUrl: tool.baseUrl }),
    ...(tool.auth === 'none' || tool.credential === undefined
      ? {}
      : {
          auth: {
            secretRef: tool.credential.secret,
            ...(tool.auth === 'bearer' ? {} : { header: tool.auth.header }),
          },
        }),
  };
}

function mcpToolOf(name: string, connector: ProjectConnector): unknown {
  return {
    kind: 'mcp',
    name,
    transport: connector.transport === 'sse' ? 'sse' : 'streamable-http',
    url: connector.url,
    ...(connector.auth === undefined
      ? {}
      : { auth: { scheme: connector.auth.scheme, secretRef: connector.auth.credential.secret } }),
  };
}

export function portableToolsOf(
  body: AgentVersionBody,
  context: PortableAgentContext,
  drop: (path: string, reason: string) => void,
): unknown[] {
  const resources = body.definition.resources;
  const tools: unknown[] = [];
  const keep = (path: string, tool: unknown): boolean => {
    const parsed = PortableToolSchema.safeParse(tool);
    if (parsed.success) {
      tools.push(parsed.data);
      return true;
    }
    const why = issuesFromZod(parsed.error)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    drop(path, `cannot be written as a portable tool: ${why}`);
    return false;
  };
  const codeTool = (path: string, declaration: PortableCodeToolDeclaration): void => {
    const { outputSchema, timeoutMs, secrets, allowedDomains, ...portable } = declaration;
    if (!keep(path, { kind: 'code', ...portable })) return;
    const enforced = (field: string, what: string): void => {
      drop(
        `${path}.${field}`,
        `${what} is enforced by the workspace tool runtime (ADR-0134) and is not carried in the portable definition`,
      );
    };
    if (outputSchema !== undefined) enforced('outputSchema', 'the output schema');
    if (timeoutMs !== undefined && timeoutMs !== CODE_TOOL_DEFAULT_TIMEOUT_MS) {
      enforced('timeoutMs', `the ${timeoutMs} ms timeout`);
    }
    if (secrets !== undefined) enforced('secrets', `the secrets ${secrets.join(', ')}`);
    if (allowedDomains !== undefined) {
      enforced('allowedDomains', `the egress restriction to ${allowedDomains.join(', ')}`);
    }
  };

  // The portable tool has no identity field: the assertion is an Agent Workspace feature (ADR-0142).
  const dropIdentity = (path: string, secretName: string): void => {
    drop(
      `${path}.identity`,
      `the signed identity assertion (secret ${secretName}) is an Agent Workspace feature and is not carried in the portable definition`,
    );
  };

  const addCodeTools = (): void => {
    if (context.codeTools !== undefined) {
      context.codeTools.forEach((declaration, at) => {
        codeTool(`codeTools.${at}`, declaration);
      });
      return;
    }
    (body.toolBundles ?? []).forEach((bundle, at) => {
      if (bundle.description === undefined || bundle.inputSchema === undefined) {
        drop(
          `toolBundles.${at}`,
          'pinned before its declaration was recorded; push the agent again',
        );
      } else {
        codeTool(`toolBundles.${at}`, {
          name: bundle.tool,
          description: bundle.description,
          inputSchema: bundle.inputSchema,
          outputSchema: bundle.outputSchema,
          timeoutMs: bundle.timeoutMs,
          secrets: bundle.secrets,
          allowedDomains: bundle.allowedDomains,
        });
      }
    });
  };

  let codeToolsSeen = false;
  resources.connectors.forEach((name, index) => {
    const path = `definition.resources.connectors.${index}`;
    if (name === AW_DEV_TOOLS_CONNECTOR) {
      codeToolsSeen = true;
      addCodeTools();
      return;
    }
    const catalogTool = context.catalogTools?.find((tool) => tool.name === name);
    const connector = own(context.connectors, name);
    if (catalogTool?.kind === 'openapi') {
      if (catalogTool.auth !== 'none' && catalogTool.credential === undefined) {
        drop(path, 'its credential secret is not named');
      } else if (keep(path, openApiToolOf(catalogTool)) && catalogTool.identity !== undefined) {
        dropIdentity(path, catalogTool.identity.secret);
      }
    } else if (catalogTool?.kind === 'postgres') {
      drop(path, 'postgres tools run only inside Agent Workspace');
    } else if (connector !== undefined) {
      if (keep(path, mcpToolOf(name, connector)) && connector.identity !== undefined) {
        dropIdentity(path, connector.identity.secret);
      }
    } else {
      drop(
        path,
        `connector "${name}" is not declared in agent-workspace.yaml connectors:, so its URL is unknown`,
      );
    }
  });
  if (!codeToolsSeen && context.codeTools === undefined) {
    (body.toolBundles ?? []).forEach((_bundle, index) => {
      drop(
        `toolBundles.${index}`,
        `the agent does not use the ${AW_DEV_TOOLS_CONNECTOR} connector`,
      );
    });
  }

  return tools;
}
