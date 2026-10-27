import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

type Definition = AgentVersionBody['definition'];

/** A complete, valid version body for component and diff tests; `patch` replaces whole sections. */
export function definitionBody(
  patch: {
    agent?: Partial<Definition['agent']>;
    resources?: Partial<Definition['resources']>;
    toolBundles?: AgentVersionBody['toolBundles'];
  } = {},
): AgentVersionBody {
  return {
    definition: {
      apiVersion: 'agentworkspace.dev/v1',
      kind: 'AgentDefinition',
      agent: {
        name: 'expense-refunds',
        instructions: 'Help people file expense refunds.',
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        model: 'claude-sonnet-5',
        modelConnectionName: 'anthropic',
        runtimeProfileName: 'local-default',
        ...patch.agent,
      },
      policy: {
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      },
      policySource: 'compiled',
      resources: {
        files: [{ path: 'receipts/', access: 'read' }],
        skills: [],
        connectors: ['erp'],
        ...patch.resources,
      },
    },
    surfaces: [],
    ...(patch.toolBundles === undefined ? {} : { toolBundles: patch.toolBundles }),
  };
}
