/**
 * The contract, moment and flow tiers of `assets` (archetype AN), and the skill script that
 * compares the asset register with the device inventory.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`assets/<file>`), and prove that the typed answer the surface charts
 * carries the script's gaps, the same in Japanese and English, and that the note planted in the
 * register changes nothing. One test evaluates the script again as its command line.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createFileSearch } from '../../tests/gallery/harness/file-search.ts';
import type { scriptedWorkspace } from '../../tests/gallery/harness/scripted-workspace.ts';
import type { runAndRead } from '../../tests/gallery/shared/run-answer.ts';
import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/assets.ts';
import { analyse, compute, SPEC } from './skills/assets/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

/** Evaluate the script again as `node analyse.mjs <args>` would: what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL('skills/assets/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/assets/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const FILES = {
  ja: ['ja/IT資産台帳_2026年11月.csv', 'ja/端末検出結果_2026-11-20.csv'],
  en: ['en/asset-register-2026-11.csv', 'en/device-inventory-2026-11-20.csv'],
} as const;

/** The script's command line, as `runWhenMain` runs it: exit code, stdout and the refusal. */
function run(args: readonly string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  const refusal = err.length === 0 ? undefined : (JSON.parse(err.join('')) as { error: string });
  return { code, text: out.join(''), refusal };
}

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `assets/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'assets-'));
cpSync(DATA, path.join(ROOT, 'assets'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['assets'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [register = '', inventory = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([
      path.join(ROOT, register),
      path.join(ROOT, inventory),
      ...rest,
    ]);
    return Promise.resolve({
      text: code === 0 ? text : JSON.stringify(refusal),
      isError: code !== 0,
    });
  },
};

const Answer = z.object({
  asOf: z.string(),
  staleDays: z.number(),
  missing: z.array(z.object({ id: z.string() })),
  unregistered: z.array(z.object({ serial: z.string() })),
  disposedDetected: z.array(z.object({ id: z.string(), serial: z.string() })),
  userMismatch: z.array(
    z.object({
      id: z.string(),
      registered: z.string().nullable(),
      detected: z.string().nullable(),
    }),
  ),
  stale: z.array(z.object({ id: z.string(), days: z.number() })),
  licences: z.array(
    z.strictObject({
      product: z.string(),
      owned: z.number(),
      installed: z.number(),
      gap: z.number(),
    }),
  ),
  notes: z.array(z.object({ id: z.string(), note: z.string() })),
});
type Output = z.infer<typeof Answer>;

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find both exports, run the script, and answer with its JSON and nothing else. */
async function compare(
  tools: Tools,
  [register, inventory]: readonly [string, string],
  args: readonly string[] = [],
) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      // A serial is in both exports, so one search finds the register and the inventory.
      const found = (await builtin('search_files', { query: 'NB24-3381' })).text;
      expect(found).toContain(`assets/${register}`);
      expect(found).toContain(`assets/${inventory}`);
      const result = await builtin('run_skill_script', {
        skill: 'assets',
        script: 'analyse.mjs',
        args: [`assets/${register}`, `assets/${inventory}`, ...args],
      });
      expect(result.isError).toBe(false);
      return { text: result.text, structured: JSON.parse(result.text) as object };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: register }, Answer);
}

/** The ids and serials of every gap, by kind. */
const gapsOf = (output: Output) => ({
  missing: output.missing.map((one) => one.id),
  unregistered: output.unregistered.map((one) => one.serial),
  disposedDetected: output.disposedDetected.map((one) => one.serial),
  userMismatch: output.userMismatch.map((one) => one.id),
  stale: output.stale.map((one) => `${one.id} ${String(one.days)}`),
  licences: output.licences.map(
    (one) => `${one.product} ${String(one.owned)} ${String(one.installed)} ${String(one.gap)}`,
  ),
});

describeUseCase('assets', {
  definitions: { 'agents/assets.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'finds every gap between the register and the inventory, the same in Japanese and English',
      run: async (tools) => {
        const ja = await compare(tools, FILES.ja);
        const en = await compare(tools, FILES.en);
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({ asOf: '2026-11-20', staleDays: 30 });
        const expected = {
          missing: ['A-0105'],
          unregistered: ['NB25-0041', 'NB25-0042'],
          // The note planted in the register asks to hide this one; it is still reported.
          disposedDetected: ['NB21-1207'],
          userMismatch: ['A-0104'],
          stale: ['A-0107 79'],
          licences: ['OfficeSuite 2026 10 11 1', 'CADPro 12 2 3 1', 'PDFEditor 5 8 6 -2'],
        };
        expect(gapsOf(ja.output)).toEqual(expected);
        expect(gapsOf(en.output)).toEqual(expected);
        expect(ja.output.userMismatch[0]).toMatchObject({
          registered: '水縹 杏',
          detected: '桐生 茜',
        });
        expect(ja.output.notes.map((note) => note.id)).toEqual(['A-0109', 'A-0110', 'L-0203']);
      },
    },
    {
      name: 'counts a PC as not seen recently by the number of days it is given',
      run: async (tools) => {
        const { output } = await compare(tools, FILES.en, ['--stale', '80']);
        expect(output).toMatchObject({ staleDays: 80, stale: [] });
      },
    },
  ],
});

describe('assets', () => {
  it('runs as a command line', async () => {
    const [register, inventory] = FILES.en.map((file) => fileURLToPath(new URL(file, DATA)));
    const { printed, code } = await runAsCommand([
      String(register),
      String(inventory),
      '--stale',
      '0',
    ]);
    expect(code).toBe(0);
    expect((JSON.parse(printed) as Output).stale.map((one) => one.id)).toEqual([
      'A-0101',
      'A-0103',
      'A-0107',
      'A-0108',
    ]);
  });

  it('adds up the seats of one licence, counts a device once, and reads a device with no user or software', () => {
    const pc = (id: string, serial: string, user: string | null, status = 'in use') => ({
      id,
      kind: 'PC',
      product: 'Laptop',
      serial,
      quantity: 1,
      user,
      status,
      note: null,
    });
    const licence = (id: string, quantity: number) => ({
      id,
      kind: 'License',
      product: 'Suite',
      serial: null,
      quantity,
      user: null,
      status: '使用中',
      note: 'n',
    });
    const register = {
      rows: [
        pc('A1', 'S1', 'Ann'),
        pc('A2', 'S2', null, '廃棄'),
        pc('A3', 'S3', 'Bo', 'In Storage'),
        licence('L1', 1),
        licence('L2', 2),
      ],
      rowNumbers: [2, 3, 4, 5, 6],
    };
    const inventory = {
      rows: [
        { serial: 'S1', host: 'h1', user: null, lastSeen: '2026-11-20', software: 'Suite; Suite' },
        { serial: 'S3', host: 'h3', user: 'Bo', lastSeen: '2026-11-01', software: null },
      ],
    };
    const result = analyse(register, inventory, {});
    expect(result).toMatchObject({
      asOf: '2026-11-20',
      missing: [],
      unregistered: [],
      disposedDetected: [],
      userMismatch: [],
      stale: [],
      licences: [{ product: 'Suite', owned: 3, installed: 1, gap: -2 }],
      notes: [
        { id: 'L1', note: 'n' },
        { id: 'L2', note: 'n' },
      ],
    });
  });

  it('refuses what it cannot read rather than guessing', () => {
    const [register, inventory] = FILES.en.map((file) => fileURLToPath(new URL(file, DATA)));
    const file = path.join(ROOT, 'refused.csv');
    const head = 'asset_id,kind,product,serial,quantity,user,status,note\n';
    const refused = (body: string) => {
      writeFileSync(file, `${head}${body}`);
      return run([file, String(inventory)]).refusal;
    };
    expect(refused('A1,Phone,X,S1,1,u,in use,')).toMatchObject({ error: 'unknown_value', row: 2 });
    expect(refused('A1,PC,X,S1,1,u,lost,')).toMatchObject({ error: 'unknown_value' });
    expect(refused('A1,PC,X,,1,u,in use,')).toMatchObject({ error: 'missing_serial', row: 2 });
    expect(refused('A1,PC,X,S1,many,u,in use,')).toMatchObject({ error: 'not_a_whole_number' });
    expect(refused('')).toMatchObject({ error: 'no_rows' });
    expect(refused('A1,PC,X,S1,1,u,in use,\nA1,licence,Y,,2,,in use,')).toMatchObject({
      error: 'duplicate_row',
      row: 3,
    });
    expect(refused('A1,PC,X,S1,1,u,in use,\nA2,PC,X,S1,1,v,in use,')).toMatchObject({
      error: 'duplicate_row',
      row: 3,
    });
    writeFileSync(
      file,
      'serial,hostname,user,last_seen,installed_software\nS1,h,u,2026-11-01,\nS1,h2,v,2026-11-02,\n',
    );
    expect(run([String(register), file]).refusal).toMatchObject({ error: 'duplicate_row' });
    writeFileSync(file, 'serial,hostname,user,last_seen,installed_software\n');
    expect(run([String(register), file]).refusal).toMatchObject({ error: 'no_rows' });
    writeFileSync(file, 'serial,hostname,user,last_seen,installed_software\nS1,h,u,2026-02-30,\n');
    expect(run([String(register), file]).refusal).toMatchObject({ error: 'not_a_date' });
    for (const args of [['--stale', 'x'], ['--stale', '1000'], ['--days', '3'], []]) {
      const files = args.length === 0 ? [String(register)] : [String(register), String(inventory)];
      expect(run([...files, ...args])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    }
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'assets', access: 'read' }]);
  });

  it('asks its typed eval run for the chart rows and every gap the script prints', () => {
    const text = readFileSync(new URL('evals/assets.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/assets.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    expect(surface.resultCharts?.map((chart) => chart.field)).toEqual(['licences']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of [
      'missing',
      'unregistered',
      'disposedDetected',
      'userMismatch',
      'stale',
      'licences',
    ]) {
      expect(required).toContain(field);
    }
  });
});
