import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import {
  AW_CONTROL_SERVER,
  BUILDER_DEFAULT_LIMITS,
  BUILDER_REFUSAL_CODES,
  BUILDER_TOOLS,
  type BuilderRefusalCode,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';

import { versionRequest } from '../../agent-versions/fixtures.js';
import type { ToolCall } from './call.js';
import { decide } from './decide.js';
import { tallyRun, type Facts, type JournalRow } from './facts.js';
import { approvalQuestion, RULES } from './rules.js';

const AGENT_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

function bodyNaming(connectors: readonly string[]) {
  return AgentVersionBodySchema.parse(versionRequest({ resources: { connectors } }).body);
}

const EVAL_CASE = { name: 'a', input: 'Where is order 1?', expect: { contains: ['ok'] } };

function callOf(tool: BuilderToolName, connectors: readonly string[] = []): ToolCall {
  const callId = 'call-1';
  switch (tool) {
    case 'catalog_list':
      return { tool, callId, input: {} };
    case 'examples_get':
      return { tool, callId, input: {} };
    case 'draft_check':
      return { tool, callId, input: { body: bodyNaming(connectors) } };
    case 'draft_save':
      return { tool, callId, input: { body: bodyNaming(connectors) } };
    case 'evals_run':
      return { tool, callId, input: { agentId: AGENT_ID, version: 1, cases: [EVAL_CASE] } };
    case 'trial_run':
      return { tool, callId, input: { agentId: AGENT_ID, version: 1, input: 'hello' } };
    default: {
      const unhandled: never = tool;
      return unhandled;
    }
  }
}

const BUILDER_CREATOR: Facts['creator'] = { kind: 'builder' };

function factsWith(overrides: Partial<Facts> = {}): Facts {
  return {
    enabled: true,
    caller: { kind: 'person', role: 'builder' },
    access: 'allowed',
    approval: 'granted',
    local: { version: null },
    run: { toolCalls: 0, failedChecksInARow: 0 },
    limits: BUILDER_DEFAULT_LIMITS,
    creator: BUILDER_CREATOR,
    creationsToday: 0,
    target: null,
    ...overrides,
  };
}

function refusal(code: BuilderRefusalCode): unknown {
  return expect.objectContaining({ kind: 'refuse', code });
}

function rows(tool: BuilderToolName, outcome: JournalRow['outcome'], count: number): JournalRow[] {
  return Array.from({ length: count }, () => ({ tool, outcome }));
}

const { maxFailedChecksInARow, maxToolCallsPerRun } = BUILDER_DEFAULT_LIMITS;

it("a Viewer's draft_save is refused not_permitted", () => {
  const decision = decide(
    callOf('draft_save'),
    factsWith({ caller: { kind: 'person', role: 'viewer' }, access: 'not_permitted' }),
  );
  expect(decision).toMatchObject({ kind: 'refuse', code: 'not_permitted' });
});

describe('rule order', () => {
  it('runs the rules in the contract order', () => {
    expect(RULES.map((rule) => rule.name)).toEqual([
      'featureOff',
      'notAllowedToBuild',
      'noCallerForWrites',
      'externalReadsOnly',
      'access',
      'toolCallLimit',
      'checkLimit',
      'noControlInDrafts',
      'depthLimit',
      'creatorCannotWiden',
      'creatorTargetCannotWiden',
      'quota',
      'approval',
      'pointerMoved',
    ]);
  });

  it.each([
    ['builder_disabled', { enabled: false }],
    ['no_caller', { caller: { kind: 'none' } }],
    ['not_owner', { access: 'not_owner' }],
    ['tool_call_limit_reached', { run: { toolCalls: maxToolCallsPerRun, failedChecksInARow: 0 } }],
  ] as const)('refuses %s before it asks for approval', (code, overrides) => {
    const facts = factsWith({ ...overrides, approval: 'missing' });
    expect(decide(callOf('draft_save'), facts)).toEqual(refusal(code));
  });

  it('refuses a draft naming aw-control before it asks for approval', () => {
    const facts = factsWith({ approval: 'missing' });
    expect(decide(callOf('draft_save', [AW_CONTROL_SERVER]), facts)).toEqual(
      refusal('not_allowed_to_build'),
    );
  });

  it('asks before it refuses a moved pointer', () => {
    const facts = factsWith({ approval: 'missing', local: { version: 2 } });
    expect(decide(existingSave(1), facts)).toEqual({ kind: 'ask', question: 'approve_save' });
  });

  it('refuses a disabled Builder before a missing caller', () => {
    const facts = factsWith({ enabled: false, caller: { kind: 'none' } });
    expect(decide(callOf('draft_save'), facts)).toEqual(refusal('builder_disabled'));
  });

  it('refuses a missing caller before access', () => {
    const facts = factsWith({ caller: { kind: 'none' }, access: 'not_permitted' });
    expect(decide(callOf('draft_save'), facts)).toEqual(refusal('no_caller'));
  });

  it('refuses on access before the tool-call limit', () => {
    const facts = factsWith({
      access: 'not_owner',
      run: { toolCalls: maxToolCallsPerRun, failedChecksInARow: 0 },
    });
    expect(decide(callOf('draft_save'), facts)).toEqual(refusal('not_owner'));
  });

  it('refuses on the tool-call limit before the check limit', () => {
    const facts = factsWith({
      run: { toolCalls: maxToolCallsPerRun, failedChecksInARow: maxFailedChecksInARow },
    });
    expect(decide(callOf('draft_check'), facts)).toEqual(refusal('tool_call_limit_reached'));
  });

  it('refuses on the check limit before a draft naming aw-control', () => {
    const facts = factsWith({ run: { toolCalls: 0, failedChecksInARow: maxFailedChecksInARow } });
    expect(decide(callOf('draft_check', [AW_CONTROL_SERVER]), facts)).toEqual(
      refusal('check_limit_reached'),
    );
  });
});

describe('rule order: approval and pointerMoved come after the B0 rules', () => {
  it('lets the first rule to answer win, whatever the later ones would say', () => {
    const missing = { approval: 'missing' } as const;
    expect(decide(callOf('draft_save'), factsWith({ ...missing, enabled: false }))).toEqual(
      refusal('builder_disabled'),
    );
    expect(decide(callOf('draft_save', [AW_CONTROL_SERVER]), factsWith(missing))).toEqual(
      refusal('not_allowed_to_build'),
    );
    expect(decide(existingSave(1), factsWith({ ...missing, local: { version: 2 } }))).toEqual({
      kind: 'ask',
      question: 'approve_save',
    });
    expect(
      decide(existingSave(1), factsWith({ approval: 'granted', local: { version: 2 } })),
    ).toMatchObject({ kind: 'refuse', code: 'pointer_moved' });
  });
});

describe('feature switch', () => {
  it.each(Object.keys(BUILDER_TOOLS) as BuilderToolName[])(
    'refuses %s with builder_disabled when the Builder is off',
    (tool) => {
      expect(decide(callOf(tool), factsWith({ enabled: false }))).toEqual(
        refusal('builder_disabled'),
      );
    },
  );
});

describe('the Builder gets more power than the person (design §05)', () => {
  type Role = MembershipRoleName | 'none';
  type Kind = (typeof BUILDER_TOOLS)[BuilderToolName]['kind'];
  type Cell = readonly [access: Facts['access'], expected: 'run' | BuilderRefusalCode];

  const RUN: Cell = ['allowed', 'run'];
  const NOT_OWNER: Cell = ['not_owner', 'not_owner'];
  const NOT_PERMITTED: Cell = ['not_permitted', 'not_permitted'];
  const NO_CALLER: Cell = ['not_permitted', 'no_caller'];
  const everywhere = (cell: Cell) => ({ own: cell, other: cell });

  // The access column assumes the caller has no agent_grants row (permissions.ts); a Builder holding a grant
  // can run someone else's agent, and that case is covered by slice 2's permission matrix. The core turns the
  // access answer into a decision.
  const MATRIX: Record<Role, Record<Kind, { own: Cell; other: Cell }>> = {
    owner: { read: everywhere(RUN), write: everywhere(RUN), spend: everywhere(RUN) },
    admin: { read: everywhere(RUN), write: everywhere(RUN), spend: everywhere(RUN) },
    builder: {
      read: everywhere(RUN),
      write: { own: RUN, other: NOT_OWNER },
      spend: { own: RUN, other: NOT_OWNER },
    },
    viewer: {
      read: everywhere(RUN),
      write: everywhere(NOT_PERMITTED),
      spend: everywhere(NOT_PERMITTED),
    },
    none: { read: everywhere(RUN), write: everywhere(NO_CALLER), spend: everywhere(NO_CALLER) },
  };
  const TOOL_OF_KIND: Record<Kind, BuilderToolName> = {
    read: 'draft_check',
    write: 'draft_save',
    spend: 'trial_run',
  };

  const cases = (Object.keys(MATRIX) as Role[]).flatMap((role) =>
    (Object.keys(TOOL_OF_KIND) as Kind[]).flatMap((kind) =>
      (['own', 'other'] as const).map((agent) => ({
        role,
        kind,
        agent,
        cell: MATRIX[role][kind][agent],
      })),
    ),
  );

  it.each(cases)('$role, $kind tool, $agent agent', ({ role, kind, cell: [access, expected] }) => {
    const tool = TOOL_OF_KIND[kind];
    expect(BUILDER_TOOLS[tool].kind).toBe(kind);
    const caller: Facts['caller'] = role === 'none' ? { kind: 'none' } : { kind: 'person', role };
    const decision = decide(callOf(tool), factsWith({ caller, access }));
    expect(decision).toEqual(expected === 'run' ? { kind: 'run', tool } : refusal(expected));
  });
});

describe("the Builder edits someone else's agent (design §05)", () => {
  it('refuses draft_save on an agent the person does not own', () => {
    expect(decide(callOf('draft_save'), factsWith({ access: 'not_owner' }))).toEqual(
      refusal('not_owner'),
    );
  });
});

describe('a document tells an agent to build a stronger one (design §05)', () => {
  it.each(['draft_check', 'draft_save'] as const)(
    'refuses %s whose body names the aw-control server',
    (tool) => {
      expect(decide(callOf(tool, ['erp', AW_CONTROL_SERVER]), factsWith())).toEqual(
        refusal('not_allowed_to_build'),
      );
    },
  );

  it.each(['draft_check', 'draft_save'] as const)(
    'refuses %s whose body spells aw-control with another case or surrounding space',
    (tool) => {
      for (const spelling of ['AW-Control', ' aw-control ', '\taw-CONTROL\n']) {
        expect(decide(callOf(tool, ['erp', spelling]), factsWith()), spelling).toEqual(
          refusal('not_allowed_to_build'),
        );
      }
    },
  );

  it.each(['draft_check', 'draft_save'] as const)(
    'runs %s whose body names other connectors',
    (tool) => {
      expect(decide(callOf(tool, ['erp']), factsWith())).toEqual({ kind: 'run', tool });
    },
  );
});

describe('the run limits (design §04 loop)', () => {
  it.each(['draft_check', 'draft_save'] as const)(
    'refuses %s after the limit of failed checks in a row',
    (tool) => {
      const run = tallyRun(rows('draft_check', 'check_failed', maxFailedChecksInARow));
      expect(decide(callOf(tool), factsWith({ run }))).toEqual(refusal('check_limit_reached'));
    },
  );

  it('runs the check one failure short of the limit', () => {
    const run = tallyRun(rows('draft_check', 'check_failed', maxFailedChecksInARow - 1));
    expect(decide(callOf('draft_check'), factsWith({ run }))).toEqual({
      kind: 'run',
      tool: 'draft_check',
    });
  });

  it('resets the streak when a check passes', () => {
    const run = tallyRun([
      ...rows('draft_check', 'check_failed', maxFailedChecksInARow - 1),
      ...rows('draft_check', 'ok', 1),
      ...rows('draft_check', 'check_failed', maxFailedChecksInARow - 1),
    ]);
    expect(run.failedChecksInARow).toBe(maxFailedChecksInARow - 1);
    expect(decide(callOf('draft_check'), factsWith({ run }))).toEqual({
      kind: 'run',
      tool: 'draft_check',
    });
  });

  it('keeps the streak through the refusals it caused', () => {
    const run = tallyRun([
      ...rows('draft_check', 'check_failed', maxFailedChecksInARow),
      ...rows('draft_check', 'refused', 2),
    ]);
    expect(decide(callOf('draft_check'), factsWith({ run }))).toEqual(
      refusal('check_limit_reached'),
    );
  });

  it('keeps the streak through errors and calls of other tools', () => {
    const run = tallyRun([
      ...rows('draft_check', 'check_failed', maxFailedChecksInARow - 1),
      ...rows('draft_check', 'error', 1),
      ...rows('catalog_list', 'ok', 1),
      ...rows('examples_get', 'ok', 1),
      ...rows('draft_check', 'check_failed', 1),
    ]);
    expect(run.failedChecksInARow).toBe(maxFailedChecksInARow);
  });

  it('does not stop read tools that are not checks', () => {
    const run = tallyRun(rows('draft_check', 'check_failed', maxFailedChecksInARow));
    expect(decide(callOf('catalog_list'), factsWith({ run }))).toEqual({
      kind: 'run',
      tool: 'catalog_list',
    });
  });

  it('counts every journal row as a tool call', () => {
    expect(
      tallyRun([...rows('catalog_list', 'ok', 2), ...rows('draft_check', 'refused', 1)]),
    ).toEqual({
      toolCalls: 3,
      failedChecksInARow: 0,
    });
  });

  it('refuses at the tool-call limit and runs one call short of it', () => {
    const atLimit = tallyRun(rows('catalog_list', 'ok', maxToolCallsPerRun));
    const oneShort = tallyRun(rows('catalog_list', 'ok', maxToolCallsPerRun - 1));
    expect(decide(callOf('catalog_list'), factsWith({ run: atLimit }))).toEqual(
      refusal('tool_call_limit_reached'),
    );
    expect(decide(callOf('catalog_list'), factsWith({ run: oneShort }))).toEqual({
      kind: 'run',
      tool: 'catalog_list',
    });
  });
});

function existingSave(baseVersion: number): ToolCall {
  return {
    tool: 'draft_save',
    callId: 'call-1',
    input: { agentId: AGENT_ID, baseVersion, body: bodyNaming([]) },
  };
}

describe('approval (design §04)', () => {
  it.each([
    ['draft_save', 'approve_save'],
    ['evals_run', 'approve_evals'],
    ['trial_run', 'approve_trial'],
  ] as const)('%s asks %s until the person approved that call', (tool, question) => {
    expect(decide(callOf(tool), factsWith({ approval: 'missing' }))).toEqual({
      kind: 'ask',
      question,
    });
    expect(decide(callOf(tool), factsWith({ approval: 'granted' }))).toEqual({ kind: 'run', tool });
  });

  it('never asks for a read tool, or a tool the shell did not look up', () => {
    for (const tool of ['catalog_list', 'examples_get', 'draft_check'] as const) {
      for (const approval of ['missing', 'not_needed'] as const) {
        expect(decide(callOf(tool), factsWith({ approval }))).toEqual({ kind: 'run', tool });
      }
    }
  });
});

describe('pointerMoved (design §05)', () => {
  it('refuses pointer_moved, naming where local is now, when local is not the base version', () => {
    expect(decide(existingSave(1), factsWith({ local: { version: 2 } }))).toEqual({
      kind: 'refuse',
      code: 'pointer_moved',
      message: BUILDER_REFUSAL_CODES.pointer_moved.fix,
      details: ['current:2'],
    });
    expect(decide(existingSave(1), factsWith({ local: { version: null } }))).toMatchObject({
      code: 'pointer_moved',
      details: ['current:none'],
    });
  });

  it('runs when local is the base version, and for a new agent whatever local says', () => {
    expect(decide(existingSave(2), factsWith({ local: { version: 2 } }))).toEqual({
      kind: 'run',
      tool: 'draft_save',
    });
    expect(decide(callOf('draft_save'), factsWith({ local: { version: 7 } }))).toEqual({
      kind: 'run',
      tool: 'draft_save',
    });
  });
});

const creatorOf = (
  connectors: readonly string[],
  flags: { allowedToBuild?: boolean; madeByAgent?: boolean } = {},
): Facts['creator'] => ({
  kind: 'agent',
  body: bodyNaming(connectors),
  allowedToBuild: true,
  madeByAgent: false,
  ...flags,
});

const targetOf = (connectors: readonly string[]): Facts['target'] => ({
  body: bodyNaming(connectors),
});

describe('the external door (#1851)', () => {
  const external = factsWith({ creator: { kind: 'external' } });

  it.each(Object.keys(BUILDER_TOOLS) as BuilderToolName[])(
    'externalReadsOnly decides %s by its kind',
    (tool) => {
      const decision = decide(callOf(tool), external);
      if (BUILDER_TOOLS[tool].kind === 'read') expect(decision).toEqual({ kind: 'run', tool });
      else expect(decision).toEqual(refusal('read_only_client'));
    },
  );
});

describe('agents that build agents (design §04, #1851)', () => {
  const tools = Object.keys(BUILDER_TOOLS) as BuilderToolName[];
  const runs = (tool: BuilderToolName) => ({ kind: 'run', tool });

  it.each(tools)('notAllowedToBuild refuses %s for a creator that may not build', (tool) => {
    const facts = factsWith({ creator: creatorOf([], { allowedToBuild: false }) });
    expect(decide(callOf(tool), facts)).toEqual(refusal('not_allowed_to_build'));
    const allowed = factsWith({ creator: creatorOf([]), target: targetOf([]) });
    expect(decide(callOf(tool), allowed)).toEqual(runs(tool));
    expect(decide(callOf(tool), factsWith())).toEqual(runs(tool));
  });

  it.each(tools)('depthLimit refuses %s only when it is not a read tool', (tool) => {
    const facts = factsWith({ creator: creatorOf([], { madeByAgent: true }) });
    expect(decide(callOf(tool), facts)).toEqual(
      BUILDER_TOOLS[tool].kind === 'read' ? runs(tool) : refusal('depth_limit'),
    );
  });

  it('creatorCannotWiden refuses a draft that gives more, listing paths and no creator values', () => {
    const facts = factsWith({ creator: creatorOf(['hr']) });
    const decision = decide(callOf('draft_save', ['erp']), facts);
    expect(decision).toEqual({
      kind: 'refuse',
      code: 'creator_cannot_widen',
      message: BUILDER_REFUSAL_CODES.creator_cannot_widen.fix,
      details: ['definition.resources.connectors["erp"]'],
    });
    expect(JSON.stringify(decision)).not.toContain('hr');
    expect(decide(callOf('draft_check', ['erp']), facts)).toMatchObject({
      code: 'creator_cannot_widen',
    });
  });

  it('creatorCannotWiden runs a draft within the creator, and ignores tools without a body', () => {
    const facts = factsWith({ creator: creatorOf(['hr', 'erp']) });
    expect(decide(callOf('draft_save', ['hr']), facts)).toEqual(runs('draft_save'));
    expect(decide(callOf('catalog_list'), facts)).toEqual(runs('catalog_list'));
  });

  describe.each(['trial_run', 'evals_run'] as const)('creatorTargetCannotWiden on %s', (tool) => {
    const creator = creatorOf(['hr']);

    it('refuses a target wider than the creator, paths only', () => {
      const decision = decide(callOf(tool), factsWith({ creator, target: targetOf(['erp']) }));
      expect(decision).toEqual({
        kind: 'refuse',
        code: 'creator_cannot_widen',
        message: BUILDER_REFUSAL_CODES.creator_cannot_widen.fix,
        details: ['definition.resources.connectors["erp"]'],
      });
      expect(JSON.stringify(decision)).not.toContain('hr');
    });

    it('runs a target no wider than the creator', () => {
      expect(decide(callOf(tool), factsWith({ creator, target: targetOf(['hr']) }))).toEqual(
        runs(tool),
      );
      expect(decide(callOf(tool), factsWith({ creator, target: targetOf([]) }))).toEqual(
        runs(tool),
      );
    });

    it('refuses a target that was not resolved, so a missing answer never skips the rule', () => {
      expect(decide(callOf(tool), factsWith({ creator, target: null }))).toEqual(
        refusal('creator_cannot_widen'),
      );
    });

    it('refuses before it asks, and leaves the Builder to its question and an outside client to its own refusal', () => {
      const missing = { approval: 'missing', target: targetOf(['erp']) } as const;
      expect(decide(callOf(tool), factsWith({ ...missing, creator }))).toEqual(
        refusal('creator_cannot_widen'),
      );
      const builder = factsWith({ ...missing, creator: { kind: 'builder' } });
      expect(decide(callOf(tool), builder)).toEqual({
        kind: 'ask',
        question: approvalQuestion(tool),
      });
      // An outside client is stopped by its own rule, not asked and not told the target is wide.
      const external = factsWith({ ...missing, creator: { kind: 'external' } });
      expect(decide(callOf(tool), external)).toEqual(refusal('read_only_client'));
    });
  });

  it('creatorCannotWiden lists at most 50 paths', () => {
    const many = Array.from({ length: 60 }, (_, i) => `server-${String(i).padStart(2, '0')}`);
    const decision = decide(callOf('draft_save', many), factsWith({ creator: creatorOf([]) }));
    expect(decision).toMatchObject({ code: 'creator_cannot_widen' });
    expect(decision.kind === 'refuse' ? decision.details : []).toHaveLength(50);
  });

  it('quota refuses only a save of a new agent, at the daily limit', () => {
    const limit = BUILDER_DEFAULT_LIMITS.creationsPerWorkspacePerDay;
    expect(decide(callOf('draft_save'), factsWith({ creationsToday: limit }))).toEqual(
      refusal('quota_exceeded'),
    );
    expect(decide(callOf('draft_save'), factsWith({ creationsToday: limit - 1 }))).toEqual(
      runs('draft_save'),
    );
    const existing = factsWith({ creationsToday: limit, local: { version: 1 } });
    expect(decide(existingSave(1), existing)).toEqual(runs('draft_save'));
    expect(decide(callOf('draft_check'), existing)).toEqual(runs('draft_check'));
  });

  describe('order', () => {
    const quotaSpent = BUILDER_DEFAULT_LIMITS.creationsPerWorkspacePerDay;

    it('notAllowedToBuild beats every rule after featureOff, even a refusal of access', () => {
      const creator = creatorOf([], { allowedToBuild: false, madeByAgent: true });
      expect(decide(callOf('draft_save', ['erp']), factsWith({ creator }))).toEqual(
        refusal('not_allowed_to_build'),
      );
      const others = factsWith({ creator, caller: { kind: 'none' }, access: 'not_owner' });
      expect(decide(callOf('draft_save'), others)).toEqual(refusal('not_allowed_to_build'));
    });

    it('depthLimit beats creatorCannotWiden', () => {
      const creator = creatorOf([], { madeByAgent: true });
      expect(decide(callOf('draft_save', ['erp']), factsWith({ creator }))).toEqual(
        refusal('depth_limit'),
      );
    });

    it('creatorCannotWiden beats quota', () => {
      const facts = factsWith({ creator: creatorOf([]), creationsToday: quotaSpent });
      expect(decide(callOf('draft_save', ['erp']), facts)).toEqual(refusal('creator_cannot_widen'));
      expect(decide(callOf('draft_save'), facts)).toEqual(refusal('quota_exceeded'));
    });
  });

  it('refuses before it asks: a refused call is never paused for approval', () => {
    const missing = { approval: 'missing' } as const;
    const refused = (code: BuilderRefusalCode, call: ToolCall, facts: Partial<Facts>) =>
      expect(decide(call, factsWith({ ...missing, ...facts }))).toEqual(refusal(code));

    refused('not_allowed_to_build', callOf('draft_save'), {
      creator: creatorOf([], { allowedToBuild: false }),
    });
    refused('depth_limit', callOf('trial_run'), { creator: creatorOf([], { madeByAgent: true }) });
    refused('creator_cannot_widen', callOf('draft_save', ['erp']), { creator: creatorOf([]) });
    refused('quota_exceeded', callOf('draft_save'), {
      creationsToday: BUILDER_DEFAULT_LIMITS.creationsPerWorkspacePerDay,
    });
    expect(decide(callOf('draft_save'), factsWith(missing))).toEqual({
      kind: 'ask',
      question: 'approve_save',
    });
  });

  // Decision 7: the new rules only add refusals; they never turn a refusal or a question into a run.
  it('[US-BLD-07][unit][sdk] only adds refusals to what the earlier rules decide', () => {
    const connectors = fc.subarray(['erp', 'hr', 'crm']);
    const agentCreator = fc.record({
      kind: fc.constant('agent' as const),
      body: connectors.map(bodyNaming),
      allowedToBuild: fc.boolean(),
      madeByAgent: fc.boolean(),
    });
    const newCodes: readonly BuilderRefusalCode[] = [
      'not_allowed_to_build',
      'depth_limit',
      'creator_cannot_widen',
      'quota_exceeded',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...tools),
        connectors,
        fc.record({
          enabled: fc.boolean(),
          caller: fc.constantFrom<Facts['caller']>(
            { kind: 'none' },
            { kind: 'person', role: 'builder' },
          ),
          access: fc.constantFrom<Facts['access']>('allowed', 'not_permitted', 'not_owner'),
          approval: fc.constantFrom<Facts['approval']>('granted', 'missing', 'not_needed'),
          local: fc.constantFrom<Facts['local']>({ version: null }, { version: 2 }),
          run: fc.record({ toolCalls: fc.nat(60), failedChecksInARow: fc.nat(8) }),
        }),
        agentCreator,
        fc.nat(40),
        (tool, named, base, creator, creationsToday) => {
          const call = callOf(tool, named);
          const before = decide(call, factsWith(base));
          const after = decide(call, factsWith({ ...base, creator, creationsToday }));
          if (after.kind === 'refuse' && newCodes.includes(after.code)) return;
          expect(after).toEqual(before);
        },
      ),
      { numRuns: 500 },
    );
  });
});
