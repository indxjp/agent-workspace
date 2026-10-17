import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { GoldenVerdict } from './verdicts.mjs';
import {
  agentsPage,
  assertIdSet,
  cleanupPlan,
  compareWithGolden,
  findAgentByName,
  lockResources,
  normaliseVerdicts,
} from './verdicts.mjs';

describe('normaliseVerdicts', () => {
  it('sorts by path, drops the note and keeps the code', () => {
    expect(
      normaliseVerdicts([
        { path: 'tools', verdict: 'dropped', code: 'code_tool_needs_public_mcp', note: 'prose' },
        { path: 'instructions', verdict: 'native', note: 'prose' },
      ]),
    ).toEqual([
      { path: 'instructions', verdict: 'native' },
      { path: 'tools', verdict: 'dropped', code: 'code_tool_needs_public_mcp' },
    ]);
  });

  it('refuses a shape that is not a verdict list', () => {
    expect(() => normaliseVerdicts({ report: [] })).toThrow(/not an array/u);
    expect(() => normaliseVerdicts([{ verdict: 'native' }])).toThrow(/no path/u);
    expect(() => normaliseVerdicts([{ path: 'model', verdict: 'kept' }])).toThrow(
      /unknown verdict/u,
    );
    expect(() => normaliseVerdicts([{ path: 'model', verdict: 'native', code: 3 }])).toThrow(
      /code that is not a string/u,
    );
    expect(() => normaliseVerdicts(['model'])).toThrow(/not an object/u);
  });
});

describe('compareWithGolden', () => {
  const model: GoldenVerdict = { path: 'model', verdict: 'mapped' };
  const tools: GoldenVerdict = {
    path: 'tools',
    verdict: 'dropped',
    code: 'code_tool_needs_public_mcp',
  };
  const golden = [model, tools];

  it('returns nothing for equal lists', () => {
    expect(compareWithGolden(golden, golden)).toEqual([]);
  });

  it('names an added path, a removed path, a verdict change and a code change separately', () => {
    expect(compareWithGolden([...golden, { path: 'skills', verdict: 'native' }], golden)).toEqual([
      '+ skills: native is new',
    ]);
    expect(compareWithGolden([tools], golden)).toEqual(['- model: mapped is gone']);
    expect(
      compareWithGolden(
        [{ path: 'model', verdict: 'dropped', code: 'field_unsupported' }, tools],
        golden,
      ),
    ).toEqual(['~ model: mapped -> dropped (field_unsupported)']);
    expect(compareWithGolden([model, { ...tools, code: 'other' }], golden)).toEqual([
      '~ tools: dropped (code_tool_needs_public_mcp) -> dropped (other)',
    ]);
  });

  it('compares a path listed twice entry by entry', () => {
    const once: GoldenVerdict = { path: 'tools', verdict: 'native' };
    expect(compareWithGolden([once, once], [once, once])).toEqual([]);
    expect(compareWithGolden([once, once], [once])).toEqual(['+ tools: native is new']);
    expect(compareWithGolden([once], [once, once])).toEqual(['- tools: native is gone']);
  });
});

describe('assertIdSet', () => {
  it('passes for equal sets in any order', () => {
    expect(() => {
      assertIdSet(['a', 'b'], ['b', 'a']);
    }).not.toThrow();
  });

  it('names a missing golden and an extra golden', () => {
    expect(() => {
      assertIdSet(['a', 'b'], ['a']);
    }).toThrow(/no golden for platform b/u);
    expect(() => {
      assertIdSet(['a'], ['a', 'c']);
    }).toThrow(/golden without a platform: c/u);
  });
});

describe('findAgentByName', () => {
  const list: unknown = JSON.parse(
    readFileSync(new URL('fixtures/agents-list.json', import.meta.url), 'utf8'),
  );

  it('finds the active agent by its exact name', () => {
    expect(findAgentByName(list, 'awpt-123')?.id).toBe('agent_011CZkYpogX7uDKUyvBTophP');
  });

  it('returns nothing for an unknown name, a longer name or an archived agent', () => {
    expect(findAgentByName(list, 'awpt-124')).toBeUndefined();
    expect(findAgentByName(list, 'awpt-12')).toBeUndefined();
    expect(findAgentByName(list, 'awpt-1234')?.id).toBe('agent_011CZkYpogX7uDKUyvBTophQ');
    expect(findAgentByName(list, 'awpt-125')).toBeUndefined();
  });
});

