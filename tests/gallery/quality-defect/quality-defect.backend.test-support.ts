import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { RunDidNotComplete } from '../shared/run-answer.ts';
import { analyseDefect, InvalidDefectReport, type NewDefect } from './backend/analyse.ts';
import { parseEightD } from './skills/eight-d/scripts/eightd.mjs';
import {
  SAMPLE,
  QA_LEAD,
  BURR,
  answerOf,
  NOT_FOUND,
  qualityWorkspace,
  pausedOn,
  endedOn,
  registrationFor,
  followInstructions,
} from './quality-defect.fixture.test-support.ts';

export function defineBackendCases(): void {
  it('the backend pauses on registering the case with a checked 8D draft, and flags the recurrence of a recurring cause', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const result = await pausedOn(workspace);

    // The run waits on the registration: the DR reads the draft, and nothing is in the database yet.
    expect(result.call.toolName).toBe('mcp__qms__createCase');
    expect(result.registration).toMatchObject({
      title: 'バリ',
      partNo: 'BRK-2201',
      process: 'プレス',
      count: 48,
      causeCode: '金型摩耗',
    });
    expect(result.registration.report).toBe(result.answer);
    expect((await workspace.aw.runs.get(result.runId)).status).toBe('awaiting_approval');

    expect(workspace.runs[0]?.prompt).toContain('現象: バリ\n品番: BRK-2201');
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['report', 'draft'],
      properties: {
        draft: {
          anyOf: [
            { required: expect.arrayContaining(['sections', 'whys', 'claims']) as unknown },
            { type: 'null' },
          ],
        },
      },
    });
    expect(result.draft?.valid).toBe(true);
    expect(result.draft?.whys.length).toBeGreaterThanOrEqual(3);
    expect(result.unverifiedCases).toStrictEqual([]);
    expect(result.fourM).toMatchObject({
      status: 'verified',
      stats: { fourM: { 人: 1, 機械: 2, 材料: 1, 方法: 1 } },
    });
    expect(result.recurrence).toStrictEqual({
      causeCode: '金型摩耗',
      sameCause: ['Q-1003', 'Q-1011'],
      recurredCases: ['Q-1003', 'Q-1011'],
      recurring: true,
    });
    expect(result.answer).toContain('再発: 〔過去トラ Q-1003、Q-1011〕');
    expect(result.readyForReview).toBe(true);
    expect(result.findings).toStrictEqual([]);
  });

  it('the backend does not flag recurrence when the matched same-cause case never recurred', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const result = await pausedOn(workspace, {
      phenomenon: 'ブローホール',
      partNo: 'ASY-6001',
      lot: 'L261002-1',
      process: '溶接',
      count: 22,
    });
    expect(result.recurrence).toStrictEqual({
      causeCode: '設備設定ずれ',
      sameCause: ['Q-2038'],
      recurredCases: [],
      recurring: false,
    });
    expect(result.readyForReview).toBe(true);
  });

  it('the backend holds back a draft that cites an unread case or miscounts the 4M', async () => {
    const workspace = qualityWorkspace(async (context) => {
      await context.tool('qms', 'searchDefects', { q: 'バリ', process: 'プレス' });
      await context.tool('qms', 'causeStats', { q: 'バリ', process: 'プレス', groupBy: '4m' });
      const sample = await readFile(SAMPLE, 'utf8');
      const report = sample
        .replace('機械 2件', '機械 3件')
        .replace('〔過去トラ Q-1042〕。\n\n## D6', '〔過去トラ Q-3002〕。\n\n## D6');
      await context.tool('qms', 'createCase', { body: registrationFor(report) });
      return answerOf(report);
    });
    const result = await pausedOn(workspace);
    expect(result.draft?.valid).toBe(true);
    expect(result.unverifiedCases).toStrictEqual(['Q-3002']);
    expect(result.fourM).toMatchObject({
      status: 'mismatch',
      computed: ['4M集計: 人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）'],
    });
    expect(result.readyForReview).toBe(false);
    expect(result.findings).toHaveLength(2);
  });

  it('the backend refuses an incomplete defect report before starting a run', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const attempt = analyseDefect(
      workspace.aw,
      workspace.agentId,
      {
        ...BURR,
        partNo: 'BRK2201',
        process: '鋳造' as NewDefect['process'],
        count: 0,
      },
      QA_LEAD,
    );
    await expect(attempt).rejects.toBeInstanceOf(InvalidDefectReport);
    await expect(attempt).rejects.toMatchObject({ fields: ['partNo', 'process', 'count'] });
    expect(workspace.runs).toHaveLength(0);
  });

  it('the backend reports no similar case honestly and does not put it on the DR agenda', async () => {
    const script = followInstructions();
    const used: string[] = [];
    const workspace = qualityWorkspace((context) =>
      script({
        ...context,
        tool: (connector, tool, args) => {
          used.push(tool);
          return context.tool(connector, tool, args);
        },
      }),
    );
    const result = await endedOn(workspace, {
      phenomenon: '配膳遅れ',
      partNo: 'CAF-0001',
      lot: 'なし',
      process: '組立',
      count: 1,
    });
    expect(result.answer).toBe(NOT_FOUND);
    // The run stopped at the searches: no case read, no 4M counted.
    expect(used).toStrictEqual(['searchDefects', 'searchDefects']);
    expect(result.matched).toStrictEqual([]);
    expect(result.recurrence.recurring).toBe(false);
    expect(result.readyForReview).toBe(false);
    expect(result.draft).toBeNull();
    expect(result.findings).toStrictEqual(['8D下書きがない（類似する過去トラが見つからなかった）']);
  });

  it('the backend checks the structure a run returns, and a report with no structure fails the run', async () => {
    // The agent returns a draft whose parts break the format: no D6, an uncited なぜ, two なぜ.
    const broken = qualityWorkspace(async () => {
      const sample = await readFile(SAMPLE, 'utf8');
      return answerOf(
        sample
          .replace(/^## D6[\s\S]*?(?=^## D7)/mu, '')
          .replace(/^(- なぜ2:.*?)〔過去トラ[^〕]*〕/mu, '$1')
          .replace(/^- なぜ3:.*$/mu, ''),
      );
    });
    const checked = await endedOn(broken);
    expect(checked.draft?.issues.map((issue) => issue.code)).toStrictEqual([
      'missing_section',
      'shallow_whys',
      'uncited_claim',
    ]);
    expect(checked.readyForReview).toBe(false);

    // A report without the structure is not a draft the backend can check: the platform fails it.
    const bare = qualityWorkspace(() => readFile(SAMPLE, 'utf8'));
    await expect(analyseDefect(bare.aw, bare.agentId, BURR, QA_LEAD)).rejects.toBeInstanceOf(
      RunDidNotComplete,
    );
  });

  it('the backend checks every field of a structured draft that disagrees with itself', async () => {
    // A model can fill the parts separately: a Q-number no tool returned only in the whys and the
    // D4 prose, no claims, an uncited root cause.
    const workspace = qualityWorkspace(async (context) => {
      await context.tool('qms', 'searchDefects', { q: 'バリ', process: 'プレス' });
      const report = await readFile(SAMPLE, 'utf8');
      const { title, sections, whys, rootCause, causeCode, fourM } = parseEightD(report);
      const draft = {
        title,
        sections: sections.map((section) =>
          section.id === 'D4'
            ? { ...section, body: 'なぜ1: 〔過去トラ Q-9999〕', cites: [] }
            : { ...section, cites: [] },
        ),
        whys: whys.map((why) => ({ ...why, cites: ['Q-9999'] })),
        claims: [],
        rootCause: rootCause === null ? null : { ...rootCause, cites: [] },
        causeCode,
        fourM,
      };
      return { text: report, structured: { report, draft } };
    });
    const result = await endedOn(workspace);
    expect(result.unverifiedCases).toContain('Q-9999');
    expect(result.draft?.issues.map((issue) => issue.code)).toContain('uncited_claim');
    expect(result.readyForReview).toBe(false);
  });
}
