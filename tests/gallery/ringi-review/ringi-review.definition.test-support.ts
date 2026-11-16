import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { fileScopeFor } from './backend/review-run.ts';
import {
  DATA,
  SUBMITTER,
  type Hit,
  type RingiRecord,
  access,
  authority,
  builtins,
  project,
} from './ringi-review.fixture.test-support.ts';

export function defineDefinitionCases(): void {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.name).toBe('ringi-review');
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['authority', 'workflow'],
      skills: ['ringi-checklist'],
      files: [
        { path: 'rules', access: 'read' },
        { path: 'ringi', access: 'read' },
      ],
    });
    expect(definition?.agent.instructions).toContain('check_authority');
    expect(definition?.agent.instructions).toContain('search_files');
    expect(definition?.agent.instructions).toContain('承認も否決もしません');
    expect(agent?.body.surfaces?.map((surface) => [surface.name, surface.layout])).toStrictEqual([
      ['ringi-desk', 'side'],
    ]);
    expect(agent?.body.surfaces?.[0]?.toolResults).toStrictEqual({
      search_files: 'card',
    });
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['ringi-checklist']);
    // The ceiling every agent in the project inherits: no file writes, no commands, no open network.
    expect(project.project.policy?.permissions).toStrictEqual({
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases.some((entry) => entry.expect.notContains?.includes('承認を推奨'))).toBe(true);
    expect(cases.some((entry) => entry.expect.judge !== undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the no-recommendation case still fails a verdict, and no longer fails the check the skill requires', () => {
    const entry = (project.agents[0]?.evals?.cases ?? []).find((candidate) =>
      candidate.expect.notContains?.includes('承認を推奨'),
    );
    expect(entry?.expect.notContains).toStrictEqual(['承認を推奨', '否決を推奨', '承認してよい']);
    const judge = entry?.expect.judge ?? '';
    for (const heading of ['記載漏れ', '規程との照合', '決裁区分', '類似案件', '総合所見']) {
      expect(judge).toContain(`「${heading}」`);
    }
    expect(judge).toContain('承認・否決の判断や推奨を書いていないこと');
    expect(judge).toContain('不合格');
    // The skill requires the approver's points to be written (総合所見); the rubric must not read them as a verdict.
    expect(judge).toContain('「確認が求められる」');
    expect(judge).toContain('推奨や判断には当たらない');
  });

  it('the agent finds precedents, including rejected ones, with search_files and ships no index server', async () => {
    expect(await authority.tools()).toStrictEqual(['check_authority']);
    expect(project.project.connectors).not.toHaveProperty('ringi-archive');

    const workspace = scriptedWorkspace(
      async ({ builtin, prompt }) => (await builtin('search_files', { query: prompt })).text,
      {},
      builtins,
    );
    const search = async (person: string, query: string): Promise<Hit[]> => {
      const { run } = await workspace.aw.runs.start(workspace.agentId, {
        prompt: query,
        subject: person,
        fileScope: fileScopeFor(person, access),
      });
      return JSON.parse((await workspace.aw.runs.result(run.id)).text ?? '[]') as Hit[];
    };
    const pathsOf = async (person: string, query: string): Promise<string[]> =>
      (await search(person, query)).map((hit) => hit.path).sort();

    // A rejected precedent is found by why it was sent back, not only by its subject.
    expect(await pathsOf(SUBMITTER, '工場 更新')).toStrictEqual([
      'ringi/製造本部/2025.json',
      'ringi/製造本部/2026.json',
    ]);
    expect(await pathsOf(SUBMITTER, '分割起案 差戻し')).toStrictEqual(['ringi/物流部/2025.json']);
    expect(await pathsOf(SUBMITTER, '議員 後援会 否決')).toStrictEqual([
      'ringi/営業本部/2025.json',
    ]);

    // The hit carries the platform's shape, and the file it names holds the record and its 出典.
    const [split] = await search(SUBMITTER, '分割起案 差戻し');
    expect(split).toMatchObject({ path: 'ringi/物流部/2025.json', page: null });
    const records = JSON.parse(
      await readFile(path.join(DATA, split?.path ?? ''), 'utf8'),
    ) as RingiRecord[];
    const rejected = records.find((record) => record.id === 'R-2025-0133');
    expect(rejected?.理由).toContain('§2.3');
    expect(rejected?.出典).toBe('〔稟議 R-2025-0133〕');

    // The rules are searched the same way, and a clause carries its own 出典.
    const [clause] = await search(SUBMITTER, '相見積 見積書');
    expect(clause?.path).toBe('rules/ringi-rules.md');
    expect(await readFile(path.join(DATA, 'rules', 'donation-rules.md'), 'utf8')).toContain(
      '出典: 〔寄付金取扱基準 §2.2〕',
    );

    expect(await search(SUBMITTER, '社員食堂 営業時間')).toStrictEqual([]);
  });
}