describe('lockResources', () => {
  it('sorts the recorded resources into agents, skills and the rest', () => {
    const lock = JSON.stringify({
      version: 1,
      resources: {
        './agents/awpt-1.md': { kind: 'agent', id: 'agent_1' },
        './skills/refund-policy': { id: 'skill_1' },
        './environments/default.yaml': { kind: 'environment', id: 'env_1' },
        './vaults/v': { kind: 'vault', id: 'vlt_1' },
      },
    });
    expect(lockResources(lock)).toEqual({
      agents: ['agent_1'],
      skills: ['skill_1'],
      environments: ['env_1'],
      other: ['vault vlt_1 (./vaults/v)'],
    });
  });

  it('takes an environment from its kind when the path says nothing', () => {
    const lock = JSON.stringify({
      resources: { './x.yaml': { kind: 'environment', id: 'env_2' } },
    });
    expect(lockResources(lock).environments).toEqual(['env_2']);
  });

  it('refuses a lock file without resources or an id', () => {
    expect(() => lockResources('{}')).toThrow(/no resources/u);
    expect(() => lockResources('{"resources":{"./agents/a.md":{}}}')).toThrow(/no string id/u);
  });
});

describe('cleanupPlan', () => {
  it('removes agents, then skills, then environments, whatever the order of the lock', () => {
    const lock = JSON.stringify({
      resources: {
        './environments/default.yaml': { kind: 'environment', id: 'env_1' },
        './skills/refund-policy': { id: 'skill_1' },
        './agents/awpt-1.md': { kind: 'agent', id: 'agent_1' },
      },
    });
    expect(cleanupPlan(lockResources(lock))).toEqual({
      commands: [
        ['beta:agents', 'archive', '--agent-id', 'agent_1'],
        ['beta:skills', 'delete', '--skill-id', 'skill_1'],
        ['beta:environments', 'delete', '--environment-id', 'env_1'],
      ],
      problems: [],
    });
  });

  it('fails closed on an unknown kind, naming the kind and id, and never deletes it', () => {
    const plan = cleanupPlan({
      agents: [],
      skills: [],
      environments: ['env_1'],
      other: ['vault vlt_1 (./vaults/v)'],
    });
    expect(plan.problems).toEqual(['not removed, unknown kind: vault vlt_1 (./vaults/v)']);
    expect(plan.commands.flat()).not.toContain('vlt_1');
    expect(plan.commands).toHaveLength(1);
  });
});

describe('agentsPage', () => {
  it('returns the agents and the cursor of the next page', () => {
    expect(
      agentsPage({ data: [{ id: 'a', name: 'n', archived_at: null }], next_page: 'cursor' }),
    ).toEqual({ agents: [{ id: 'a', name: 'n', archived: false }], nextPage: 'cursor' });
  });

  // https://platform.claude.com/docs/en/api/beta/agents/list: `next_page` is "optional string or
  // null"; the committed fixture is a last page that leaves it out.
  it('treats a null or missing next_page as the last page', () => {
    expect(agentsPage({ data: [], next_page: null }).nextPage).toBeNull();
    expect(agentsPage({ data: [] }).nextPage).toBeNull();
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('fixtures/agents-list.json', import.meta.url), 'utf8'),
    );
    expect(agentsPage(fixture)).toMatchObject({ nextPage: null });
    expect(agentsPage(fixture).agents).toHaveLength(4);
  });

  it('parses the environments list with the same page parser', () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('fixtures/environments-list.json', import.meta.url), 'utf8'),
    );
    const page = agentsPage(fixture, 'environments');
    expect(page.nextPage).toBeNull();
    expect(page.agents.map((environment) => environment.archived)).toEqual([false, true]);
    expect(() => agentsPage({}, 'environments')).toThrow(
      /the environments list has no data array/u,
    );
  });

  it('refuses a shape that is not the documented list', () => {
    expect(() => agentsPage({})).toThrow(/no data array/u);
    expect(() => agentsPage({ data: [{ id: 1 }], next_page: null })).toThrow(/string id and name/u);
  });

  it.each([3, {}, true, []])('refuses a next_page of the wrong type: %j', (nextPage) => {
    expect(() => agentsPage({ data: [], next_page: nextPage })).toThrow(/next_page/u);
  });

  it('names the top-level keys of a refused response, never their values', () => {
    let message = '';
    try {
      agentsPage({ data: [], next_page: 3, secret_value_x: 'sk-ant-xyz' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/top-level keys: data, next_page, secret_value_x\)$/u);
    expect(message).not.toContain('sk-ant-xyz');
    expect(message).not.toContain('3');
  });

  it('names only a type word for a response that is not an object', () => {
    expect(() => agentsPage([])).toThrow(/no data array \(top-level keys: array\)/u);
    expect(() => agentsPage('x')).toThrow(/no data array \(top-level keys: string\)/u);
    expect(() => agentsPage(null)).toThrow(/no data array \(top-level keys: null\)/u);
  });
});
