import { RunRequest } from '@agent-workspace/run-protocol';
import { compileRunRequest } from './compile.js';
import type { CompiledClaudeRun } from './options.js';

/**
 * The canonical compile-step fixtures, shared by `compile.test.ts` and `compile-options.test.ts`.
 *
 * They are restated here rather than imported from `schemas.test.ts`: importing one test module
 * from another executes its `describe` blocks a second time, so every assertion would be
 * collected and run twice. This support module has no tests of its own, so it can be shared.
 */
export const canonicalAgent = {
  name: 'Customer Support Agent',
  instructions: 'You help employees answer questions...',
  model: 'claude-sonnet-4-5',
  permissions: {
    readFiles: true,
    writeFiles: true,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  skills: { mode: 'allowlist', names: ['customer-support'] },
  mcpServers: {
    jira: {
      type: 'http',
      url: 'https://jira.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    },
    search: { command: '/usr/bin/search-mcp', args: ['--stdio'] },
  },
  limits: { maxTurns: 20, maxBudgetUsd: 5 },
} as const;

/** The engine arm as compose composes it for an agent with a stored policy. */
export const canonicalPolicy = {
  tools: {
    base: ['Read', 'Grep', 'mcp__jira__get_issue'],
    autoApprove: ['Read', 'mcp__jira__get_*'],
    deny: ['Bash', 'mcp__*'],
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
  },
  fileGrantDeny: [],
} as const;

export const canonicalRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  cwd: '/run/claude',
  prompt: 'Summarise the open Jira issues.',
  projectKey: 'tenant-a',
  portable: canonicalAgent,
  policy: canonicalPolicy,
  session: { kind: 'fresh', sessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
  env: { PATH: '/usr/bin', HOME: '/home/agent' },
} as const;

export const request = RunRequest.parse(canonicalRunRequest);

/** Compiles the canonical request with some of its top-level fields replaced. */
export function compileCanonical(overrides: Record<string, unknown>): CompiledClaudeRun {
  return compileRunRequest(RunRequest.parse({ ...canonicalRunRequest, ...overrides }));
}
