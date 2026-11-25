/**
 * The contract checks refuse what SSOT §5.3 and §5.1 refuse, and ADR-0167 D5 (issue #2388): each
 * failing shape names its reason.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { EvalCaseFile } from '@indx-workspace/contracts/evaluations';
import {
  builtinSkill,
  defineAgent,
  files,
  skill,
  toAgentVersionBody,
} from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import { defineEntry } from '../../examples/store/catalog/define.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import {
  builtinImportProblems,
  catalogEntryProblems,
  evalProblems,
  folderProblems,
  OUTPUT_SUFFIX,
  unattendedWriteProblems,
} from './contract.ts';

const evalCase = (name: string, tags?: readonly string[]): EvalCaseFile['cases'][number] => ({
  name,
  input: name,
  expect: { contains: ['x'] },
  ...(tags === undefined ? {} : { tags }),
});

describe('evalProblems', () => {
  const four: EvalCaseFile = {
    cases: [
      evalCase('a', ['suggested']),
      evalCase('b', ['other-language']),
      evalCase('c', ['out-of-scope']),
      evalCase('d', ['safety', 'approval']),
    ],
  };

  it('accepts four cases of the four kinds at the bar', () => {
    expect(evalProblems('nda', four, 0.9)).toEqual([]);
    expect(evalProblems('nda', four, 0.95)).toEqual([]);
  });

  it('refuses a missing file, too few cases, a missing kind and a low or absent bar', () => {
    expect(evalProblems('nda', null, 0.9)).toEqual(['nda: no evals/nda.yaml']);
    expect(
      evalProblems('nda', { cases: [evalCase('a', ['suggested']), evalCase('b')] }, 0.8),
    ).toEqual([
      'nda: evals/nda.yaml has 2 cases, fewer than 4',
      'nda: no eval case tagged other-language, out-of-scope, safety',
      'nda: agent-workspace.yaml policy.promotion.minEvalScore is 0.8, below 0.9',
    ]);
    expect(evalProblems('nda', four, undefined)).toEqual([
      'nda: agent-workspace.yaml policy.promotion.minEvalScore is undefined, below 0.9',
    ]);
  });
});

describe('catalogEntryProblems', () => {
  const dir = fileURLToPath(new URL('./fixtures/use-case/fixture-qa', import.meta.url));
  const agent = { name: 'fixture-qa', files: [{ path: 'fixture-qa' }] };
  const live = (overrides: {
    source?: string;
    agent?: string;
    from?: string;
    collection?: string;
  }) =>
    defineEntry({
      slug: 'fixture-qa',
      area: 'mfg',
      status: 'live',
      wave: 1,
      kind: 'agent',
      source: overrides.source ?? 'use-cases/fixture-qa',
      name: { ja: 'あ', en: 'A' },
      summary: { ja: 'あ', en: 'A' },
      demo: {
        agent: overrides.agent ?? 'fixture-qa',
        prompts: [{ ja: 'あ', en: 'A' }],
        moment: { ja: 'あ', en: 'A' },
        data: { ja: 'あ', en: 'A' },
        seed: [
          { collection: overrides.collection ?? 'fixture-qa', from: overrides.from ?? 'data/ja' },
        ],
      },
      safety: ['files'],
    });

  it('accepts a live entry whose source, demo agent and seed agree', () => {
    expect(
      catalogEntryProblems('fixture-qa', { dir, name: 'fixture-qa', agents: [agent] }, [live({})]),
    ).toEqual([]);
  });

  it('refuses no entry, a wrongly named project, another source, a missing agent or seed', () => {
    const source = { dir, name: 'fixture-qa', agents: [agent] };
    expect(catalogEntryProblems('fixture-qa', source, [])).toEqual([
      'fixture-qa: no catalog entry',
    ]);
    expect(catalogEntryProblems('fixture-qa', { ...source, name: 'other' }, [live({})])).toEqual([
      'fixture-qa: agent-workspace.yaml is named other',
    ]);
    expect(
      catalogEntryProblems('fixture-qa', source, [live({ source: 'tests/gallery/fixture-qa' })]),
    ).toEqual(["fixture-qa: the entry's source is tests/gallery/fixture-qa"]);
    expect(catalogEntryProblems('fixture-qa', source, [live({ agent: 'nobody' })])).toEqual([
      'fixture-qa: no agent nobody for the demo',
    ]);
    expect(
      catalogEntryProblems('fixture-qa', source, [
        live({ collection: 'rules', from: 'data/none' }),
      ]),
    ).toEqual([
      'fixture-qa: seeds rules, which fixture-qa is not granted',
      'fixture-qa: no seed folder data/none',
    ]);
    expect(
      catalogEntryProblems('fixture-qa', { ...source, agents: [{ name: 'fixture-qa' }] }, [
        live({}),
      ]),
    ).toEqual(['fixture-qa: seeds fixture-qa, which fixture-qa is not granted']);
  });

  it('checks a live entry with a staged rebuild (next, ADR-0174) as that rebuild', () => {
    const source = { dir, name: 'fixture-qa', agents: [agent] };
    const current = live({ source: 'tests/gallery/fixture-qa', agent: 'gallery-agent' });
    const own = live({});
    if (current.status !== 'live' || own.status !== 'live')
      throw new Error('the fixtures are live');
    const rebuilt = defineEntry({
      ...current,
      next: { source: 'use-cases/fixture-qa', demo: own.demo },
    });
    expect(catalogEntryProblems('fixture-qa', source, [rebuilt])).toEqual([]);
    const wrongAgent = defineEntry({
      ...current,
      next: { source: 'use-cases/fixture-qa', demo: { ...own.demo, agent: 'nobody' } },
    });
    expect(catalogEntryProblems('fixture-qa', source, [wrongAgent])).toEqual([
      'fixture-qa: no agent nobody for the demo',
    ]);
  });

  it('refuses an app entry pointing at the use case', () => {
    const app = { ...live({}), kind: 'app' as const };
    expect(
      catalogEntryProblems('fixture-qa', { dir, name: 'fixture-qa', agents: [agent] }, [app]),
    ).toEqual(["fixture-qa: the entry's kind is app"]);
  });
});

describe('folderProblems', () => {
  it('accepts the slug, its output folder, their subfolders, and an agent with no grant', () => {
    const grants = [
      { path: 'nda' },
      { path: 'nda/inbox' },
      { path: 'nda-reports' },
      { path: 'nda-reports/2026' },
    ];
    expect(folderProblems('nda', [{ name: 'nda', files: grants }, { name: 'nda-helper' }])).toEqual(
      [],
    );
  });

  it('can rely on no catalog slug ending in the output suffix', () => {
    // Otherwise entry `x`'s output folder `x-reports` would be entry `x-reports`'s own folder.
    expect(CATALOG.filter((entry) => entry.slug.endsWith(OUTPUT_SUFFIX))).toEqual([]);
  });

  it('refuses a folder another entry could also name', () => {
    const grants = [
      'reports',
      'ndafiles',
      'inbox/nda',
      'ndax-reports',
      'nda-other',
      'nda-reportsx',
    ];
    expect(
      folderProblems('nda', [{ name: 'nda', files: grants.map((path) => ({ path })) }]),
    ).toEqual(
      grants.map(
        (path) =>
          `nda: grants ${path}, which is not named from nda (nda, nda-reports or a subfolder of either)`,
      ),
    );
  });
});

describe('unattendedWriteProblems (ADR-0167 D5, #2388)', () => {
  const RUN_SKILL_SCRIPT = 'mcp__agent-workspace__run_skill_script';
  interface Shape {
    readonly skills?: readonly ('office-writer' | 'office-reader')[];
    readonly autoApprove?: readonly string[];
    readonly writeFiles?: boolean;
    readonly grants?: readonly (readonly [string, 'read' | 'read-write'])[];
  }
  const body = (name: string, shape: Shape = {}): AgentVersionBody =>
    toAgentVersionBody(
      defineAgent({
        name,
        instructions: 'Review the document.',
        permissions: { readFiles: true, runCommands: true, writeFiles: shape.writeFiles ?? false },
        skills: (shape.skills ?? []).map((skill) => builtinSkill(skill)),
        files: (shape.grants ?? []).map(([grant, access]) => files(grant, access)),
        ...(shape.autoApprove === undefined
          ? {}
          : { engine: { id: 'claude-agent-sdk', autoApprove: shape.autoApprove } as const }),
      }),
      { surfaces: [], instructions: undefined },
    );
  const reason = (name: string, writers: string): string =>
    `${name}: ${writers} and auto-approves run_skill_script, so a skill script would write a file without approval (ADR-0167 D5, #2388)`;

  it('refuses a compiled agent that grants office-writer and auto-approves run_skill_script', () => {
    for (const rule of [RUN_SKILL_SCRIPT, 'mcp__agent-workspace__*']) {
      const proposal = body('proposal', { skills: ['office-writer'], autoApprove: [rule] });
      expect(unattendedWriteProblems([proposal]), rule).toEqual([
        reason('proposal', 'grants office-writer'),
      ]);
    }
  });

  it('refuses a reader whose scripts may write: writeFiles or a read-write grant', () => {
    const autoApprove = [RUN_SKILL_SCRIPT];
    expect(
      unattendedWriteProblems([
        body('a', { skills: ['office-reader'], autoApprove, writeFiles: true }),
        body('b', { skills: ['office-reader'], autoApprove, grants: [['reports', 'read-write']] }),
        body('c', {
          skills: ['office-reader'],
          autoApprove: ['mcp__agent-workspace__*'],
          writeFiles: true,
          grants: [
            ['inbox', 'read'],
            ['reports', 'read-write'],
          ],
        }),
      ]),
    ).toEqual([
      reason('a', 'holds writeFiles'),
      reason('b', 'grants reports read-write'),
      reason('c', 'holds writeFiles, grants reports read-write'),
    ]);
  });

  it('refuses an office-writer agent that auto-approves Bash, which writes outside the outputs/ deny', () => {
    const shell = (name: string): string =>
      `${name}: grants office-writer and auto-approves Bash, so a shell command could write a file outside the outputs/ deny without approval (ADR-0167 D5, #2420)`;
    expect(
      unattendedWriteProblems([
        body('a', { skills: ['office-writer'], autoApprove: ['Bash'] }),
        body('b', { skills: ['office-writer'], autoApprove: ['Bash(cp *)'] }),
        body('c', { skills: ['office-writer'], autoApprove: ['Bash', RUN_SKILL_SCRIPT] }),
      ]),
    ).toEqual([shell('a'), shell('b'), reason('c', 'grants office-writer'), shell('c')]);
  });

  it('accepts Bash auto-approved by an agent without office-writer, and office-writer with Bash gated', () => {
    expect(
      unattendedWriteProblems([
        body('a', { skills: ['office-reader'], autoApprove: ['Bash'] }),
        body('b', { autoApprove: ['Bash'], writeFiles: true }),
        body('c', {
          skills: ['office-writer'],
          autoApprove: ['mcp__agent-workspace__search_files'],
        }),
      ]),
    ).toEqual([]);
  });

  it('refuses one whose policy runs every call unattended', () => {
    const compiled = body('slides', { skills: ['office-writer'] });
    const { policy } = compiled.definition;
    if (!('tools' in policy)) throw new Error('expected the Claude policy');
    const bypassing: AgentVersionBody = {
      ...compiled,
      definition: {
        ...compiled.definition,
        policy: { ...policy, tools: { ...policy.tools, permissionMode: 'bypassPermissions' } },
      },
    };
    expect(unattendedWriteProblems([bypassing])).toEqual([
      reason('slides', 'grants office-writer'),
    ]);
  });

  it('accepts writers behind approval, and run_skill_script auto-approved when no script can write', () => {
    expect(
      unattendedWriteProblems([
        body('a', {
          skills: ['office-writer'],
          autoApprove: ['mcp__agent-workspace__search_files'],
        }),
        body('b', { skills: ['office-writer'] }),
        body('c', {
          skills: ['office-reader'],
          writeFiles: true,
          grants: [['reports', 'read-write']],
          autoApprove: ['mcp__agent-workspace__search_files'],
        }),
        // A read-only reader (the QA shape): its scripts cannot write, so they may run unasked.
        body('d', {
          skills: ['office-reader'],
          grants: [['manuals', 'read']],
          autoApprove: [RUN_SKILL_SCRIPT, 'mcp__agent-workspace__search_files'],
        }),
        toAgentVersionBody(
          defineAgent({
            name: 'e',
            instructions: 'x',
            engine: 'openai-agents',
            permissions: { writeFiles: true },
            skills: [builtinSkill('office-writer')],
          }),
          { surfaces: [], instructions: undefined },
        ),
      ]),
    ).toEqual([]);
  });
});

describe('builtinImportProblems (ADR-0173)', () => {
  const IMPORT = `import { readTable } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';\n`;

  async function project(files: Readonly<Record<string, string>>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'builtin-imports-'));
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
    return dir;
  }
  const body = (skills: readonly ('office-reader' | 'budget')[]): AgentVersionBody =>
    toAgentVersionBody(
      defineAgent({
        name: 'budget',
        instructions: 'Compute the variance.',
        permissions: { readFiles: true, runCommands: true },
        skills: skills.map((name) => (name === 'budget' ? skill('budget') : builtinSkill(name))),
      }),
      { surfaces: [], instructions: undefined },
    );

  it('passes a script that imports office-reader when the agent grants it', async () => {
    const dir = await project({ 'skills/budget/scripts/analyse.mjs': IMPORT });
    expect(builtinImportProblems(dir, [body(['office-reader', 'budget'])])).toEqual([]);
  });

  it('refuses a script, nested ones included, that imports a built-in skill the agent does not grant', async () => {
    const dir = await project({
      'skills/budget/scripts/analyse.mjs': IMPORT,
      'skills/budget/scripts/lib/rules.ts': IMPORT,
      'skills/budget/scripts/notes.md': IMPORT,
      'skills/budget/SKILL.md': IMPORT,
    });
    const reason = (file: string): string =>
      `budget: skills/budget/scripts/${file} imports @indx-workspace/builtin-skills/office-reader/, so the agent grants builtinSkill('office-reader') (ADR-0173)`;
    expect(builtinImportProblems(dir, [body(['budget'])])).toEqual([
      reason('analyse.mjs'),
      reason('lib/rules.ts'),
    ]);
  });

  it('passes a skill without scripts, and a granted skill whose folder the entry does not hold', async () => {
    const dir = await project({ 'skills/budget/SKILL.md': '# budget\n' });
    expect(builtinImportProblems(dir, [body(['office-reader', 'budget'])])).toEqual([]);
  });
});
