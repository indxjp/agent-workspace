import { describe, expect, it } from 'vitest';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

import { diffBodies, uncoveredKeys } from './index.js';

type Definition = AgentVersionBody['definition'];

function definitionBody(
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

const BASE = definitionBody();

/** `BASE` with `tools` fields replaced and top-level keys added. */
function withTools(
  tools: Record<string, unknown>,
  top: Partial<Pick<AgentVersionBody, 'description' | 'subagents' | 'knowledge'>> = {},
): AgentVersionBody {
  const { policy } = BASE.definition;
  if (!('tools' in policy)) throw new Error('the fixture is a tool-rules policy');
  return {
    ...BASE,
    ...top,
    definition: { ...BASE.definition, policy: { ...policy, tools: { ...policy.tools, ...tools } } },
  };
}
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('diffBodies', () => {
  it('is empty for an unchanged body', () => {
    expect(diffBodies(BASE, definitionBody())).toEqual([]);
  });

  it('reports every field of a new agent as a change with no before', () => {
    const changes = diffBodies(null, BASE);
    expect(changes.map((change) => change.section)).toEqual(
      expect.arrayContaining(['model', 'runtime', 'resources', 'permissions', 'instructions']),
    );
    expect(changes.every((change) => !('before' in change))).toBe(true);
    expect(changes).toContainEqual({
      section: 'resources',
      path: 'definition.resources.files["receipts/"]',
      after: 'read',
    });
    expect(changes.filter(({ section }) => section === 'description')).toEqual([]);
  });

  it.each([
    [
      'a flipped permission',
      definitionBody({
        agent: {
          permissions: {
            readFiles: true,
            writeFiles: true,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
      }),
      {
        section: 'permissions',
        path: 'definition.agent.permissions.writeFiles',
        before: false,
        after: true,
      },
    ],
    [
      'a model change',
      definitionBody({ agent: { model: 'claude-opus-5' } }),
      {
        section: 'model',
        path: 'definition.agent.model',
        before: 'claude-sonnet-5',
        after: 'claude-opus-5',
      },
    ],
    [
      'new instructions',
      definitionBody({ agent: { instructions: 'Ask for the receipt first.' } }),
      {
        section: 'instructions',
        path: 'definition.agent.instructions',
        before: 'Help people file expense refunds.',
        after: 'Ask for the receipt first.',
      },
    ],
    [
      'a file grant widened to read-write',
      definitionBody({ resources: { files: [{ path: 'receipts/', access: 'read-write' }] } }),
      {
        section: 'resources',
        path: 'definition.resources.files["receipts/"]',
        before: 'read',
        after: 'read-write',
      },
    ],
    [
      'an added skill',
      definitionBody({ resources: { skills: ['triage'] } }),
      { section: 'resources', path: 'definition.resources.skills["triage"]', after: true },
    ],
    [
      'a removed file grant',
      definitionBody({ resources: { files: [] } }),
      {
        section: 'resources',
        path: 'definition.resources.files["receipts/"]',
        before: 'read',
        after: undefined,
      },
    ],
  ])('reports %s', (_name, after, expected) => {
    expect(diffBodies(BASE, after)).toEqual([expected]);
  });

  it('reports a tool bundle digest change', () => {
    const before = definitionBody({ toolBundles: [{ tool: 'lookup', digest: DIGEST_A }] });
    const after = definitionBody({ toolBundles: [{ tool: 'lookup', digest: DIGEST_B }] });
    expect(diffBodies(before, after)).toEqual([
      { section: 'tools', path: 'toolBundles["lookup"]', before: DIGEST_A, after: DIGEST_B },
    ]);
  });

  it.each([
    [{ allowedDomains: ['api.example.com'] }, 'allowedDomains["api.example.com"]'],
    [{ secrets: ['ERP_TOKEN'] }, 'secrets["ERP_TOKEN"]'],
  ])('reports %j added under an unchanged digest', (extra, leaf) => {
    const bundle = { tool: 'lookup', digest: DIGEST_A };
    const before = definitionBody({ toolBundles: [bundle] });
    const after = definitionBody({ toolBundles: [{ ...bundle, ...extra }] });
    expect(diffBodies(before, after)).toEqual([
      { section: 'tools', path: `toolBundles["lookup"].${leaf}`, after: true },
    ]);
  });

  it('reports a changed pinned skill revision', () => {
    const pinned = (revision: number) =>
      definitionBody({ resources: { skills: ['triage'], skillRevisions: { triage: revision } } });
    expect(diffBodies(pinned(1), pinned(2))).toEqual([
      {
        section: 'resources',
        path: 'definition.resources.skills["triage"].revision',
        before: 1,
        after: 2,
      },
    ]);
  });

  it('keeps both entries of a repeated file path', () => {
    const files = [
      { path: 'a/', access: 'read' },
      { path: 'a/', access: 'read-write' },
    ] as const;
    const paths = diffBodies(BASE, definitionBody({ resources: { files } })).map((c) => c.path);
    expect(paths).toContain('definition.resources.files["a/"]#2');
  });

  it('orders changes by section, then path', () => {
    const after = definitionBody({
      agent: { model: 'claude-opus-5', instructions: 'Changed.' },
      resources: { skills: ['triage'], connectors: [] },
    });
    expect(diffBodies(BASE, after).map(({ section, path }) => `${section} ${path}`)).toEqual([
      'model definition.agent.model',
      'resources definition.resources.connectors["erp"]',
      'resources definition.resources.skills["triage"]',
      'instructions definition.agent.instructions',
    ]);
  });

  it('does not diff fields outside its sections', () => {
    const renamed = definitionBody({ agent: { name: 'refunds-v2' } });
    expect(diffBodies(BASE, renamed)).toEqual([]);
  });

  it('lists a dangerous policy change, a subagent, knowledge and a description', () => {
    const after = withTools(
      { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
      {
        description: 'Files expense refunds.',
        subagents: [{ name: 'receipt-reader' }],
        knowledge: [
          { kind: 'files', paths: ['receipts/'] },
          { kind: 'connector', name: 'erp' },
        ],
      },
    );
    expect(diffBodies(BASE, after)).toEqual([
      {
        section: 'policy',
        path: 'definition.policy.tools.allowDangerouslySkipPermissions',
        before: false,
        after: true,
      },
      {
        section: 'policy',
        path: 'definition.policy.tools.permissionMode',
        before: 'default',
        after: 'bypassPermissions',
      },
      { section: 'subagents', path: 'subagents["receipt-reader"]', after: true },
      { section: 'knowledge', path: 'knowledge.connectors["erp"]', after: true },
      { section: 'knowledge', path: 'knowledge.files["receipts/"]', after: true },
      { section: 'description', path: 'description', after: 'Files expense refunds.' },
    ]);
  });

  it('lists an auto-approved rule, and a removed subagent', () => {
    const before = withTools({}, { subagents: [{ name: 'receipt-reader' }] });
    const after = withTools({ autoApprove: ['Bash(git status)'] });
    expect(diffBodies(before, after)).toEqual([
      {
        section: 'policy',
        path: 'definition.policy.tools.autoApprove["Bash(git status)"]',
        after: true,
      },
      { section: 'subagents', path: 'subagents["receipt-reader"]', before: true, after: undefined },
    ]);
  });

  it('adds no policy change for an engine without tool rules', () => {
    const { definition } = BASE;
    const withheld = {
      ...BASE,
      definition: {
        ...definition,
        policy: {
          engine: 'openai-agents' as const,
          withheldPermissions: [],
          skills: { mode: 'all' as const },
          limits: { maxTurns: null, maxBudgetUsd: null },
        },
      },
    };
    expect(diffBodies(withheld, withheld)).toEqual([]);
    expect(diffBodies(null, withheld).filter(({ section }) => section === 'policy')).toEqual([]);
  });
});

describe('diffBodies on the tool deny list and base', () => {
  const DENIED = withTools({ deny: ['WebFetch'] });
  const NARROW = withTools({ base: ['Read'] });
  it.each([
    [
      'removes a hard deny',
      DENIED,
      BASE,
      'definition.policy.tools.deny["WebFetch"]',
      true,
      undefined,
    ],
    ['adds a hard deny', BASE, DENIED, 'definition.policy.tools.deny["WebFetch"]', undefined, true],
    [
      'widens base to the preset',
      NARROW,
      BASE,
      'definition.policy.tools.base',
      undefined,
      'claude_code_preset',
    ],
    [
      'narrows base to a list',
      BASE,
      NARROW,
      'definition.policy.tools.base',
      'claude_code_preset',
      undefined,
    ],
  ])('lists a change that %s, with its values', (_name, before, after, path, was, now) => {
    const rows = diffBodies(before, after).filter(({ section }) => section === 'policy');
    expect(rows).toContainEqual({
      section: 'policy',
      path,
      ...(was === undefined ? {} : { before: was }),
      after: now,
    });
    expect(uncoveredKeys(before, after)).toEqual([]);
  });
});

describe('uncoveredKeys', () => {
  it.each([
    ['a permission mode', withTools({ permissionMode: 'plan' })],
    ['a dangerous flag', withTools({ allowDangerouslySkipPermissions: true })],
    ['an auto-approved rule', withTools({ autoApprove: ['Read'] })],
    ['a subagent', withTools({}, { subagents: [{ name: 'x' }] })],
    ['knowledge', withTools({}, { knowledge: [{ kind: 'connector', name: 'erp' }] })],
    ['a description', withTools({}, { description: 'What it is for.' })],
    ['an instruction', definitionBody({ agent: { instructions: 'Other.' } })],
  ])('says nothing for %s, which diffBodies lists', (_name, after) => {
    expect(diffBodies(BASE, after)).not.toEqual([]);
    expect(uncoveredKeys(BASE, after)).toEqual([]);
  });

  it('names what no section lists', () => {
    const limits = { maxTurns: 5, maxBudgetUsd: null };
    const { policy } = BASE.definition;
    const after = {
      ...BASE,
      definition: { ...BASE.definition, policy: { ...policy, limits } },
    };
    expect(uncoveredKeys(BASE, after)).toEqual(['policy']);
    expect(uncoveredKeys(BASE, definitionBody({ agent: { name: 'refunds-v2' } }))).toEqual([
      'name',
    ]);
    expect(uncoveredKeys(BASE, BASE)).toEqual([]);
  });
});
