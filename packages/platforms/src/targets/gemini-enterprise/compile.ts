import { buildA2aAgentCard } from '@indx-workspace/contracts/a2a';
import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';

import { prettyJson } from '../../json.js';
import { dropped, mapped, native } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import type { GeminiEnterpriseOptions } from './options.js';
import { buildRegistrationRequest } from './registration.js';

const CARD_FILE = 'agent-card.json';
const REQUEST_FILE = 'register-agent.request.json';

const NAME_IN_MESSAGE_MAX = 64;
const ON_DEPLOYMENT =
  'Stays on the Agent Workspace deployment; Gemini Enterprise only calls its A2A endpoint';

/** The A2A endpoint of `agentName` (the path the control plane serves), relative to an https origin. */
export function a2aAgentUrl(publicBaseUrl: string, agentName: string): string {
  return `${new URL(publicBaseUrl).origin}/api/a2a/agents/${encodeURIComponent(agentName)}`;
}

function toolVerdict(path: string, tool: PortableAgent['tools'][number]): FieldVerdict {
  if (tool.kind === 'mcp' && tool.transport === 'stdio') {
    return dropped(
      path,
      'stdio_mcp_unsupported',
      'A stdio MCP server cannot be reached from a hosted platform',
    );
  }
  switch (tool.kind) {
    case 'mcp':
      return mapped(path, `${ON_DEPLOYMENT}; our engine calls the MCP server server-side`);
    case 'code':
      return mapped(path, `${ON_DEPLOYMENT}; the code tool runs in our tool host`);
    case 'openapi':
      return mapped(path, `${ON_DEPLOYMENT}; a server-side connector`);
    case 'builtin':
      return mapped(path, `${ON_DEPLOYMENT}; one of our engine's built-in tools`);
  }
}

function agentVerdicts(
  agent: PortableAgent,
  isRoot: boolean,
  cardDescription: string,
): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const kept = isRoot
    ? ON_DEPLOYMENT
    : "Stays on the deployment and runs behind the root agent's A2A endpoint; only the root is registered";
  const report: FieldVerdict[] = [];
  if (agent.description !== undefined) {
    report.push(
      isRoot
        ? native(at('description'), 'Emitted as the card and registration description')
        : mapped(at('description'), kept),
    );
  } else if (isRoot) {
    report.push(
      mapped(
        at('description'),
        `Generated from the agent name as "${cardDescription}", because A2A requires a description; set description on the agent to use your own`,
      ),
    );
  }
  report.push(mapped(at('instructions'), `${kept}; the instructions are not sent to Google`));
  if (agent.model !== undefined) {
    report.push(mapped(at('model'), `${kept}; any provider, through our gateway`));
  }
  if (agent.engine !== undefined) report.push(mapped(at('engine'), kept));
  for (const key of AGENT_PERMISSION_KEYS) {
    report.push(mapped(at(`permissions.${key}`), `${kept}; enforced by our runtime`));
  }
  agent.tools.forEach((tool, index) => report.push(toolVerdict(at(`tools.${index}`), tool)));
  agent.skills.forEach((_, index) => report.push(mapped(at(`skills.${index}`), kept)));
  agent.knowledge.forEach((_, index) => report.push(mapped(at(`knowledge.${index}`), kept)));
  agent.subagents.forEach((_, index) => report.push(mapped(at(`subagents.${index}`), kept)));
  if (agent.limits?.maxTurns !== undefined) {
    report.push(mapped(at('limits.maxTurns'), `${kept}; enforced by our runtime`));
  }
  if (agent.limits?.maxBudgetUsd !== undefined) {
    report.push(mapped(at('limits.maxBudgetUsd'), `${kept}; enforced by our runtime`));
  }
  for (const id of Object.keys(agent.extensions?.engines ?? {})) {
    report.push(mapped(at(`extensions.engines.${id}`), `${kept}; our engine reads it`));
  }
  for (const id of Object.keys(agent.extensions?.platforms ?? {})) {
    report.push(
      id === 'gemini-enterprise'
        ? mapped(at(`extensions.platforms.${id}`), 'Read as the target options')
        : dropped(
            at(`extensions.platforms.${id}`),
            'field_unsupported',
            'Read by other platforms only',
          ),
    );
  }
  return report;
}

function report(project: PortableProject, cardDescription: string): FieldVerdict[] {
  const verdicts: FieldVerdict[] = [];
  if (project.toolEndpoint !== undefined) {
    verdicts.push(
      mapped(
        'toolEndpoint',
        "Not used: Gemini Enterprise calls the agent's A2A endpoint, and code tools run in the Agent Workspace tool host, so no public tool endpoint is needed",
      ),
    );
  }
  for (const agent of project.agents) {
    verdicts.push(...agentVerdicts(agent, agent.name === project.root, cardDescription));
  }
  return verdicts;
}

export function compileGeminiEnterprise(
  project: PortableProject,
  options: GeminiEnterpriseOptions,
): PlatformCompileResult {
  const root = project.agents.find((agent) => agent.name === project.root);
  if (root === undefined) {
    const shown =
      project.root.length > NAME_IN_MESSAGE_MAX
        ? `${project.root.slice(0, NAME_IN_MESSAGE_MAX)}…`
        : project.root;
    return {
      ok: false,
      refusal: {
        code: 'platform_agent_not_found',
        message: `agent "${shown}" is not in the project`,
        details: [],
      },
    };
  }

  const card = buildA2aAgentCard({
    name: root.name,
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    description: root.description ?? null,
    url: a2aAgentUrl(options.publicBaseUrl, root.name),
    version: options.agentVersion,
    ...(options.examples === undefined ? {} : { examples: options.examples }),
  });
  const files: PlatformFile[] = [
    { path: CARD_FILE, content: prettyJson(card) },
    { path: REQUEST_FILE, content: prettyJson(buildRegistrationRequest(root.name, card, options)) },
  ];
  return { ok: true, files, report: report(project, card.description) };
}
