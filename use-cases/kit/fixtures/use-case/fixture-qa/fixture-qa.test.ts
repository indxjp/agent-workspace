/**
 * `describeUseCase` on the kit's fixture use case, with a catalog
 * entry and a recording of its own: the contract, moment and flow tiers all pass, and the flow runs
 * the fixture's skill script against the scripted workspace.
 * `kit/scoreboard.test.ts` also runs this file as a use case's own test.
 */
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import { defineEntry } from '../../../../../examples/store/catalog/define.ts';
import type { Recording } from '../../../../../examples/store/catalog/recording.ts';
import { describeUseCase } from '../../../describe-use-case.ts';
import agent from './agents/fixture-qa.ts';
import { tally } from './skills/tally/scripts/tally.mjs';
import surface from './surfaces/main.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));

const entry = defineEntry({
  slug: 'fixture-qa',
  area: 'mfg',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'use-cases/fixture-qa',
  name: { ja: 'フィクスチャ', en: 'Fixture' },
  summary: { ja: '答える。', en: 'Answers.' },
  demo: {
    agent: 'fixture-qa',
    prompts: [{ ja: '点検の周期は？', en: 'How often is the inspection?' }],
    moment: { ja: '出典を示す。', en: 'Cites the manual.' },
    data: { ja: 'マニュアル', en: 'manuals' },
    seed: [{ collection: 'fixture-qa', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['files'],
});

const recording = (lang: 'ja' | 'en', prompt: string): Recording => ({
  slug: 'fixture-qa',
  lang,
  recordedWith: 'scripted-model',
  turn: {
    prompt,
    stopReason: 'end_turn',
    steps: [
      {
        kind: 'tool',
        name: 'mcp__agent-workspace__search_files',
        input: { query: '点検' },
        output: 'fixture-qa/manual.md',
        isError: false,
      },
      { kind: 'answer', text: '6か月です〔manual.md〕' },
    ],
  },
});

describeUseCase('fixture-qa', {
  dir,
  definitions: { 'agents/fixture-qa.ts': agent, 'surfaces/main.ts': surface },
  catalog: [entry],
  recordings: [recording('ja', '点検の周期は？'), recording('en', 'How often is the inspection?')],
  flows: [
    {
      name: 'counts the rows of a CSV with its skill script, in a scripted run',
      run: async ({ project, workspace, runAndRead }) => {
        expect(project.skills.map((skill) => skill.name)).toEqual(['tally']);
        const { aw, agentId } = workspace(async ({ prompt }) =>
          Promise.resolve(`${String(tally(prompt))} rows`),
        );
        const reading = await runAndRead(aw, agentId, { prompt: 'id,name\n1,a\n2,b\n' });
        expect(reading.answer).toBe('2 rows');
        expect(tally('')).toBe(0);
      },
    },
  ],
});
