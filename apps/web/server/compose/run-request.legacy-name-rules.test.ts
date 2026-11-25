/**
 * A tool rule an older agent version stored by an MCP connector's name keeps its meaning in a run
 * whose key for that connector is not the name (#2446): a deny follows the connector, and an
 * auto-approval never moves to another server.
 */
import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { describe, expect, it } from 'vitest';

import type { AgentPolicy } from '../../contracts/agents';
import { withStoredConnectorIds } from '../agents/policy';
import type { AgentRunResourceLoader, AgentRunResourceSelection } from './resource-loader';
import { withLegacyNameRules } from './run-request-legacy-name-rules';
import { createToolConnectorsFixture } from './run-request.tool-connectors.fixture.test-support';

const TRACKER = '00000000-0000-4000-8000-0000000000e1';
const TOOL_CONNECTOR = '00000000-0000-4000-8000-0000000000e2';
const byId = (tool: string) => `mcp__connector-${TRACKER}__${tool}`;

const { MCP_ENTRY, compose } = createToolConnectorsFixture();

function claudePolicy(rules: {
  readonly base?: readonly string[];
  readonly autoApprove?: readonly string[];
  readonly deny?: readonly string[];
}): AgentPolicy {
  return {
    engine: 'claude-agent-sdk',
    tools: {
      base: rules.base === undefined ? 'claude_code_preset' : [...rules.base],
      autoApprove: [...(rules.autoApprove ?? [])],
      deny: [...(rules.deny ?? [])],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };
}

/** A run of the MCP connector `TRACKER`, named `name` and keyed `key`, and maybe a tool connector. */
function runOf(
  name: string,
  key: string,
  toolConnectors?: AgentRunResourceSelection['toolConnectors'],
): AgentRunResourceLoader {
  return {
    load: () =>
      Promise.resolve({
        files: [],
        skills: [],
        mcpServers: { [key]: MCP_ENTRY },
        connectorNames: { [key]: name },
        connectorKeys: { [TRACKER]: key },
        ...(toolConnectors === undefined ? {} : { toolConnectors }),
      }),
  };
}

/** The #1109 fallback: a tool connector takes the key `tracker`, so the MCP connector is keyed by id. */
const fallbackRun = () =>
  runOf('tracker', `connector-${TRACKER}`, [
    { key: 'tracker', name: 'Tracker', connectorId: TOOL_CONNECTOR, operationNames: ['list'] },
  ]);

/** The Claude arm compose hands the engine. */
async function toolsOf(loader: AgentRunResourceLoader, policy: AgentPolicy, tools = false) {
  const request = await compose(loader, tools ? () => Promise.resolve() : undefined, policy);
  return { request, compiled: compileRunRequest(request) };
}

describe('a tool rule an older version stored by connector name (#2446)', () => {
  it('still denies after the connector is renamed, once saved by id', async () => {
    const saved = withStoredConnectorIds(
      claudePolicy({ deny: ['mcp__tracker__delete'] }),
      new Map([['tracker', TRACKER]]),
    );
    const { compiled } = await toolsOf(runOf('tickets', 'tickets'), saved);
    expect(compiled.disallowedTools).toContain('mcp__tickets__delete');
  });

  it('denies the MCP connector it was written for under the #1109 fallback, and the tool connector too', async () => {
    const { compiled } = await toolsOf(
      fallbackRun(),
      claudePolicy({ deny: ['mcp__tracker__delete'] }),
      true,
    );
    expect(compiled.disallowedTools).toEqual(
      expect.arrayContaining([byId('delete'), 'mcp__tracker__delete']),
    );
  });

  it('does not move an auto-approval to the tool connector that took the name (#1109)', async () => {
    const { request, compiled } = await toolsOf(
      fallbackRun(),
      claudePolicy({ autoApprove: ['mcp__tracker__create_task', 'Read'] }),
      true,
    );
    const arm = JSON.stringify(request.policy);
    expect(arm).not.toContain('mcp__tracker__create_task');
    expect(arm).not.toContain(byId('create_task'));
    expect(compiled.allowedTools).not.toContain('mcp__tracker__create_task');
    expect(compiled.allowedTools).toContain('Read');
  });

  it('drops a tools.base entry whose key now belongs to another server, as it drops an auto-approval', async () => {
    const { compiled } = await toolsOf(
      fallbackRun(),
      claudePolicy({ base: ['Read', 'mcp__tracker__create_task'] }),
      true,
    );
    expect(compiled.tools).toContain('Read');
    expect(compiled.tools).not.toContain('mcp__tracker__create_task');
    expect(compiled.tools).not.toContain(byId('create_task'));
  });

  it('keeps an auto-approval and a deny on a connector that still has its name as its key', async () => {
    const { compiled } = await toolsOf(
      runOf('tracker', 'tracker'),
      claudePolicy({ autoApprove: ['mcp__tracker__list'], deny: ['mcp__tracker__delete'] }),
    );
    expect(compiled.allowedTools).toContain('mcp__tracker__list');
    expect(compiled.disallowedTools).toContain('mcp__tracker__delete');
  });
});

describe('withLegacyNameRules', () => {
  const tools = claudePolicy({
    autoApprove: ['mcp__pets__list', 'mcp__tracker__list', byId('get'), 'Read'],
    deny: ['mcp__tracker__delete(/tmp/**)', 'mcp__mailer__send', 'Bash'],
  });
  const resources = {
    mcpServers: { [`connector-${TRACKER}`]: MCP_ENTRY },
    connectorNames: { [`connector-${TRACKER}`]: 'tracker' },
  };

  it('keeps a grant on a name no MCP connector of the run has (a tool connector key), and a rule by id', () => {
    if (!('tools' in tools)) throw new Error('not the Claude arm');
    expect(withLegacyNameRules(tools.tools, resources).autoApprove).toEqual([
      'mcp__pets__list',
      byId('get'),
      'Read',
    ]);
  });

  it('adds the connector key to a deny, keeping its specifier, and leaves other denies', () => {
    if (!('tools' in tools)) throw new Error('not the Claude arm');
    expect(withLegacyNameRules(tools.tools, resources).deny).toEqual([
      'mcp__tracker__delete(/tmp/**)',
      `${byId('delete')}(/tmp/**)`,
      'mcp__mailer__send',
      'Bash',
    ]);
  });
});
