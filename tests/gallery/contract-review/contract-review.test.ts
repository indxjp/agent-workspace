/**
 * Use case 7, the contract review agent: the definition passes the contract, the two skill scripts
 * read real Word drafts and find every planted issue (and nothing in standard wording), and the
 * backend refuses to call a review complete when the agent's risk table leaves out a finding the
 * playbook says must always be raised. See `../README.md` for the tiers and what each proves.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type Script,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import { readDocx, writeDocx } from '../shared/skills/office-reader/scripts/ooxml.mjs';
import {
  enforceMustFlags,
  parseRiskTable,
  reviewContract,
  reviewPrompt,
} from './backend/review.ts';
import { DRAFTS, NDA, SERVICE_AGREEMENT, SUPPLY_AGREEMENT, type Draft } from './data/drafts.ts';
import {
  check,
  DETECTORS,
  loadPlaybook,
  splitClauses,
  type CheckResult,
  type DocxParagraph,
  type PlaybookRule,
  type SplitDocument,
} from './skills/contract-playbook/scripts/clauses.mjs';
import agentDefinition from './agents/contract-review.ts';
import surfaceDefinition from './surfaces/legal-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
/** The drafts as Word files: what the install-live harness and the tutorial upload into `contracts`. */
const CONTRACTS = path.join(DIR, 'data', 'contracts');
const PLAYBOOK = loadPlaybook(path.join(DIR, 'data', 'playbook'));

let project: GalleryProject;
/**
 * A run's working directory as the runner lays it out: the granted files (`contracts/`,
 * `playbook/`) at their paths and the skills under `.claude/skills/<name>/`
 * (`apps/runner/src/resources.ts`). The drafts are the .docx files under `data/contracts/`.
 */
let sandbox: string;

const docxOf = (draft: Draft): Buffer =>
  writeDocx({
    paragraphs: draft.paragraphs.map((paragraph) => ({ ...paragraph })),
  });

