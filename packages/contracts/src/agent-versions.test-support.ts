import { type AgentVersionResource } from './agent-versions.js';
import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  type AgentDefinition,
  type AgentResource,
} from './agents.js';
import type { SurfaceDefinition } from './surfaces.js';

export const DIGEST = 'a'.repeat(64);

export const definition: AgentDefinition = {
  apiVersion: AGENT_DEFINITION_API_VERSION,
  kind: AGENT_DEFINITION_KIND,
  agent: {
    name: 'Support triage',
    instructions: 'Answer support mail.',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    model: 'claude-sonnet-4-5',
    modelConnectionName: 'anthropic-prod',
    runtimeProfileName: null,
  },
  policy: {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: ['mcp__crm__*'],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['triage'] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  },
  policySource: 'stored',
  resources: {
    files: [{ path: 'docs/playbook.md', access: 'read' }],
    skills: ['triage'],
    connectors: ['crm'],
  },
};

export function surface(name: string, agent = definition.agent.name): SurfaceDefinition {
  return { name, agent, theme: { colour: '#2f5fd0' } };
}

export const agent: AgentResource = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  workspaceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  name: 'Support triage',
  instructions: 'Answer support mail.',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: definition.agent.permissions,
  createdBy: null,
  ownerPrincipalId: 'b3a0c2f4-1d2e-4f5a-8b6c-7d8e9f0a1b2c',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

export const resource: AgentVersionResource = {
  id: '9b2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  agentId: agent.id,
  workspaceId: agent.workspaceId,
  number: 1,
  summary: 'First version',
  via: 'aw-push',
  body: { definition, surfaces: [surface('main')] },
  createdByPrincipalId: agent.ownerPrincipalId,
  createdAt: '2026-10-02T00:00:00.000Z',
};

export function issuePaths(result: {
  success: boolean;
  error?: { issues: readonly { path: readonly PropertyKey[] }[] };
}): readonly string[] {
  if (result.success || result.error === undefined) throw new Error('expected a refusal');
  return result.error.issues.map((issue) => issue.path.map(String).join('.'));
}
