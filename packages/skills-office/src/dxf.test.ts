/**
 * The office-reader skill's DXF script, run as an agent runs it: under `node --permission` with read
 * access to the file's directory only. The drawings are written here as group-code pairs.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { DXF_MAX_FILE_BYTES, DxfRefusal, readDxf } from '../office-reader/scripts/dxf.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'office-reader',
  'scripts',
  'dxf.mjs',
);
const run = promisify(execFile);

type Pair = readonly [number, string | number];

const text = (pairs: readonly Pair[]) =>
  `${pairs.map(([code, value]) => `${String(code).padStart(3)}\r\n${value}`).join('\r\n')}\r\n`;

const section = (name: string, body: readonly Pair[]): Pair[] => [
  [0, 'SECTION'],
  [2, name],
  ...body,
  [0, 'ENDSEC'],
];

const header = (version: string, codepage?: string): Pair[] =>
  section('HEADER', [
    [9, '$ACADVER'],
    [1, version],
    ...(codepage === undefined
      ? []
      : ([
          [9, '$DWGCODEPAGE'],
          [3, codepage],
        ] as Pair[])),
  ]);

async function runScript(content: Buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dxf-'));
  const file = path.join(dir, 'in.dxf');
  await writeFile(file, content);
  try {
    return await run(process.execPath, ['--permission', `--allow-fs-read=${dir}`, SCRIPT, file]);
  } catch (error) {
    const { code, stderr, stdout } = error as { code: number; stderr: string; stdout: string };
    return { code, stderr, stdout };
  }
}

const refusal = (result: { stderr?: string }) =>
  JSON.parse(result.stderr ?? '{}') as { error: string };

describe('office-reader dxf.mjs', () => {
  it('reads a UTF-8 drawing: layers, blocks, every kind of text, and counts', () => {
    const drawing = text([
      [999, 'made by a test'],
      ...header('AC1027', 'ANSI_1252'),
      ...section('TABLES', [
        [0, 'TABLE'],
        [2, 'LAYER'],
        [0, 'LAYER'],
        [2, '壁'],
        [0, 'LAYER'],
        [2, 'DIM'],
        [0, 'ENDTAB'],
      ]),
      ...section('BLOCKS', [
        [0, 'BLOCK'],
        [2, 'DOOR'],
        [0, 'TEXT'],
        [8, '壁'],
        [1, 'D-01'],
        [0, 'ENDBLK'],
      ]),
      ...section('ENTITIES', [
        [0, 'LINE'],
        [8, '壁'],
        [10, 0],
        [20, 0],
        [0, 'LINE'],
        [8, '壁'],
        [0, 'TEXT'],
        [8, '壁'],
        [10, 12.5],
        [20, 3],
        [1, '玄関 %%c25 \\U+00B1%%p1'],
        [0, 'MTEXT'],
        [8, '注記'],
        [10, 1],
        [20, 2],
        [3, '{\\fMS Gothic|b0;施工}\\P'],
        [1, '\\S1/2;図 \\~参照'],
        [0, 'ATTRIB'],
        [8, '壁'],
        [2, 'ROOM'],
        [1, '応接室'],
        [0, 'DIMENSION'],
        [8, 'DIM'],
        [1, ''],
        [42, 3600],
        [0, 'INSERT'],
        [2, 'DOOR'],
        [8, '壁'],
        [10, 5],
        [20, 6],
      ]),
      [0, 'EOF'],
    ]);
    expect(readDxf(Buffer.from(drawing, 'utf8'))).toStrictEqual({
      version: 'AC1027',
      codepage: 'ANSI_1252',
      layers: ['壁', 'DIM'],
      blocks: ['DOOR'],
      counts: { TEXT: 2, LINE: 2, MTEXT: 1, ATTRIB: 1, DIMENSION: 1, INSERT: 1 },
      texts: [
        { type: 'TEXT', block: 'DOOR', layer: '壁', text: 'D-01' },
        { type: 'TEXT', layer: '壁', text: '玄関 ⌀25 ±±1', x: 12.5, y: 3 },
        { type: 'MTEXT', layer: '注記', text: '施工\n1/2図  参照', x: 1, y: 2 },
        { type: 'ATTRIB', layer: '壁', tag: 'ROOM', text: '応接室' },
        { type: 'DIMENSION', layer: 'DIM', text: '', measurement: 3600 },
      ],
      inserts: [{ name: 'DOOR', layer: '壁', x: 5, y: 6 }],
      lines: [{ layer: '壁', x1: 0, y1: 0 }, { layer: '壁' }],
      circles: [],
    });
  });

  it('reads the coordinates of LINE and CIRCLE, and a text height, as written', () => {
    const drawing = text([
      ...header('AC1027'),
      ...section('BLOCKS', [
        [0, 'BLOCK'],
        [2, 'FRAME'],
        [0, 'LINE'],
        [8, '0'],
        [10, 1],
        [20, 2],
        [11, 3],
        [21, 4],
        [0, 'ENDBLK'],
      ]),
      ...section('ENTITIES', [
        [0, 'LINE'],
        [8, 'OUTLINE'],
        [10, -5.5],
        [20, 0],
        [30, 0],
        [11, 140],
        [21, 0.25],
        [31, 0],
        [0, 'CIRCLE'],
        [8, 'HOLE'],
        [10, 15],
        [20, 15],
        [40, 4.5],
        [0, 'TEXT'],
        [8, 'TITLE'],
        [10, 0],
        [20, -10],
        [40, 3.5],
        [1, '図番 BRK-1001'],
        [0, 'DIMENSION'],
        [8, 'DIM'],
        [1, ''],
        [40, 99],
        [42, 140],
        [0, 'ARC'],
        [8, 'OUTLINE'],
      ]),
      [0, 'EOF'],
    ]);
    const read = readDxf(Buffer.from(drawing, 'utf8'));
    expect(read.lines).toStrictEqual([
      { block: 'FRAME', layer: '0', x1: 1, y1: 2, x2: 3, y2: 4 },
      { layer: 'OUTLINE', x1: -5.5, y1: 0, x2: 140, y2: 0.25 },
    ]);
    expect(read.circles).toStrictEqual([{ layer: 'HOLE', x: 15, y: 15, r: 4.5 }]);
    expect(read.texts).toStrictEqual([
      { type: 'TEXT', layer: 'TITLE', text: '図番 BRK-1001', height: 3.5, x: 0, y: -10 },
      { type: 'DIMENSION', layer: 'DIM', text: '', measurement: 140 },
    ]);
    expect(read.counts).toMatchObject({ LINE: 2, CIRCLE: 1, ARC: 1 });
  });

  it('decodes an older drawing by its code page (Shift-JIS) and reads \\U+ escapes', () => {
    const head = `${text([
      ...header('AC1015', 'ANSI_932'),
      [0, 'SECTION'],
      [2, 'ENTITIES'],
      [0, 'TEXT'],
      [8, '0'],
    ])}  1\r\n`;
    const tail = ` \\U+65E5\r\n${text([
      [0, 'ENDSEC'],
      [0, 'EOF'],
    ])}`;
    // "図面" in Shift-JIS.
    const bytes = Buffer.concat([
      Buffer.from(head, 'latin1'),
      Buffer.from([0x90, 0x7d, 0x96, 0xca]),
      Buffer.from(tail, 'latin1'),
    ]);
    expect(readDxf(bytes).texts).toStrictEqual([{ type: 'TEXT', layer: '0', text: '図面 日' }]);
  });

  it('refuses a binary DXF, an unknown code page and a non-DXF by name', async () => {
    const binary = await runScript(Buffer.from('AutoCAD Binary DXF\r\n\u001a\u0000'));
    expect(binary).toMatchObject({ code: 1, stdout: '' });
    expect(refusal(binary)).toMatchObject({ error: 'binary_dxf' });

    const dos = Buffer.from(text([...header('AC1015', 'DOS437'), [0, 'EOF']]), 'latin1');
    expect(() => readDxf(dos)).toThrow(DxfRefusal);
    expect(refusal(await runScript(dos))).toMatchObject({ error: 'unsupported_codepage' });

    expect(refusal(await runScript(Buffer.from('<html>not a drawing</html>\n')))).toMatchObject({
      error: 'not_a_dxf',
    });
    expect(refusal(await runScript(Buffer.from('PK\u0003\u0004\u0000\u0000')))).toMatchObject({
      error: 'not_a_dxf',
    });
  });

  it('runs under the permission model and prints JSON', async () => {
    const result = await runScript(
      Buffer.from(
        text([
          ...header('AC1027'),
          ...section('ENTITIES', [
            [0, 'TEXT'],
            [1, 'ok'],
          ]),
          [0, 'EOF'],
        ]),
      ),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ texts: [{ text: 'ok' }] });
  });

  it('with an output path writes the same JSON there and prints only where', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dxf-out-'));
    const file = path.join(dir, 'in.dxf');
    await writeFile(
      file,
      text([
        ...header('AC1027'),
        ...section('ENTITIES', [
          [0, 'TEXT'],
          [1, 'ok'],
        ]),
        [0, 'EOF'],
      ]),
    );
    const printed = await run(process.execPath, [
      '--permission',
      `--allow-fs-read=${dir}`,
      SCRIPT,
      file,
    ]);
    const out = path.join('drafts', 'base.json');
    const written = await run(
      process.execPath,
      ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, SCRIPT, file, out],
      { cwd: dir },
    );
    expect(JSON.parse(written.stdout)).toStrictEqual({ written: out });
    expect(await readFile(path.join(dir, out), 'utf8')).toBe(printed.stdout);
  });

  it('refuses a file past the size cap, in memory and before the command reads it', async () => {
    expect(() => readDxf(Buffer.alloc(DXF_MAX_FILE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: 'file_too_large' }) as Error,
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'dxf-big-'));
    const file = path.join(dir, 'big.dxf');
    await writeFile(file, '');
    await truncate(file, DXF_MAX_FILE_BYTES + 1);
    await expect(
      run(process.execPath, ['--permission', `--allow-fs-read=${dir}`, SCRIPT, file]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('"error":"file_too_large"') as string,
    });
  });
});
