/**
 * An approval gate keeps guarding its connector's write whatever key the connector has in the run
 * (#2439): a save stores the gate by connector id, compose points an id gate, and a gate an older
 * version stored by name, at the run's key, and a gate on a connector of the run that still names
 * none of its servers refuses the run instead of being dropped.
 */
import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { describe, expect, it } from 'vitest';

import type { AgentPolicy } from '../../contracts/agents';
import { withStoredConnectorIds } from '../agents/policy';
import { DomainError } from '../errors';
import type { AgentRunResourceLoader, AgentRunResourceSelection } from './resource-loader';
import { approvalGatesForRun } from './run-request-approval-gates';
import { createToolConnectorsFixture } from './run-request.tool-connectors.fixture.test-support';

const TRACKER = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';
const ABSENT = '00000000-0000-4000-8000-0000000000d3';
const TOOL_CONNECTOR = '00000000-0000-4000-8000-0000000000d4';
const byId = (id: string, tool: string) => `mcp__connector-${id}__${tool}`;

const { MCP_ENTRY, compose } = createToolConnectorsFixture();

/** A Claude policy with these gates and auto-approvals, nothing else narrowed. */
function claudePolicy(rules: {
  readonly requireApproval: readonly string[];
  readonly autoApprove?: readonly string[];
}): AgentPolicy {
  return {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [...(rules.autoApprove ?? [])],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    requireApproval: [...rules.requireApproval],
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };
}

/** The policy as a save stores it while `TRACKER` is named `tracker`. */
const savedWhileNamedTracker = (rules: Parameters<typeof claudePolicy>[0]): AgentPolicy =>
  withStoredConnectorIds(claudePolicy(rules), new Map([['tracker', TRACKER]]));

/** A run of MCP connectors (id to name and run key), and of tool connectors when given. */
function runOf(
  connectors: readonly { readonly id: string; readonly name: string; readonly key: string }[],
  toolConnectors?: AgentRunResourceSelection['toolConnectors'],
): AgentRunResourceLoader {
  return {
    load: () =>
      Promise.resolve({
        files: [],
        skills: [],
        mcpServers: Object.fromEntries(connectors.map(({ key }) => [key, MCP_ENTRY])),
        connectorNames: Object.fromEntries(connectors.map(({ key, name }) => [key, name])),
        connectorKeys: Object.fromEntries(connectors.map(({ id, key }) => [id, key])),
        ...(toolConnectors === undefined ? {} : { toolConnectors }),
      }),
  };
}

/** What the Claude adapter compiles for the run `loader` composes. */
async function compiledOf(
  loader: AgentRunResourceLoader,
  policy: AgentPolicy,
  withToolConnectors = false,
) {
  const request = await compose(
    loader,
    withToolConnectors ? () => Promise.resolve() : undefined,
    policy,
  );
  return compileRunRequest(request);
}

/** The gates the Claude adapter asks a person about, for the run `loader` composes. */
async function gatesOf(
  loader: AgentRunResourceLoader,
  policy: AgentPolicy,
  withToolConnectors = false,
) {
  return (await compiledOf(loader, policy, withToolConnectors)).approval;
}

