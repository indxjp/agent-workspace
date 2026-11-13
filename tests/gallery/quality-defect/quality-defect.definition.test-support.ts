import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  readXlsx,
  writeXlsx,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { policyWidenings } from '@indx-workspace/contracts/policy-ceiling';
import { defineAgent, mcp, skill } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { PFMEA_SHEETS, writePfmea } from './data/fmea-workbook.ts';
import { qms as qmsTool } from './tools/qms.ts';
import {
  DIR,
  FMEA,
  OOXML_SCRIPT,
  run,
  project,
  NOT_FOUND,
  effectiveOf,
} from './quality-defect.fixture.test-support.ts';

export function defineDefinitionCases(): void {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    // No web tools reach a run of this agent, whatever the model asks for.
    const policy = definition?.policy;
    if (policy?.engine !== 'claude-agent-sdk') throw new Error('expected a Claude policy');
    expect(policy.tools.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
    // ...and Bash stays denied; run_skill_script runs the eight-d script and is pre-approved: an
    // unattended run cannot answer an approval prompt. The one write, registering the case as a
    // 過去トラ, is the call the DR decides (ADR-0145), and it is not a file write. The agent names
    // no gate of its own: `createCase` is gated because the tool admits it by operation id.
    expect(policy.tools.deny).not.toContain('Bash');
    expect(policy.tools.autoApprove).toStrictEqual(['mcp__agent-workspace__run_skill_script']);
    expect(policy.requireApproval ?? []).toStrictEqual([]);
    expect(definition?.resources).toMatchObject({
      connectors: ['qms'],
      skills: ['office-reader', 'eight-d'],
      files: [{ path: 'fmea', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('causeStats');
    // The no-match answer is the first rule, exclusive, and the eval's exact sentence.
    const instructions = definition?.agent.instructions ?? '';
    expect(instructions).toContain(NOT_FOUND);
    expect(instructions.indexOf(NOT_FOUND)).toBeLessThan(instructions.indexOf('手順:'));
    expect(instructions).toContain('他のツールを呼ばず');
    expect(instructions).toContain('`noMatch: true`');
    const [surface] = agent?.body.surfaces ?? [];
    expect(surface).toMatchObject({
      name: 'qa',
      layout: 'page',
      parts: { toolTrace: 'full', feedback: true },
      toolResults: { searchDefects: 'table' },
    });
    expect(project.skills.map((entry) => entry.name).sort()).toStrictEqual([
      'eight-d',
      'office-reader',
    ]);
    expect(project.project.connectors ?? {}).toStrictEqual({});
    expect(
      project.skills
        .find((entry) => entry.name === 'eight-d')
        ?.files.map((file) => file.path)
        .sort(),
    ).toStrictEqual([
      'SKILL.md',
      'examples/8d-sample.md',
      'scripts/eightd.d.mts',
      'scripts/eightd.mjs',
    ]);
  });

  it('the FMEA is an Excel workbook that office-reader reads back as fmea-workbook.ts has it (GALLERY_WRITE=1 regenerates it)', async () => {
    if (process.env['GALLERY_WRITE'] === '1') writePfmea(FMEA);
    expect(readXlsx(await readFile(FMEA))).toEqual(readXlsx(writeXlsx({ sheets: PFMEA_SHEETS })));
    expect(existsSync(path.join(DIR, 'data', 'fmea', 'press-pfmea.md'))).toBe(false);

    // The agent's own call: the skill script under the permission model, no shell.
    const { stdout } = await run(process.execPath, [
      '--permission',
      `--allow-fs-read=${path.dirname(FMEA)}`,
      OOXML_SCRIPT,
      'xlsx',
      FMEA,
    ]);
    const [sheet] = (JSON.parse(stdout) as { sheets: { name: string; rows: unknown[][] }[] })
      .sheets;
    const header = sheet?.rows.findIndex((row) => row[0] === 'No.') ?? -1;
    expect(sheet?.rows[header]).toContain('関連過去トラ');
    const burr = sheet?.rows.find((row) => row[0] === 'P-03-01');
    expect(burr).toContain('パンチ刃先摩耗によるクリアランス拡大');
    expect(burr).toContain('Q-1003, Q-1011, Q-1042');

    const instructions = project.agents[0]?.body.definition.agent.instructions ?? '';
    expect(instructions).toContain('ooxml.mjs');
    expect(instructions).toContain('fmea/press-pfmea.xlsx');
  });

  it('the policy ceiling keeps defect data inside: no network, one tool, a budget', () => {
    const policy = project.project.policy;
    expect(policy?.permissions).toStrictEqual({ writeFiles: false, unrestrictedNetwork: false });
    expect(policy?.limits).toStrictEqual({ maxTurns: 20, maxBudgetUsd: 1.5 });
    expect(policy?.tools).toStrictEqual(['qms']);
    expect(policy?.promotion?.minEvalScore).toBe(0.9);

    const agent = project.agents[0]?.definition;
    if (agent === undefined) throw new Error('no agent');
    expect(policyWidenings(effectiveOf(agent), policy)).toStrictEqual([]);

    // Someone adds web search "to compare with industry cases": the ceiling refuses every part.
    const widened = defineAgent({
      ...agent,
      permissions: { ...agent.permissions, unrestrictedNetwork: true },
      tools: [qmsTool, mcp('web-search')],
      skills: [skill('eight-d')],
      limits: { maxTurns: 16, maxBudgetUsd: 5 },
    });
    expect(policyWidenings(effectiveOf(widened), policy)).toStrictEqual([
      'permissions.unrestrictedNetwork',
      'limits.maxBudgetUsd',
      'tool:web-search',
    ]);
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(5);
    expect(cases.some((entry) => entry.expect.notContains?.includes('〔過去トラ'))).toBe(true);
    expect(cases.some((entry) => entry.expect.judge !== undefined)).toBe(true);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
  });
}
