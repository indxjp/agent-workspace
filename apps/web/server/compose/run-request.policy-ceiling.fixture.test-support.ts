import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import type { AgentPolicy } from '../../contracts/agents';
import type { LaunchContext } from '../runs/environment';

import { DomainError } from '../errors';
import { type RunTokenIssuer } from '../gateway/issuer';
import { type AgentRunResourceLoader } from './resource-loader';

import { buildRunRequestFor, type ModelSelection, type RunToolSnapshot } from './run-request';
import {
  ALL_ON,
  GATEWAY,
  launchContext,
  rowRunAgent,
  SETTINGS,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function createPolicyCeilingFixture() {
  const GITHUB_KEY = 'connector-00000000-0000-4000-8000-0000000000a1';
  const JIRA_KEY = 'connector-00000000-0000-4000-8000-0000000000a2';
  const ORDERS_ID = '00000000-0000-4000-8000-0000000000b1';
  const WAREHOUSE_ID = '00000000-0000-4000-8000-0000000000b2';
  const MCP_ENTRY = { type: 'http' as const, url: 'https://mcp.example.test/mcp' };
  function claudeArm(
    deny: readonly string[],
    limits: AgentPolicy['limits'] = { maxTurns: null, maxBudgetUsd: null },
  ): AgentPolicy {
    return {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: [...deny],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'all' },
      limits,
    };
  }
  async function savedAgent(policy: AgentPolicy | null) {
    const launched = await launchContext();
    const store = launched.agents.forWorkspace(WORKSPACE);
    await store.update(launched.agentId, { permissions: ALL_ON });
    if (policy !== null) await store.replacePolicy(launched.agentId, policy);
    return launched;
  }
  function recordingGateway(): RunTokenIssuer & { readonly issues: unknown[] } {
    const issues: unknown[] = [];
    return {
      baseUrl: 'http://gateway:4000',
      issues,
      issue(claims) {
        issues.push(claims);
        return Promise.resolve('run-token-fixed');
      },
    };
  }
  async function compose(
    policy: AgentPolicy | null,
    ceiling: ProjectPolicy | null,
    options: {
      readonly loader?: AgentRunResourceLoader;
      readonly snapshot?: RunToolSnapshot;
      readonly model?: ModelSelection;
      readonly gateway?: RunTokenIssuer;
      readonly limits?: NonNullable<LaunchContext['limits']>;
      readonly spendCeilingUsd?: string;
    } = {},
  ) {
    const { context: saved, agents } = await savedAgent(policy);
    const context: LaunchContext = {
      ...saved,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.spendCeilingUsd === undefined
        ? {}
        : { run: { ...saved.run, spendCeilingUsd: options.spendCeilingUsd } }),
    };
    return buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      options.gateway ?? GATEWAY,
      {},
      undefined,
      null,
      options.loader,
      options.model,
      null,
      undefined,
      options.snapshot,
      ceiling,
    );
  }
  async function refusalOf(promise: Promise<unknown>): Promise<DomainError> {
    const error: unknown = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!(error instanceof DomainError)) throw new Error('expected a DomainError refusal');
    return error;
  }
  return {
    GITHUB_KEY,
    JIRA_KEY,
    ORDERS_ID,
    WAREHOUSE_ID,
    MCP_ENTRY,
    claudeArm,
    savedAgent,
    recordingGateway,
    compose,
    refusalOf,
  };
}