describe('an approval gate on an MCP connector follows the connector (#2439)', () => {
  it('is stored by the connector id when written by its name', () => {
    const stored = savedWhileNamedTracker({
      requireApproval: ['mcp__tracker__create_task', 'Write'],
    });
    expect('tools' in stored && stored.requireApproval).toEqual([
      byId(TRACKER, 'create_task'),
      'Write',
    ]);
  });

  it('still makes the write wait after the connector is renamed', async () => {
    const approval = await gatesOf(
      runOf([{ id: TRACKER, name: 'tickets', key: 'tickets' }]),
      savedWhileNamedTracker({ requireApproval: ['mcp__tracker__create_task'] }),
    );
    expect(approval?.requireApproval).toContain('mcp__tickets__create_task');
  });

  it('still makes the write wait when a same-named tool connector sends it to connector-<id> (#1109)', async () => {
    const approval = await gatesOf(
      runOf(
        [{ id: TRACKER, name: 'tracker', key: `connector-${TRACKER}` }],
        [
          {
            key: 'tracker',
            name: 'Tracker',
            connectorId: TOOL_CONNECTOR,
            operationNames: ['list'],
          },
        ],
      ),
      savedWhileNamedTracker({ requireApproval: ['mcp__tracker__create_task'] }),
      true,
    );
    expect(approval?.requireApproval).toContain(byId(TRACKER, 'create_task'));
  });

  it('does not hand a gate to another connector that takes the old name, and keeps its own', async () => {
    const approval = await gatesOf(
      runOf([
        { id: TRACKER, name: 'tickets', key: 'tickets' },
        { id: OTHER, name: 'tracker', key: 'tracker' },
      ]),
      savedWhileNamedTracker({ requireApproval: ['mcp__tracker__*'] }),
    );
    expect(approval?.requireApproval).toEqual(['mcp__tickets__*']);
  });

  describe('a gate a version saved before #2439 stored by name', () => {
    const legacy = claudePolicy({ requireApproval: ['mcp__tracker__create_task'] });

    it('is pointed at the connector-<id> key the connector of that name falls back to', async () => {
      const approval = await gatesOf(
        runOf(
          [{ id: TRACKER, name: 'tracker', key: `connector-${TRACKER}` }],
          [{ key: 'tracker', name: 'Tracker', connectorId: TOOL_CONNECTOR, operationNames: ['x'] }],
        ),
        legacy,
        true,
      );
      // Kept as written too, so the tool connector now keyed `tracker` is gated as well.
      expect(approval?.requireApproval).toEqual(
        expect.arrayContaining([byId(TRACKER, 'create_task'), 'mcp__tracker__create_task']),
      );
    });

    it('is left as it is while the connector keeps its name as its key', async () => {
      const approval = await gatesOf(
        runOf([{ id: TRACKER, name: 'tracker', key: 'tracker' }]),
        legacy,
      );
      expect(approval?.requireApproval).toEqual(['mcp__tracker__create_task']);
    });
  });

  it('never lets an auto-approval of the connector skip the gate once both name the run key', async () => {
    const autoApprove = [byId(TRACKER, '*'), byId(TRACKER, 'create_task')];
    const { allowedTools, approval } = await compiledOf(
      runOf(
        [{ id: TRACKER, name: 'tracker', key: `connector-${TRACKER}` }],
        [{ key: 'tracker', name: 'Tracker', connectorId: TOOL_CONNECTOR, operationNames: ['x'] }],
      ),
      claudePolicy({ requireApproval: ['mcp__tracker__create_task'], autoApprove }),
      true,
    );
    expect(approval?.requireApproval).toContain(byId(TRACKER, 'create_task'));
    // The adapter moved both out of `allowedTools`: `canUseTool` decides, and asks for the gate.
    expect(approval?.deferred).toEqual(expect.arrayContaining(autoApprove));
    for (const rule of autoApprove) expect(allowedTools).not.toContain(rule);
  });

  it('keeps a gate for a connector the run does not have, which guards nothing there', async () => {
    const approval = await gatesOf(
      runOf([{ id: TRACKER, name: 'tracker', key: 'tracker' }]),
      claudePolicy({ requireApproval: [byId(ABSENT, 'send'), 'mcp__mailer__send'] }),
    );
    expect(approval?.requireApproval).toEqual([byId(ABSENT, 'send'), 'mcp__mailer__send']);
  });

  it('refuses the run when a gate on a connector of the run names none of its servers', async () => {
    // A key map that has drifted from the servers the run serves: the gate would guard nothing.
    const loader: AgentRunResourceLoader = {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: { [`connector-${TRACKER}`]: MCP_ENTRY },
          connectorNames: { [`connector-${TRACKER}`]: 'tracker' },
          connectorKeys: { [TRACKER]: 'tracker' },
        }),
    };
    const refusal: unknown = await compose(
      loader,
      undefined,
      claudePolicy({ requireApproval: [byId(TRACKER, 'create_task')] }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({
      code: 'approval_gate_unresolved',
      publicMessage: expect.stringMatching(/^approval_gate_unresolved: /u) as unknown,
    });
  });
});

describe('approvalGatesForRun', () => {
  const served = { [`connector-${TRACKER}`]: MCP_ENTRY, docs: MCP_ENTRY };
  const resources = {
    mcpServers: served,
    connectorNames: { [`connector-${TRACKER}`]: 'tracker', docs: 'docs' },
    connectorKeys: { [TRACKER]: `connector-${TRACKER}`, [OTHER]: 'docs' },
  };

  it('leaves a gate on no connector as it is', () => {
    expect(approvalGatesForRun(['Write', 'Bash', 'agent__reviewer'], resources)).toEqual([
      'Write',
      'Bash',
      'agent__reviewer',
    ]);
  });

  it('points id and name gates at the run key, and keeps a name gate as written', () => {
    expect(
      approvalGatesForRun([byId(OTHER, 'post'), 'mcp__tracker__create_task'], resources),
    ).toEqual(['mcp__docs__post', 'mcp__tracker__create_task', byId(TRACKER, 'create_task')]);
  });

  it('does not count a connector the policy ceiling left out of the run as served', () => {
    expect(
      approvalGatesForRun([byId(TRACKER, 'create_task')], {
        ...resources,
        mcpServers: { docs: MCP_ENTRY },
        connectorKeys: { [TRACKER]: 'tracker' },
      }),
    ).toEqual(['mcp__tracker__create_task']);
  });
});
