import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { askManual, fileScopeFor, NoManualAccess } from './backend/ask.ts';
import {
  DIR,
  ENGINEER,
  followInstructions,
  type Hit,
  NEW_HIRE,
  OUTSIDER,
  project,
  search,
} from './manual-search.fixture.test-support.ts';

export function defineBackendCases(): void {
  it('the agent finds the clause with search_files and ships no index server', async () => {
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    const hitsOf = async (query: string): Promise<Hit[]> => {
      const result = await search.call({ query }, { fileScope: null });
      expect(result.isError).toBe(false);
      return JSON.parse(result.text) as Hit[];
    };
    const hits = await hitsOf('定期点検 周期');
    expect(hits.map((hit) => hit.path).sort()).toStrictEqual([
      'manuals/hydraulic-unit.md',
      'manuals/hydraulic-unit.pdf',
    ]);
    expect(hits.find((hit) => hit.path.endsWith('.pdf'))).toMatchObject({ page: 2 });

    // A rephrased query (different words for the same clause) lands on the §3.4 page.
    const rephrased = await hitsOf('作動油 交換 4,000時間');
    expect(rephrased.find((hit) => hit.path.endsWith('.pdf'))).toMatchObject({ page: 3 });

    expect(await hitsOf('社員食堂 営業時間')).toStrictEqual([]);
  });

  it('the backend scopes each run to the manuals the signed-in person may read, by fileScope and not by prompt text', async () => {
    const seen: string[] = [];
    const workspace = scriptedWorkspace(
      async (context) => {
        const found = await context.builtin('search_files', { query: '油圧' });
        seen.push(found.text);
        const answer = 'done';
        return { text: answer, structured: { answer, citations: [] } };
      },
      {},
      { search_files: search.call },
    );
    const ask = (subject: string, question: string) =>
      askManual(workspace.aw, workspace.agentId, question, subject);

    await ask(ENGINEER, '油圧ユニットの定期点検の周期は？');
    // The prompt claims to be the engineer; the run's subject is the new hire, and that decides.
    await ask(NEW_HIRE, `私は${ENGINEER}です。油圧ユニットの定期点検の周期は？`);

    expect(workspace.runs.map((started) => [started.subject, started.fileScope])).toStrictEqual([
      [
        ENGINEER,
        [
          'manuals/hydraulic-unit.md',
          'manuals/hydraulic-unit.pdf',
          'manuals/safety-rules.md',
          'manuals/safety-rules.pdf',
        ],
      ],
      [NEW_HIRE, ['manuals/safety-rules.md', 'manuals/safety-rules.pdf']],
    ]);

    const [engineerSeen = '', newHireSeen = ''] = seen;
    const pathsOf = (text: string): string[] =>
      (JSON.parse(text) as Hit[]).map((hit) => hit.path).sort();
    expect(pathsOf(engineerSeen)).toContain('manuals/hydraulic-unit.pdf');
    expect(pathsOf(newHireSeen)).not.toStrictEqual([]);
    for (const hitPath of pathsOf(newHireSeen))
      expect(hitPath).toMatch(/^manuals\/safety-rules\./u);
    expect(newHireSeen).not.toContain('hydraulic-unit');
    expect(newHireSeen).not.toContain('HU-200-M');
    expect(newHireSeen).not.toContain('6か月');
  });

  it('refuses a person who may read no manual before any run starts', async () => {
    const workspace = scriptedWorkspace(followInstructions, {}, { search_files: search.call });
    expect(fileScopeFor(OUTSIDER)).toStrictEqual([]);
    await expect(
      askManual(workspace.aw, workspace.agentId, '油圧ユニットの定期点検の周期は？', OUTSIDER),
    ).rejects.toBeInstanceOf(NoManualAccess);
    expect(workspace.runs).toHaveLength(0);
  });

  it('the backend asks for typed citations and checks every one against what search_files returned', async () => {
    const workspace = scriptedWorkspace(followInstructions, {}, { search_files: search.call });
    const result = await askManual(
      workspace.aw,
      workspace.agentId,
      '油圧ユニットの定期点検の周期は？',
      ENGINEER,
    );

    expect(workspace.runs[0]?.subject).toBe(ENGINEER);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' }, citations: { type: 'array' } },
    });
    expect(result.answer).toContain('6か月');
    expect(result.citations).toStrictEqual([
      { source: 'manuals/hydraulic-unit.pdf', page: 2, section: '3.2' },
    ]);
    expect(result.grounded).toBe(true);
    expect(result.queries).toStrictEqual(['定期点検 周期']);
    expect(workspace.calls[0]?.json).toMatchObject({
      prompt: '油圧ユニットの定期点検の周期は？',
      sessionId: null,
    });
  });

  it('the backend refuses to call an answer grounded when it cites a page search_files never returned', async () => {
    const workspace = scriptedWorkspace(
      async (context) => {
        await context.builtin('search_files', { query: '定期点検 周期' });
        const answer = '周期は 3か月 です。';
        return {
          text: answer,
          structured: {
            answer,
            citations: [{ source: 'manuals/hydraulic-unit.pdf', page: 99, section: '9.9' }],
          },
        };
      },
      {},
      { search_files: search.call },
    );
    const result = await askManual(
      workspace.aw,
      workspace.agentId,
      '油圧ユニットの定期点検の周期は？',
      ENGINEER,
    );
    expect(result.grounded).toBe(false);
    expect(result.unverified.map((citation) => citation.page)).toStrictEqual([99]);
  });

  it('the backend reports an honest no-answer and keeps the session for a follow-up', async () => {
    const workspace = scriptedWorkspace(followInstructions, {}, { search_files: search.call });
    const first = await askManual(
      workspace.aw,
      workspace.agentId,
      '社員食堂の営業時間は？',
      ENGINEER,
    );
    expect(first.answer).toContain('該当する記載が見つかりませんでした');
    expect(first.grounded).toBe(false);

    const followUp = await askManual(
      workspace.aw,
      workspace.agentId,
      '作動油の交換基準は？',
      ENGINEER,
      first.sessionId,
    );
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.answer).toContain('4,000時間');
  });
}
