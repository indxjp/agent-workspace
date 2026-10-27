import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@indx-workspace/sdk/events';

import { definitionBody } from './definition-fixture';
import { builderRefusalIn, draftsFrom } from './definition-from-run';

const ENGINE = 'claude-agent-sdk';

function toolCall(toolCallId: string, name: string, input: unknown): AgentEvent {
  return {
    frame: 'agent.tool.call',
    engine: ENGINE,
    raw: null,
    toolCallId,
    name,
    kind: 'mcp',
    input,
  };
}

function toolResult(toolCallId: string, output: unknown): AgentEvent {
  return {
    frame: 'agent.tool.result',
    engine: ENGINE,
    raw: null,
    toolCallId,
    status: 'completed',
    output: typeof output === 'string' ? output : JSON.stringify(output),
    isError: false,
  };
}

const A = definitionBody();
const B = definitionBody({ agent: { instructions: 'Refund expenses.' } });
const C = definitionBody({
  agent: {
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  },
});
const FAILURE = {
  ok: false,
  code: 'agent_definition_references_missing',
  message: 'missing',
  details: ['connector:erp'],
};

describe('draftsFrom', () => {
  it('follows the latest draft_check / draft_save input, and a failed check keeps its code and details', () => {
    const drafts = draftsFrom([
      toolCall('1', 'mcp__aw-control__draft_check', { body: A }),
      toolResult('1', { ok: true }),
      toolCall('2', 'draft_save', { body: B }),
      toolResult('2', { ok: true }),
      toolCall('3', 'mcp__aw-control__draft_check', { body: C }),
      toolResult('3', FAILURE),
    ]);
    expect(drafts.at(-1)).toEqual({
      source: 'check',
      body: C,
      result: {
        ok: false,
        code: 'agent_definition_references_missing',
        details: ['connector:erp'],
      },
      saved: null,
    });
    expect(drafts.at(-2)).toMatchObject({ source: 'save', body: B, result: { ok: true } });
    expect(drafts).toHaveLength(3);
  });

  it('matches tool names exactly: no case-fold, no trim, no other server', () => {
    expect(
      draftsFrom([
        toolCall('1', 'Draft_Check', { body: A }),
        toolCall('2', ' draft_check', { body: A }),
        toolCall('3', 'mcp__other__draft_check', { body: A }),
        toolCall('4', 'catalog_list', {}),
      ]),
    ).toEqual([]);
  });

  it('has no result yet for a call that was not answered', () => {
    expect(draftsFrom([toolCall('1', 'draft_check', { body: A })])).toEqual([
      { source: 'check', body: A, result: null, saved: null },
    ]);
  });

  it('[US-BLD-05][unit][web] reads what a save saved from its result, with the contracts schema', () => {
    const saved = {
      ok: true,
      agentId: '0b7f4f0e-6a38-4d6c-9d0e-0c7a1f5a8c11',
      version: 2,
      pointer: 'local',
      awCommand: 'aw agents push',
    };
    const savedOf = (output: unknown, tool = 'draft_save') =>
      draftsFrom([toolCall('1', tool, { body: A }), toolResult('1', output)])[0]?.saved;
    expect(savedOf(saved)).toEqual({ agentId: saved.agentId, version: 2 });
    expect(savedOf({ ...saved, version: 0 })).toBeNull();
    expect(savedOf({ ...saved, extra: 1 })).toBeNull();
    expect(savedOf('not json')).toBeNull();
    expect(savedOf({ ok: true })).toBeNull();
    expect(savedOf(saved, 'draft_check')).toBeNull();
  });

  it('skips an input that is not a valid draft and never shows it', () => {
    expect(draftsFrom([toolCall('1', 'draft_check', { body: { definition: 'nope' } })])).toEqual(
      [],
    );
  });

  it('never reads an unreadable result as ok', () => {
    const [draft] = draftsFrom([
      toolCall('1', 'draft_check', { body: A }),
      toolResult('1', 'not json'),
    ]);
    expect(draft?.result).toEqual({ ok: false, code: 'unreadable_result', details: [] });
  });
});

describe('builderRefusalIn', () => {
  it('finds a Builder refusal on an aw-control tool result', () => {
    const events = [
      toolCall('1', 'mcp__aw-control__catalog_list', {}),
      toolResult('1', { ok: false, code: 'builder_disabled', message: 'off' }),
    ];
    expect(builderRefusalIn(events)).toBe('builder_disabled');
  });

  it('ignores the code on a tool that is not aw-control, and any other code', () => {
    expect(
      builderRefusalIn([
        toolCall('1', 'mcp__other__catalog_list', {}),
        toolResult('1', { ok: false, code: 'builder_disabled', message: 'off' }),
        toolCall('2', 'catalog_list', {}),
        toolResult('2', { ok: false, code: 'not_permitted', message: 'no' }),
      ]),
    ).toBeNull();
  });
});