beforeAll(async () => {
  project = await loadGalleryProject(DIR, {
    'agents/contract-review.ts': agentDefinition,
    'surfaces/legal-desk.ts': surfaceDefinition,
  });
  sandbox = mkdtempSync(path.join(tmpdir(), 'contract-review-'));
  if (process.env['GALLERY_WRITE'] === '1') {
    rmSync(CONTRACTS, { recursive: true, force: true });
    mkdirSync(CONTRACTS, { recursive: true });
    for (const draft of DRAFTS) writeFileSync(path.join(CONTRACTS, draft.file), docxOf(draft));
  }
  cpSync(CONTRACTS, path.join(sandbox, 'contracts'), { recursive: true });
  cpSync(path.join(DIR, 'data', 'playbook'), path.join(sandbox, 'playbook'), { recursive: true });
  cpSync(
    path.join(DIR, 'skills', 'contract-playbook'),
    path.join(sandbox, '.claude', 'skills', 'contract-playbook'),
    { recursive: true },
  );
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** `node <skill script> …` in the sandbox, as the agent's shell runs it; stdout as text. */
function node(script: string, args: readonly string[], input?: string): string {
  return execFileSync(process.execPath, [path.join('.claude', 'skills', script), ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** What the agent's `run_skill_script` call runs: `clauses.mjs check <file>.docx`, no pipe. */
function checkInSandbox(file: string): CheckResult {
  return JSON.parse(
    node('contract-playbook/scripts/clauses.mjs', ['check', file, '--playbook', 'playbook']),
  ) as CheckResult;
}

const pairs = (result: CheckResult): (readonly [string, string | null])[] =>
  result.findings.map((finding) => [finding.rule, finding.clause] as const);

const cell = (text: string): string => text.replace(/[|\n]/gu, ' ');

/**
 * What a model following `agents/contract-review.md` does: run the two scripts on the file the
 * prompt names, then write the skill's table, one row per finding, with the standard clause as
 * the proposal, plus a row of its own that no detector raised. `drop` leaves rules out, as a
 * careless model would. The decisions are scripted; the scripts and their output are real.
 */
function reviewer(drop: readonly string[] = []): Script {
  // The scripts run synchronously, as a shell command blocks the agent's turn.
  return (context: ScriptContext) => Promise.resolve(writeReview(context.prompt, drop));
}

function writeReview(prompt: string, drop: readonly string[]): string {
  const file = prompt.slice(prompt.lastIndexOf(': ') + 2);
  const result = checkInSandbox(file);
  const rows = result.findings
    .filter((finding) => !drop.includes(finding.rule))
    .map(
      (finding) =>
        `| ${finding.clause ?? '欠落'} | ${finding.topic} | ${finding.severity} | ${cell(finding.reason)}〔${finding.rule}〕 | ${cell(finding.standard ?? '')} |`,
    );
  if (result.title === '業務委託契約書') {
    rows.push(
      '| 第5条 | 著作者人格権の不行使 | 低 | 乙だけが不行使を約しており、成果物の改変範囲が限定されていない〔PB-04〕 | 乙は、甲が成果物を本契約の目的の範囲内で利用する限りにおいて、著作者人格権を行使しない。 |',
    );
  }
  return [
    `「${result.title}」を審査基準 ${String(PLAYBOOK.size)} 項目に照らして確認しました。`,
    '',
    '| 条項 | 論点 | リスク度 | 理由 | 修正文案 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '締結の可否は法務部でご判断ください。',
  ].join('\n');
}

describe('contract review agent', () => {
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
    expect(definition?.policy).toMatchObject({
      tools: { permissionMode: 'default', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
    });
    expect(definition?.resources).toMatchObject({
      connectors: [],
      skills: ['contract-playbook'],
      files: [
        { path: 'contracts', access: 'read' },
        { path: 'playbook', access: 'read' },
      ],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['legal-desk']);
    expect(project.surfaces[0]?.layout).toBe('page');
    expect(definition?.agent.instructions).toContain('clauses.mjs check');
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['contract-playbook']);
    expect(definition?.agent.instructions).toContain('clauses.mjs split');
    expect(definition?.agent.instructions).toContain('`playbook/` を読まない');
    expect(definition?.agent.instructions).toContain('締結の可否は法務担当者が判断してください。');
    expect(project.project.policy?.permissions).toMatchObject({
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
  });

  it('the eval file and the promotion bar are valid, with a judge rubric for every must-flag', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(6);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    const judged = cases
      .filter((entry) => entry.expect.judge !== undefined)
      .flatMap((entry) => entry.expect.contains ?? []);
    for (const rule of ['PB-01', 'PB-02', 'PB-03', 'PB-04', 'PB-05', 'PB-06']) {
      expect(judged, `no judged case pins ${rule}`).toContain(`〔${rule}〕`);
    }
    expect(cases.some((entry) => entry.expect.notContains?.includes('〔PB-06〕'))).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('ships each draft as a Word file that reads back as drafts.ts (GALLERY_WRITE=1 regenerates them)', () => {
    expect(readdirSync(CONTRACTS).toSorted()).toEqual(DRAFTS.map((draft) => draft.file).toSorted());
    for (const draft of DRAFTS) {
      const shipped = readDocx(readFileSync(path.join(CONTRACTS, draft.file)));
      expect(shipped.paragraphs, draft.file).toEqual(readDocx(docxOf(draft)).paragraphs);
    }
  });

  it('clauses.mjs splits each Word draft, or its docx JSON, into 第N条 clauses', () => {
    const split = (draft: Draft): SplitDocument =>
      JSON.parse(
        node(
          'contract-playbook/scripts/clauses.mjs',
          ['split', '-'],
          JSON.stringify(readDocx(readFileSync(path.join(CONTRACTS, draft.file)))),
        ),
      ) as SplitDocument;

    const service = split(SERVICE_AGREEMENT);
    // The agent's own call has no pipe: `split` reads the .docx itself and gets the same clauses.
    expect(
      JSON.parse(
        node('contract-playbook/scripts/clauses.mjs', [
          'split',
          `contracts/${SERVICE_AGREEMENT.file}`,
        ]),
      ),
    ).toStrictEqual(service);
    expect(service.title).toBe('業務委託契約書');
    expect(service.preamble[0]).toContain('株式会社ミナトシステムズ（以下「甲」という。）');
    expect(service.clauses.map((clause) => clause.label)).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => `第${String(index + 1)}条`),
    );
    expect(service.clauses[5]).toMatchObject({ heading: '損害賠償' });
    // The signature line after the last clause is not part of 第10条.
    expect(service.clauses[9]?.text).not.toContain('記名押印');

    // Full-width numbers typed as body text, and a sentence that cites 「第２条及び第３条」.
    const nda = split(NDA);
    expect(nda.clauses.map((clause) => clause.label)).toStrictEqual(
      Array.from({ length: 8 }, (_, index) => `第${String(index + 1)}条`),
    );
    expect(nda.clauses[5]?.text).toContain('第２条及び第３条に定める義務は');

    // Kanji numbers, and a heading with its first sentence on the same line.
    const supply = split(SUPPLY_AGREEMENT);
    expect(supply.clauses.at(-1)).toMatchObject({ label: '第11条', heading: '準拠法及び管轄' });
    expect(supply.clauses[0]).toMatchObject({ label: '第1条', heading: '目的' });
    expect(supply.clauses[0]?.text).toMatch(/^本契約は、甲乙間の本製品/u);

    expect(() =>
      node('contract-playbook/scripts/clauses.mjs', ['split', '-'], '{"rows":[]}'),
    ).toThrow(/office-reader docx JSON/u);
  });

  it('the check finds every planted issue in the three drafts, each citing its playbook rule', () => {
    for (const draft of DRAFTS) {
      const result = checkInSandbox(`contracts/${draft.file}`);
      expect(pairs(result).sort(), draft.file).toStrictEqual([...draft.planted].sort());
    }
    const service = checkInSandbox(`contracts/${SERVICE_AGREEMENT.file}`);
    expect(service.findings.filter((finding) => finding.mustFlag).map((f) => f.rule)).toStrictEqual(
      ['PB-01', 'PB-03', 'PB-04', 'PB-05', 'PB-06'],
    );
    const liability = service.findings.find((finding) => finding.rule === 'PB-01');
    expect(liability?.reason).toContain('「逸失利益」');
    expect(liability?.standard).toContain('対価の総額を上限とする');
    const law = checkInSandbox(`contracts/${NDA.file}`).findings.find((f) => f.rule === 'PB-02');
    expect(law?.reason).toContain('「米国ニューヨーク州法」');
    expect(law?.reason).toContain('裁判所');
  });

  it('the playbook standard clauses pass every detector, and a missing 反社 clause is an absence', () => {
    // The playbook and the detectors name the same rules, with the same must-flags.
    expect([...PLAYBOOK.keys()]).toStrictEqual(DETECTORS.map((detector) => detector.rule));
    for (const detector of DETECTORS) {
      expect(PLAYBOOK.get(detector.rule)?.mustFlag, detector.rule).toBe(detector.mustFlag);
      expect(PLAYBOOK.get(detector.rule)?.standard, detector.rule).not.toBe('');
    }

    // A contract written entirely in the company's standard clauses raises nothing.
    const contractOf = (rules: readonly PlaybookRule[]): DocxParagraph[] => [
      { style: 'Title', text: '標準契約書' },
      ...rules.flatMap((rule, index) => [
        { style: 'Heading2', text: `第${String(index + 1)}条（${rule.title}）` },
        { style: null, text: rule.standard },
      ]),
    ];
    const rules = [...PLAYBOOK.values()];
    const standard = contractOf(rules);
    expect(splitClauses(standard).clauses).toHaveLength(rules.length);
    expect(check(standard).findings).toStrictEqual([]);

    // Leave out only the 反社 clause: the check reports its absence, with no clause to point at.
    const absent = check(contractOf(rules.filter((rule) => rule.id !== 'PB-06'))).findings;
    expect(absent).toMatchObject([
      { rule: 'PB-06', clause: null, kind: 'absent', mustFlag: true, severity: '高' },
    ]);
  });

  it('the backend returns a complete review when the table covers every must-flag finding', async () => {
    const workspace = scriptedWorkspace(reviewer());
    const draft = docxOf(SERVICE_AGREEMENT);
    expect(readDocx(draft).paragraphs).toHaveLength(SERVICE_AGREEMENT.paragraphs.length);
    const review = await reviewContract(workspace.aw, workspace.agentId, {
      path: `contracts/${SERVICE_AGREEMENT.file}`,
      docx: draft,
      playbook: PLAYBOOK,
    });

    expect(review.status).toBe('complete');
    expect(review.missing).toStrictEqual([]);
    expect(review.malformed).toStrictEqual([]);
    expect(review.unknownRules).toStrictEqual([]);
    expect(review.rows.map((row) => [row.clause, row.risk, row.rules.join()])).toStrictEqual([
      ['第6条', '高', 'PB-01'],
      ['第7条', '高', 'PB-03'],
      ['第5条', '高', 'PB-04'],
      ['第8条', '中', 'PB-05'],
      [null, '高', 'PB-06'],
      ['第3条', '中', 'PB-08'],
      ['第5条', '低', 'PB-04'],
    ]);
    expect(review.rows[4]?.proposal).toContain('反社会的勢力に該当しないこと');
    expect(workspace.calls[0]?.json).toMatchObject({
      prompt: reviewPrompt(`contracts/${SERVICE_AGREEMENT.file}`),
      sessionId: null,
    });
  });

  it('the backend returns an incomplete review listing the must-flag findings the table left out', async () => {
    // The model forgets the absent 反社 clause and the auto-renewal; PB-08 is not a must-flag.
    const workspace = scriptedWorkspace(reviewer(['PB-06', 'PB-05', 'PB-08']));
    const review = await reviewContract(workspace.aw, workspace.agentId, {
      path: `contracts/${SERVICE_AGREEMENT.file}`,
      docx: docxOf(SERVICE_AGREEMENT),
      playbook: PLAYBOOK,
    });
    expect(review.status).toBe('incomplete');
    expect(review.missing.map((finding) => [finding.rule, finding.clause])).toStrictEqual([
      ['PB-05', '第8条'],
      ['PB-06', null],
    ]);

    // A clean draft for which the agent writes no table at all is incomplete too.
    const silent = scriptedWorkspace(() => Promise.resolve('問題は見当たりませんでした。'));
    const none = await reviewContract(silent.aw, silent.agentId, {
      path: `contracts/${SUPPLY_AGREEMENT.file}`,
      docx: docxOf(SUPPLY_AGREEMENT),
      playbook: PLAYBOOK,
    });
    expect(none).toMatchObject({ status: 'incomplete', missing: [], rows: [] });
  });

  it('the table parser rejects rows without a citation or a valid risk, and flags a downgrade', () => {
    const answer = [
      '| 条項 | 論点 | リスク度 | 理由 | 修正文案 |',
      '| --- | --- | --- | --- | --- |',
      '| 第８条 | 準拠法 | 低 | 相手方が米国企業のため許容〔PB-02〕 | 本契約は日本法に準拠し… |',
      '| 第6条 | 有効期間 | 中 | 永久に存続する | 終了後3年間存続する。 |',
      '| 第2条 | 秘密保持 | 要確認 | 範囲が広い〔PB-07〕 | … |',
      '| 第十条 | 協議 | 低 | 〔PB-99〕 | … |',
    ].join('\n');
    const table = parseRiskTable(answer);
    expect(table.rows.map((row) => row.clause)).toStrictEqual(['第8条', '第10条']);
    expect(table.malformed).toHaveLength(2);

    const result = check(
      NDA.paragraphs.map((paragraph) => ({ style: null, text: paragraph.text })),
    );
    const law = result.findings.find((finding) => finding.rule === 'PB-02');
    expect(law?.clause).toBe('第8条');
    // The 準拠法 row covers the must-flag, so the review is not incomplete, but it is rated 低
    // against the playbook's 高: legal sees the downgrade next to the agent's reason.
    const { missing, downgraded } = enforceMustFlags(table.rows, result);
    expect(missing).toStrictEqual([]);
    expect(downgraded.map(({ row, finding }) => [row.risk, finding.severity])).toStrictEqual([
      ['低', '高'],
    ]);
    expect(parseRiskTable('リスク表はありません。').found).toBe(false);
  });

  it('the table parser reports bold cells as malformed, which is why the format is strict', () => {
    const table = parseRiskTable(
      [
        '| 条項 | 論点 | リスク度 | 理由 | 修正文案 |',
        '| --- | --- | --- | --- | --- |',
        '| **第6条** | 損害賠償の上限 | 高 | 上限がない〔PB-01〕 | … |',
        '| 第6条 | 損害賠償の上限 | **高** | 上限がない〔PB-01〕 | … |',
      ].join('\n'),
    );
    expect(table.rows).toStrictEqual([]);
    expect(table.malformed).toHaveLength(2);
  });
});
