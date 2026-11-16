import { describe, expect, it } from 'vitest';

import {
  maskStrings,
  RUN_DIRECTORY_PLACEHOLDER,
  runDirectoryMask,
  withoutRunDirectory,
} from './host-paths';
import type { SseWireEvent } from './sse';

const WS = '6bf9b005-4946-4ff4-87bb-7debe6bf8602';
const SESSION = '12046786-460e-4b43-bbe4-0cbf4d19cfc6';
const ROOT = '/private/tmp/claude-501/scratchpad/runner-ws';
const CWD = `${ROOT}/${WS}/${SESSION}`;

function mask(text: string): string {
  const masker = runDirectoryMask(WS, SESSION);
  if (masker === null) throw new Error('expected a mask');
  return masker(text);
}

describe('runDirectoryMask', () => {
  it.each([
    [CWD, RUN_DIRECTORY_PLACEHOLDER],
    [`${CWD}/`, `${RUN_DIRECTORY_PLACEHOLDER}/`],
    [
      `File created successfully at: ${CWD}/outputs/report.md`,
      `File created successfully at: ${RUN_DIRECTORY_PLACEHOLDER}/outputs/report.md`,
    ],
    [`cd ${CWD} && mkdir -p outputs`, `cd ${RUN_DIRECTORY_PLACEHOLDER} && mkdir -p outputs`],
    [`{"cwd":"${CWD}"}`, `{"cwd":"${RUN_DIRECTORY_PLACEHOLDER}"}`],
    [`cwd=${CWD}`, `cwd=${RUN_DIRECTORY_PLACEHOLDER}`],
    [`(${CWD}/a.txt)`, `(${RUN_DIRECTORY_PLACEHOLDER}/a.txt)`],
    [
      `${CWD}/outputs/report.md に書きました`,
      `${RUN_DIRECTORY_PLACEHOLDER}/outputs/report.md に書きました`,
    ],
    [`レポートを${CWD}に保存`, `レポートを${RUN_DIRECTORY_PLACEHOLDER}に保存`],
    [`/workspace/${WS}/${SESSION}/.claude`, `${RUN_DIRECTORY_PLACEHOLDER}/.claude`],
    [`C:\\runs\\${WS}\\${SESSION}\\out.md`, `${RUN_DIRECTORY_PLACEHOLDER}\\out.md`],
    [`file://${CWD}/a`, `file:${RUN_DIRECTORY_PLACEHOLDER}/a`],
    [`${CWD} and ${CWD}/b`, `${RUN_DIRECTORY_PLACEHOLDER} and ${RUN_DIRECTORY_PLACEHOLDER}/b`],
  ])('masks the run directory in %j', (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it.each([
    ['', ''],
    ['no paths here', 'no paths here'],
    [`${ROOT}/${WS}/other-session/x`, `${ROOT}/${WS}/other-session/x`],
    [`${ROOT}/other-ws/${SESSION}/x`, `${ROOT}/other-ws/${SESSION}/x`],
    [`${ROOT}/${WS}/${SESSION}-2/x`, `${ROOT}/${WS}/${SESSION}-2/x`],
    [`session ${SESSION} finished`, `session ${SESSION} finished`],
  ])('leaves %j alone', (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  // Each input took minutes before the mask read a string once: a run of slashes before the ids,
  // and many run paths in one token with no space between them. The test's timeout is the bound.
  it('reads a 1 MB string once, whatever it holds', () => {
    const slashes = `${'/'.repeat(1_000_000)}x ${CWD}`;
    expect(mask(slashes)).toBe(`${'/'.repeat(1_000_000)}x ${RUN_DIRECTORY_PLACEHOLDER}`);
    const joined = `:${CWD}`.repeat(5_000);
    expect(joined.length).toBeGreaterThan(500_000);
    expect(mask(joined)).toBe(`:${RUN_DIRECTORY_PLACEHOLDER}`.repeat(5_000));
    const prose = `${'a'.repeat(1_000)}${CWD}/f `.repeat(1_000);
    expect(mask(prose)).toBe(`${'a'.repeat(1_000)}${RUN_DIRECTORY_PLACEHOLDER}/f `.repeat(1_000));
  });

  it('masks nothing when an id is empty, rather than every path', () => {
    expect(runDirectoryMask('', SESSION)).toBeNull();
    expect(runDirectoryMask(WS, '')).toBeNull();
  });
});

describe('maskStrings', () => {
  it('masks strings at any depth and keeps every other value', () => {
    const value = {
      cwd: CWD,
      tools: ['Bash', `${CWD}/tool`],
      nested: { [`${CWD}/key`]: { n: 1, ok: true, none: null } },
    };
    expect(maskStrings(value, mask)).toEqual({
      cwd: RUN_DIRECTORY_PLACEHOLDER,
      tools: ['Bash', `${RUN_DIRECTORY_PLACEHOLDER}/tool`],
      nested: { [`${RUN_DIRECTORY_PLACEHOLDER}/key`]: { n: 1, ok: true, none: null } },
    });
  });

  it('returns any object that is not plain as it is', () => {
    const at = new Date('2026-11-05T00:00:00Z');
    const bytes = new Uint8Array([1, 2]);
    // toStrictEqual compares classes: a Date or bytes walked into `{}` fails here.
    expect(maskStrings({ at, bytes, path: CWD }, mask)).toStrictEqual({
      at,
      bytes,
      path: RUN_DIRECTORY_PLACEHOLDER,
    });
  });
});

describe('withoutRunDirectory', () => {
  it('masks every frame of the run and keeps its id, name and time', async () => {
    const at = new Date('2026-11-05T00:00:00Z');
    async function* source(): AsyncGenerator<SseWireEvent> {
      await Promise.resolve();
      yield { id: 1n, type: 'agent.session', data: { raw: { cwd: CWD } }, at };
      yield { id: '2.0', type: 'agent.tool.result', data: { output: `${CWD}/a.md` } };
    }
    const served: SseWireEvent[] = [];
    for await (const event of withoutRunDirectory(source(), {
      workspaceId: WS,
      sessionId: SESSION,
    })) {
      served.push(event);
    }
    expect(served).toEqual([
      { id: 1n, type: 'agent.session', data: { raw: { cwd: RUN_DIRECTORY_PLACEHOLDER } }, at },
      {
        id: '2.0',
        type: 'agent.tool.result',
        data: { output: `${RUN_DIRECTORY_PLACEHOLDER}/a.md` },
      },
    ]);
  });
});
