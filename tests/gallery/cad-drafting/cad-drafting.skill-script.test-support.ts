import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { describeChanges, draft, summarise } from './skills/dxf-draft/scripts/dxf.mjs';
import {
  DATA,
  REQUIREMENTS,
  baseFile,
  changeSetFor,
  drawingOf,
  drawingPath,
  failedDraft,
  scriptDraft,
  work,
} from './cad-drafting.fixture.test-support.ts';

export function defineSkillScriptCases(): void {
  it('the skill script drafts a DXF that re-parses with exactly the requested geometry', async () => {
    const base = summarise(await drawingOf('BRK-1003'));
    const { printed: output, written } = await scriptDraft(
      'BRK-1003',
      { ...changeSetFor(REQUIREMENTS, base), drafter: '高橋', date: '2026-10-04' },
      'BRK-1101',
    );
    const { changeSet: printed, changes: changed, kept: keptLines, ...reported } = output;
    expect(written).toStrictEqual(reported);
    // The change set the reply pastes: only the fields that differ from the base.
    expect(printed).toStrictEqual({
      ...changeSetFor(REQUIREMENTS, base),
      drafter: '高橋',
      date: '2026-10-04',
    });
    expect(Object.keys(printed)).not.toContain('material');
    // The reply's bullets come from these lines: only the height and the two upper holes changed,
    // and everything the request merely repeats is reported as kept.
    expect(changed).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
    expect(keptLines).toStrictEqual([
      '幅 140（元図のまま）',
      '材質 SUS304（元図のまま）',
      '板厚 t2.0（元図のまま）',
      '品名 ブラケット（元図のまま）',
      '穴 (15,15)φ9 (125,15)φ9（元図のまま）',
    ]);
    expect(written).toMatchObject({
      version: 'AC1027',
      drawingNo: 'BRK-1101',
      material: 'SUS304',
      thickness: 't2.0',
      status: '未検図',
      derivedFrom: 'BRK-1003',
      origin: base.origin,
      width: 140,
      height: 90,
      rectangular: true,
    });
    expect(written.title).toMatchObject({ 検図: '未', 作成: '2026-10-04 高橋', 尺度: '1:1' });
    expect(written.holes).toStrictEqual([
      { x: 15, y: 15, diameter: 9 },
      { x: 125, y: 15, diameter: 9 },
      { x: 15, y: 75, diameter: 9 },
      { x: 125, y: 75, diameter: 9 },
    ]);
    // Only what the request changes: the notes are the base's, plus the 未検図 note.
    expect(written.notes.slice(0, base.notes.length)).toStrictEqual(base.notes);
    expect(written.notes.at(-1)).toContain('未検図 BRK-1003 から派生');

    // Holes left out keep the base's.
    const { written: kept } = await scriptDraft(
      'BRK-1001',
      { base: 'BRK-1001', drawingNo: 'BRK-1102', width: 130, height: 60 },
      'BRK-1101',
    );
    expect(kept).toMatchObject({ width: 130, height: 60, material: 'SS400', thickness: 't3.2' });
    expect(kept.holes).toStrictEqual(summarise(await drawingOf('BRK-1001')).holes);
  });

  it('a change set that repeats the base values reports them as kept, not as changes', async () => {
    const base = summarise(await drawingOf('BRK-1003'));
    const chatty = {
      ...changeSetFor(REQUIREMENTS, base),
      material: 'SUS304',
      thickness: 2.0,
      partName: 'ブラケット',
    };
    const { changes, kept, changeSet } = draft(await drawingOf('BRK-1003'), chatty);
    // The printed change set drops every field the request merely repeats.
    expect(changeSet).toStrictEqual(changeSetFor(REQUIREMENTS, base));
    expect(
      draft(await drawingOf('BRK-1003'), { ...chatty, holes: base.holes }).changeSet,
    ).toStrictEqual({ base: 'BRK-1003', drawingNo: 'BRK-1101', width: 140, height: 90 });
    expect(changes).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
    expect(kept).toContain('材質 SUS304（元図のまま）');
    expect(kept).toContain('板厚 t2.0（元図のまま）');
    expect(changes.join('\n')).not.toMatch(/SUS304|t2\.0|幅/u);
    const other = draft(await drawingOf('BRK-1003'), {
      ...chatty,
      material: 'SS400',
      holes: [{ x: 15, y: 15, diameter: 9 }],
    });
    expect(other.changes).toContain('材質 SUS304 → SS400');
    expect(other.changeSet).toMatchObject({ material: 'SS400' });
    expect(other.changes.filter((line) => line.includes('削除'))).toHaveLength(3);
  });

  it('moved holes pair by position, not by the order the change set lists them in', async () => {
    const base = summarise(await drawingOf('BRK-1003'));
    const ordered = changeSetFor(REQUIREMENTS, base);
    const swapped = { ...ordered, holes: [...(ordered.holes ?? [])].reverse() };
    expect(draft(await drawingOf('BRK-1003'), swapped).changes).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
  });

  it('a title field the base and the draft both lack is left out, never printed as null', async () => {
    const base = { ...summarise(await drawingOf('BRK-1003')), partName: null };
    const { changes, kept } = describeChanges(base, { ...base, height: base.height + 10 });
    expect([...changes, ...kept].join('\n')).not.toContain('null');
    expect(kept.some((line) => line.startsWith('品名'))).toBe(false);
  });

  it('a field the base lacks and the draft sets is an addition, never null → X', async () => {
    const base = { ...summarise(await drawingOf('BRK-1003')), partName: null };
    const { changes } = describeChanges(base, { ...base, partName: 'ブラケット' });
    expect(changes).toStrictEqual(['品名 ブラケット を追加']);
  });

  it('the skill script refuses holes outside the outline and an outline it would have to stretch', async () => {
    const changes = path.join(work, 'bad.changes.json');
    const out = path.join(work, 'bad.dxf');
    const refusal = async (base: string, changeSet: object): Promise<string> => {
      await writeFile(changes, JSON.stringify(changeSet));
      const failed = await failedDraft(await baseFile(base), changes, out);
      expect(failed?.code).toBe(1);
      return failed?.stderr ?? '';
    };
    // Shrinking BRK-1001 to 100 wide keeps its hole at x=105: it would leave the outline.
    expect(
      await refusal('BRK-1001', {
        base: 'BRK-1001',
        drawingNo: 'BRK-1103',
        width: 100,
        height: 60,
      }),
    ).toContain('穴2 (105, 15) φ9: 外形 100×60 からはみ出します');
    expect(
      await refusal('BRK-1004', {
        base: 'BRK-1004',
        drawingNo: 'BRK-1104',
        width: 120,
        height: 100,
      }),
    ).toContain('BRK-1004 の外形は矩形ではありません');
    expect(
      await refusal('BRK-1001', {
        base: 'drawings/BRK/BRK-1001.dxf',
        drawingNo: 'BRK-1103',
        width: 120,
        height: 60,
      }),
    ).toContain('base must be the drawing number "BRK-1001", not a file path');
    expect(
      await refusal('BRK-1001', {
        base: 'BRK-1001',
        drawingNo: 'BRK-1001',
        width: 120,
        height: 60,
      }),
    ).toContain('drawingNo must be new');
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });

  it('the skill script refuses a base with an entity it cannot read, and a base that is not office-reader output', async () => {
    const changes = path.join(work, 'unread.changes.json');
    const out = path.join(work, 'unread.dxf');
    const asked = { base: 'BRK-1003', drawingNo: 'BRK-1105', width: 140, height: 90 };
    await writeFile(changes, JSON.stringify(asked));
    const withArc = { ...(await drawingOf('BRK-1003')), counts: { LINE: 4, CIRCLE: 4, ARC: 1 } };
    expect(() => draft(withArc, asked)).toThrow(/BRK-1003 には ARC が含まれます/u);
    const withBlock = { ...(await drawingOf('BRK-1003')), blocks: ['FRAME'] };
    expect(() => draft(withBlock, asked)).toThrow(/BLOCK が含まれます/u);

    const text = path.join(work, 'BRK-1003.dxf');
    await cp(path.join(DATA, drawingPath('BRK-1003')), text);
    const failed = await failedDraft(text, changes, out);
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain(
      'the base must be the JSON that the office-reader skill prints',
    );
  });
}
