import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { operationsOf } from '../harness/openapi-gateway.ts';
import { DATES, document, project, run } from './meeting-minutes.fixture.test-support.ts';
import { resolveDate } from './skills/gijiroku-format/scripts/dates.mjs';
import { tracker as trackerTool } from './tools/tracker.ts';
import agentDefinition from './agents/meeting-minutes.ts';

export function defineDefinitionCases(): void {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    expect(definition?.policy).toMatchObject({
      tools: { permissionMode: 'default', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['task-tracker', 'tracker'],
      skills: ['gijiroku-format'],
      files: [{ path: 'transcripts', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('`createTask` を絶対に呼ばない');
    // The tracker tool admits the one write, createTask, so compose makes it requireApproval.
    expect(toolDefinitionsOf(agentDefinition)).toMatchObject([
      { kind: 'openapi', name: 'tracker', allow: ['operationId:createTask'] },
    ]);
    const selected = selectAllowedOperations(trackerTool.allow, operationsOf(document));
    expect(selected.refusals).toStrictEqual([]);
    expect(
      toolApprovalRules(
        toolServerKey('tracker'),
        selected.admitted.map((operation) => ({ name: operation.operationId, method: 'POST' })),
      ),
    ).toStrictEqual(['mcp__tracker__createTask']);
    const surfaces = agent?.body.surfaces ?? [];
    expect(surfaces.map((surface) => surface.name)).toStrictEqual(['minutes']);
    expect(surfaces[0]?.layout).toBe('page');
    expect(surfaces[0]?.toolResults).toStrictEqual({ list_tasks: 'table' });
    const skill = project.skills.find((entry) => entry.name === 'gijiroku-format');
    expect(skill?.files.map((file) => file.path).sort()).toStrictEqual([
      'SKILL.md',
      'scripts/dates.d.mts',
      'scripts/dates.mjs',
    ]);
    expect(project.project.policy?.permissions).toMatchObject({
      writeFiles: false,
      runCommands: true,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.some((entry) => entry.expect.contains?.includes('担当未定'))).toBe(true);
    expect(cases.some((entry) => entry.expect.notContains?.includes('TASK-'))).toBe(true);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the date script resolves relative Japanese dates against the meeting date', async () => {
    // 2026-10-02 is a Friday; 2026-10-05 the Monday after.
    const friday = '2026-10-02';
    const cases: readonly [string, string, string | null][] = [
      ['今日', friday, '2026-10-02'],
      ['明日', friday, '2026-10-03'],
      ['明後日', friday, '2026-10-04'],
      ['来週金曜', friday, '2026-10-09'],
      ['来週の金曜くらいまでに', friday, '2026-10-09'],
      ['今週金曜日', '2026-10-05', '2026-10-09'],
      ['来週金曜', '2026-10-05', '2026-10-16'],
      ['再来週の月曜', friday, '2026-10-12'],
      ['週明け', friday, '2026-10-05'],
      ['月末', friday, '2026-10-31'],
      ['来月末', '2026-01-15', '2026-02-28'],
      ['来月10日', friday, '2026-11-10'],
      ['来月31日', friday, null], // November has 30 days
      ['3営業日後', friday, '2026-10-07'], // Mon 5, Tue 6, Wed 7
      ['３営業日後', friday, '2026-10-07'], // full-width digit
      ['5日後', friday, '2026-10-07'],
      ['12月28日', friday, '2026-12-28'],
      ['1月4日', friday, '2027-01-04'], // already past this year: next year
      ['2026/11/30', friday, '2026-11-30'],
      ['なるべく早く', friday, null],
      ['次回まで', friday, null],
    ];
    for (const [expression, base, expected] of cases) {
      expect(resolveDate(expression, base), `${expression} from ${base}`).toBe(expected);
    }
    expect(resolveDate('3営業日後', friday, { holidays: ['2026-10-05'] })).toBe('2026-10-08');
    expect(() => resolveDate('明日', '10/2')).toThrow('YYYY-MM-DD');

    // As the skill runs it inside a run: a command, JSON on stdout.
    const { stdout } = await run(process.execPath, [DATES, friday, '来週金曜', '近いうちに']);
    expect(JSON.parse(stdout)).toStrictEqual([
      { expression: '来週金曜', date: '2026-10-09' },
      { expression: '近いうちに', date: null },
    ]);
    await expect(run(process.execPath, [DATES, '2026-02-30', '明日'])).rejects.toMatchObject({
      code: 2,
    });
  });
}
