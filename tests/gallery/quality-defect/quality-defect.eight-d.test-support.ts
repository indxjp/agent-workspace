import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { checkEightD, parseEightD } from './skills/eight-d/scripts/eightd.mjs';
import { DIR, SCRIPT, SAMPLE, run } from './quality-defect.fixture.test-support.ts';

export function defineEightDCases(): void {
  it('the eight-d script validates a draft from the command line, as the agent runs it', async () => {
    const good = await run(process.execPath, [SCRIPT, SAMPLE]);
    const parsed = JSON.parse(good.stdout) as ReturnType<typeof parseEightD>;
    expect(parsed.valid).toBe(true);
    expect(parsed.sections.map((section) => section.id)).toStrictEqual([
      'D1',
      'D2',
      'D3',
      'D4',
      'D5',
      'D6',
      'D7',
      'D8',
    ]);
    expect(parsed.whys.map((why) => why.depth)).toStrictEqual([1, 2, 3]);
    expect(parsed.causeCode).toBe('金型摩耗');
    expect(parsed.fourM?.counts).toStrictEqual({ 人: 1, 機械: 2, 材料: 1, 方法: 1 });

    const bad = [
      '## D1 チーム',
      '## D2 問題',
      '## D3 暫定',
      '## D4 根本原因',
      '- なぜ1: パンチが摩耗した〔過去トラ Q-1003〕',
      '- なぜ2: 研磨が遅れた',
      '## D5 対策',
      '## D5 対策（再掲）',
      '## D7 水平展開',
      '## D8 完了',
    ].join('\n');
    const failed = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, [SCRIPT, '--text', bad], (error, stdout) => {
        resolve({ code: error === null ? 0 : (error.code as number | null), stdout });
      });
    });
    expect(failed.code).toBe(1);
    const result = JSON.parse(failed.stdout) as ReturnType<typeof parseEightD>;
    expect(result.issues.map((issue) => issue.code)).toStrictEqual([
      'duplicate_section',
      'missing_section',
      'shallow_whys',
      'missing_root_cause',
      'uncited_claim',
    ]);
  });

  it('the skeleton in the agent instructions, filled in, passes the checker on the first try', async () => {
    const instructions = await readFile(path.join(DIR, 'agents', 'quality-defect.md'), 'utf8');
    const skeleton = (/```md\n([\s\S]*?)```/u.exec(instructions)?.[1] ?? '').replace(
      /^ {3}/gmu,
      '',
    );
    const filled = skeleton
      .replace(/^(原因区分: ).*$/mu, '$1金型摩耗')
      .replace(/^(4M集計: ).*$/mu, '$1人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）')
      .replace(/^(- (?:なぜ\d|根本原因): )…/gmu, '$1理由')
      .replace(/^(## D[1-35-8].*)$/gmu, '$1\n\n- 本文');
    const parsed = parseEightD(filled.replaceAll('Q-xxxx', 'Q-1003'));
    expect(parsed.issues).toStrictEqual([]);
    expect(parsed.valid).toBe(true);
  });

  it('the eight-d parser reads full-width numbering and a multi-case citation', () => {
    const draft = parseEightD(
      [
        '## Ｄ１ チーム',
        '## D2 問題',
        '## D3 暫定',
        '## D4 根本原因',
        '原因区分：金型摩耗',
        '4M集計：人 0件 / 機械 2件 / 材料 0件 / 方法 0件（類似 2件）',
        '- なぜ１：摩耗〔過去トラ Ｑ-１００３〕',
        '- なぜ２：研磨遅れ〔過去トラ Q-1003、Q-1011〕',
        '- なぜ３：管理なし〔過去トラ Q-1011〕',
        '- 根本原因：仕組みがない〔過去トラ Q-1011〕',
        '## D5 a',
        '## D6 b',
        '## D8 d',
        '## D7 c',
      ].join('\n'),
    );
    expect(draft.sections[0]?.id).toBe('D1');
    expect(draft.whys.map((why) => why.depth)).toStrictEqual([1, 2, 3]);
    expect(draft.cites).toStrictEqual(['Q-1003', 'Q-1011']);
    expect(draft.fourM).toMatchObject({ counts: { 機械: 2 }, total: 2 });
    expect(draft.issues.map((issue) => issue.code)).toStrictEqual(['section_order']);
  });

  it('checkEightD gives the same verdict on a parsed structure as parseEightD on its text', async () => {
    const parsed = parseEightD(await readFile(SAMPLE, 'utf8'));
    const { cites, issues, valid, ...structure } = parsed;
    expect(checkEightD(structure)).toStrictEqual({ ...structure, cites, issues, valid });
    expect(
      checkEightD({
        ...structure,
        sections: structure.sections.filter((section) => section.id !== 'D6'),
        whys: structure.whys.slice(0, 2),
        claims: [...structure.claims, { text: '- 出典のない主張', cites: [] }],
      }).issues.map((issue) => issue.code),
    ).toStrictEqual(['missing_section', 'shallow_whys', 'uncited_claim']);
    // A structure that leaves the whys out of `claims` still has them checked.
    expect(
      checkEightD({
        ...structure,
        whys: structure.whys.map((why) => ({ ...why, cites: [] })),
        claims: [],
      }).issues.map((issue) => issue.code),
    ).toStrictEqual(['uncited_claim', 'uncited_claim', 'uncited_claim']);
  });
}
