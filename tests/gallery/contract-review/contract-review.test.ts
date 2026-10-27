/**
 * Use case 7, the contract review agent: the definition passes the contract, the two skill scripts
 * read real Word drafts and find every planted issue (and nothing in standard wording), and the
 * backend has legal approve the redline before the Word file is made and refuses a review whose risk
 * table leaves out a finding the playbook says must always be raised. See `../README.md` for the tiers and what each proves.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
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

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type ScriptContext,
  type ScriptedWorkspace,
} from '../harness/scripted-workspace.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import {
  readDocx,
  writeDocx,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import {
  decideReview,
  fileScopeFor,
  NoContractAccess,
  reviewContract,
  type AccessList,
  type AwaitingLegal,
  type ReviewOutcome,
  type ReviewRequest,
  type RiskRow,
} from './backend/review.ts';
import {
  contractPath,
  DRAFTS,
  NDA,
  SERVICE_AGREEMENT,
  SUPPLY_AGREEMENT,
  type Draft,
} from './data/drafts.ts';
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
const DATA = path.join(DIR, 'data');
/** The drafts as Word files, one folder per deal team: what the install-live harness and the tutorial upload into `contracts`. */
const CONTRACTS = path.join(DIR, 'data', 'contracts');
const OFFICE_READER = path.join(
  DIR,
  '..',
  '..',
  '..',
  'packages',
  'skills-office',
  'office-reader',
);
const PLAYBOOK = loadPlaybook(path.join(DIR, 'data', 'playbook'));
const ACCESS = JSON.parse(readFileSync(path.join(DATA, 'access.json'), 'utf8')) as AccessList;
/** The legal members `data/access.json` gives one deal team each. */
const SALES_MEMBER = '佐藤';
const PURCHASING_MEMBER = '鈴木';

let project: GalleryProject;
/**
 * A run's working directory as the runner lays it out: the granted files (`contracts/`,
 * `playbook/`, the scratch folders `drafts/<team>/`) at their paths and the skills under `.claude/skills/<name>/`
 * (`apps/runner/src/resources.ts`). The drafts are the .docx files under `data/contracts/<team>/`.
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
    for (const draft of DRAFTS) {
      mkdirSync(path.join(DATA, path.dirname(contractPath(draft))), { recursive: true });
      writeFileSync(path.join(DATA, contractPath(draft)), docxOf(draft));
    }
  }
  cpSync(CONTRACTS, path.join(sandbox, 'contracts'), { recursive: true });
  cpSync(path.join(DIR, 'data', 'playbook'), path.join(sandbox, 'playbook'), { recursive: true });
  cpSync(path.join(DATA, 'drafts'), path.join(sandbox, 'drafts'), { recursive: true });
  cpSync(
    path.join(DIR, 'skills', 'contract-playbook'),
    path.join(sandbox, '.claude', 'skills', 'contract-playbook'),
    { recursive: true },
  );
  cpSync(OFFICE_READER, path.join(sandbox, '.claude', 'skills', 'office-reader'), {
    recursive: true,
  });
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

/** The scratch folder the backend names for a draft at `contracts/<team>/<file>`: `drafts/<team>`. */
const scratchOf = (file: string): string => `drafts/${file.split('/')[1] ?? ''}`;

/**
 * The agent's first step: office-reader reads the Word draft and writes its paragraphs to
 * `drafts/<name>.json` itself (no `Write`), which is what the playbook script takes.
 */
function paragraphsInSandbox(file: string): string {
  const saved = `${scratchOf(file)}/${path.basename(file, '.docx')}.json`;
  node('office-reader/scripts/ooxml.mjs', ['docx', file, saved]);
  return saved;
}

/** What the agent's `run_skill_script` call runs: `clauses.mjs check drafts/<name>.json`, no pipe. */
function checkInSandbox(file: string): CheckResult {
  return JSON.parse(
    node('contract-playbook/scripts/clauses.mjs', [
      'check',
      paragraphsInSandbox(file),
      '--playbook',
      'playbook',
    ]),
  ) as CheckResult;
}

const pairs = (result: CheckResult): (readonly [string, string | null])[] =>
  result.findings.map((finding) => [finding.rule, finding.clause] as const);

const cell = (text: string): string => text.replace(/[|\n]/gu, ' ');

/** `clauses.mjs redline` with no out path: the redlined paragraphs on stdout, which the agent `Write`s as they are. */
function redlineJson(file: string): string {
  return node('contract-playbook/scripts/clauses.mjs', [
    'redline',
    paragraphsInSandbox(file),
    '--playbook',
    'playbook',
  ]);
}

/** The redline `Write` the agent makes, as the engine reports its input. */
const redlineWrite = (file: string, content: string): Record<string, unknown> => ({
  file_path: `${scratchOf(file)}/${path.basename(file, '.docx')}_修正案.json`,
  content,
});

/**
 * The Word file the agent makes once the redline is approved: `ooxml.mjs write` from the redline's
 * JSON into the sandbox's `outputs/`, where the run collects it.
 */
function redlineDocx(file: string, content: string): { name: string; bytes: Buffer } {
  const base = path.basename(file, '.docx');
  const name = `${base}_修正案.docx`;
  const redlined = `${scratchOf(file)}/${base}_修正案.json`;
  mkdirSync(path.join(sandbox, 'outputs'), { recursive: true });
  writeFileSync(path.join(sandbox, redlined), content);
  node('office-reader/scripts/ooxml.mjs', ['write', redlined, `outputs/${name}`]);
  return { name, bytes: readFileSync(path.join(sandbox, 'outputs', name)) };
}

/** What a model does with legal's comment: it words the last 【修正案】 paragraph to say so. */
function reviseRedline(content: string, comment: string): string {
  const { paragraphs } = JSON.parse(content) as { paragraphs: DocxParagraph[] };
  const revised = paragraphs.map((paragraph, index) =>
    index === paragraphs.length - 1
      ? { ...paragraph, text: `${paragraph.text}（${comment}）` }
      : paragraph,
  );
  return JSON.stringify({ paragraphs: revised }, null, 2);
}

/** What the agent leaves in `outputs/` once the redline is approved. */
type Docx = 'redlined' | 'none' | 'bare' | 'broken';

/**
 * What a model following `agents/contract-review.md` does. The first run: office-reader reads the
 * draft, the playbook check and `clauses.mjs redline` run, and the one gated `Write` of the redline
 * is where the engine stops it for approval. After a rejection it revises the redline from legal's
 * comment and writes again; after an approval it makes the same `Write`, builds the Word file and
 * answers the risk table as structured rows, one per finding, with the standard clause as the
 * proposal, plus a row of its own that no detector raised. `drop` leaves rules out, as a careless
 * model would; `docx` changes the file it leaves; `edit` lets a test change the rows before they
 * are sent. The decisions are scripted; the scripts and their output are real.
 */
function reviewer(
  drop: readonly string[] = [],
  docx: Docx = 'redlined',
  edit: (rows: RiskRow[]) => RiskRow[] = (rows) => rows,
): DraftScript {
  // A continuation continues the session: the agent remembers the redline it revised.
  let revised: string | null = null;
  return async (context, file) => {
    const rejected = /^rejected: (.*)$/su.exec(context.prompt)?.[1];
    if (rejected !== undefined) revised = reviseRedline(revised ?? redlineJson(file), rejected);
    const content = revised ?? redlineJson(file);
    await context.native('Write', redlineWrite(file, content));
    if (context.prompt !== 'approved') {
      throw new Error('the redline should have stopped at its Write');
    }
    const name = `${path.basename(file, '.docx')}_修正案.docx`;
    if (docx === 'redlined') {
      const built = redlineDocx(file, content);
      context.write(built.name, built.bytes);
    } else if (docx === 'bare') {
      context.write(name, docxOf(SERVICE_AGREEMENT));
    } else if (docx === 'broken') {
      context.write(name, new TextEncoder().encode('not a zip'));
    }
    return writeReview(file, drop, edit);
  };
}

/** What the file store holds for an upload: the id it was given and the path the agent is shown. */
const uploads = new Map<string, string>();
function upload(draft: Draft): { id: string; name: string } {
  const id = randomUUID();
  uploads.set(id, contractPath(draft));
  return { id, name: draft.file };
}

type DraftScript = (context: ScriptContext, file: string) => Promise<ScriptAnswer>;

/** The draft a run was started with: the attached file id on the recorded start body, resolved as the platform does. */
function attachedPath(workspace: ScriptedWorkspace): string {
  const start = workspace.calls
    .filter((call) => call.method === 'POST')
    .map((call) => call.json as { attachments?: readonly { fileId: string }[] } | undefined)
    .filter((body) => body?.attachments !== undefined)
    .at(-1);
  const file = uploads.get(start?.attachments?.[0]?.fileId ?? '');
  if (file === undefined) throw new Error('the run has no attached draft');
  return file;
}

/** The agent's `search_files` over its three grants, narrowed by each run's `fileScope` as the platform does. */
const search = createFileSearch({ root: DATA, grants: ['contracts', 'playbook', 'drafts'] });

// The gates are the agent definition's own, as the engine applies them.
const claudeEngine =
  typeof agentDefinition.engine === 'object' && agentDefinition.engine.id === 'claude-agent-sdk'
    ? agentDefinition.engine
    : undefined;

/** The version `aw push` saves for the agent: the body `loadGalleryProject` built from its definition. */
function pushedBody(): AgentVersionBody {
  const body = project.agents[0]?.body;
  if (body === undefined) throw new Error('the project has no agent');
  return body;
}

/** The published `contract-playbook` revision holds the project's skill directory, file for file. */
function playbookFiles(): Record<string, number> {
  const files = project.skills.find((skill) => skill.name === 'contract-playbook')?.files;
  if (files === undefined) throw new Error('the project has no contract-playbook skill');
  return { 'contract-playbook': files.length };
}

/** A scripted workspace whose model reads the draft the run attached. */
function reviewWorkspace(script: DraftScript): ScriptedWorkspace {
  const workspace: ScriptedWorkspace = scriptedWorkspace(
    (context) => script(context, attachedPath(workspace)),
    {},
    { search_files: search.call },
    {
      requireApproval: claudeEngine?.requireApproval,
      version: { body: pushedBody(), skillFileCounts: playbookFiles() },
    },
  );
  return workspace;
}

/** The deal team's own member: the one `access.json` lets review `draft`. */
const memberOf = (draft: Draft): string =>
  draft.team === '購買部' ? PURCHASING_MEMBER : SALES_MEMBER;

/** The request the app sends for `draft`, uploaded under a fresh file id by the team's own member. */
const requestOf = (draft: Draft, reviewerName: string = memberOf(draft)): ReviewRequest => ({
  file: upload(draft),
  reviewer: reviewerName,
  access: ACCESS,
  uploads,
  docx: docxOf(draft),
  playbook: PLAYBOOK,
});

/** The backend's pause for `workspace`, which the test expects to be approvable. */
async function paused(
  workspace: ScriptedWorkspace,
  request: ReviewRequest = requestOf(SERVICE_AGREEMENT),
): Promise<AwaitingLegal> {
  const outcome = await reviewContract(workspace.aw, workspace.agentId, request);
  if (outcome.status !== 'awaiting_legal') {
    throw new Error(`nothing to approve: ${outcome.problems.join('; ')}`);
  }
  return outcome;
}

/** The pause for `workspace`, approved, as legal's click does. */
async function approved(
  workspace: ScriptedWorkspace,
  request: ReviewRequest = requestOf(SERVICE_AGREEMENT),
): Promise<ReviewOutcome> {
  return decideReview(workspace.aw, await paused(workspace, request), { approve: true });
}

function writeReview(
  file: string,
  drop: readonly string[],
  edit: (rows: RiskRow[]) => RiskRow[],
): ScriptAnswer {
  const result = checkInSandbox(file);
  const found: RiskRow[] = result.findings
    .filter((finding) => !drop.includes(finding.rule))
    .map((finding) => ({
      clause: finding.clause,
      topic: finding.topic,
      risk: finding.severity,
      reason: `${cell(finding.reason)}〔${finding.rule}〕`,
      rules: [finding.rule],
      proposal: cell(finding.standard ?? ''),
    }));
  if (result.title === '業務委託契約書') {
    found.push({
      clause: '第5条',
      topic: '著作者人格権の不行使',
      risk: '低',
      reason: '乙だけが不行使を約しており、成果物の改変範囲が限定されていない〔PB-04〕',
      rules: ['PB-04'],
      proposal:
        '乙は、甲が成果物を本契約の目的の範囲内で利用する限りにおいて、著作者人格権を行使しない。',
    });
  }
  const rows = edit(found);
  const text = [
    `「${result.title}」を審査基準 ${String(PLAYBOOK.size)} 項目に照らして確認しました。`,
    '',
    '| 条項 | 論点 | リスク度 | 理由 | 修正文案 |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.clause ?? '欠落'} | ${row.topic} | ${row.risk} | ${row.reason} | ${row.proposal} |`,
    ),
    '',
    '締結の可否は法務部でご判断ください。',
  ].join('\n');
  return { text, structured: { review: text, rows } };
}

describe('contract review agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    // The skill scripts run unattended; the redline's Write waits for legal (ADR-0145).
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: [
          'mcp__agent-workspace__run_skill_script',
          'mcp__agent-workspace__search_files',
        ],
      },
      requireApproval: ['Write'],
    });
    expect(definition?.resources).toMatchObject({
      connectors: [],
      skills: ['office-reader', 'contract-playbook'],
      files: [
        { path: 'contracts', access: 'read' },
        { path: 'playbook', access: 'read' },
        { path: 'drafts', access: 'read-write' },
      ],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['legal-desk']);
    expect(agent?.body.surfaces).toMatchObject([{ parts: { attachments: true } }]);
    expect(project.surfaces[0]?.layout).toBe('page');
    expect(definition?.agent.instructions).toContain('clauses.mjs check');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'contract-playbook',
      'office-reader',
    ]);
    // The agent reads the Word file with office-reader; the playbook skill never opens one.
    expect(definition?.agent.instructions).toContain('ooxml.mjs docx');
    expect(definition?.agent.instructions).toContain('ooxml.mjs write');
    expect(definition?.agent.instructions).toContain('clauses.mjs split');
    expect(definition?.agent.instructions).toContain('リスク表の作成では `playbook/` を読まない');
    expect(definition?.agent.instructions).toContain('`search_files`');
    expect(definition?.agent.instructions).toContain('締結の可否は法務担当者が判断してください。');
    expect(definition?.agent.instructions).toContain('clauses.mjs redline');
    expect(project.project.policy?.permissions).toMatchObject({
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    });
  });

  it('the agent finds the playbook rule with search_files and ships no index server', async () => {
    const data = path.join(DIR, 'data');
    // No connector, and no hosted server of ours: the detector is a skill script, not retrieval.
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    const search = createFileSearch({ root: data, grants: ['playbook'] });
    const hitsOf = async (query: string): Promise<string[]> => {
      const result = await search.call({ query });
      expect(result.isError).toBe(false);
      return (JSON.parse(result.text) as { path: string }[]).map((hit) => hit.path);
    };
    // Only the nine rules are searchable; the drafts under `contracts/` are not granted.
    expect(search.searchablePaths()).toHaveLength(9);
    expect(search.searchablePaths().every((file) => file.startsWith('playbook/PB-'))).toBe(true);
    expect(await hitsOf('損害賠償 上限')).toStrictEqual(['playbook/PB-01-liability-cap.md']);
    expect(await hitsOf('量子コンピュータ')).toStrictEqual([]);
    expect((await search.call({ query: '？' })).isError).toBe(true);

    // A grant never leaks a file outside it.
    const one = createFileSearch({ root: data, grants: ['playbook/PB-01-liability-cap.md'] });
    expect(one.searchablePaths()).toStrictEqual(['playbook/PB-01-liability-cap.md']);
    const other = createFileSearch({ root: data, grants: ['contracts'] });
    const leaked = (
      JSON.parse((await other.call({ query: '損害賠償 上限' })).text) as { path: string }[]
    )
      .map((hit) => hit.path)
      .filter((file) => !file.startsWith('contracts/'));
    expect(leaked).toStrictEqual([]);
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
    expect(
      readdirSync(CONTRACTS, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(DATA, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'),
        )
        .toSorted(),
    ).toEqual(DRAFTS.map(contractPath).toSorted());
    for (const draft of DRAFTS) {
      const shipped = readDocx(readFileSync(path.join(DATA, contractPath(draft))));
      expect(shipped.paragraphs, draft.file).toEqual(readDocx(docxOf(draft)).paragraphs);
    }
  });

  it('clauses.mjs splits each Word draft, as office-reader reads it, into 第N条 clauses', () => {
    const split = (draft: Draft): SplitDocument =>
      JSON.parse(
        node(
          'contract-playbook/scripts/clauses.mjs',
          ['split', '-'],
          JSON.stringify(readDocx(readFileSync(path.join(DATA, contractPath(draft))))),
        ),
      ) as SplitDocument;

    const service = split(SERVICE_AGREEMENT);
    // The agent's own call has no pipe: it passes the file it saved with `Write`.
    expect(
      JSON.parse(
        node('contract-playbook/scripts/clauses.mjs', [
          'split',
          paragraphsInSandbox(contractPath(SERVICE_AGREEMENT)),
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

  it('clauses.mjs opens no Word file: a .docx argument is refused by name', () => {
    for (const command of ['split', 'check']) {
      expect(() =>
        node('contract-playbook/scripts/clauses.mjs', [command, contractPath(NDA)]),
      ).toThrow(/is a Word file: read it with the office-reader skill/u);
    }
  });

  it('the check finds every planted issue in the three drafts, each citing its playbook rule', () => {
    for (const draft of DRAFTS) {
      const result = checkInSandbox(contractPath(draft));
      expect(pairs(result).sort(), draft.file).toStrictEqual([...draft.planted].sort());
    }
    const service = checkInSandbox(contractPath(SERVICE_AGREEMENT));
    expect(service.findings.filter((finding) => finding.mustFlag).map((f) => f.rule)).toStrictEqual(
      ['PB-01', 'PB-03', 'PB-04', 'PB-05', 'PB-06'],
    );
    const liability = service.findings.find((finding) => finding.rule === 'PB-01');
    expect(liability?.reason).toContain('「逸失利益」');
    expect(liability?.standard).toContain('対価の総額を上限とする');
    const law = checkInSandbox(contractPath(NDA)).findings.find((f) => f.rule === 'PB-02');
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

  it('the backend reads the rows as typed output after legal approves, and returns the review when they cover every must-flag finding', async () => {
    const workspace = reviewWorkspace(reviewer());
    expect(readDocx(docxOf(SERVICE_AGREEMENT)).paragraphs).toHaveLength(
      SERVICE_AGREEMENT.paragraphs.length,
    );
    const review = await approved(workspace);

    expect(review.status).toBe('reviewed');
    if (review.status !== 'reviewed') return;
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
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['review', 'rows'],
      properties: {
        rows: {
          type: 'array',
          items: { required: ['clause', 'topic', 'risk', 'reason', 'rules', 'proposal'] },
        },
      },
    });
    // The continuation keeps the schema, so the rows come back typed after the approval.
    expect(workspace.runs[1]?.outputSchema).toStrictEqual(workspace.runs[0]?.outputSchema);
    expect(review.answer).toContain('| 条項 | 論点 | リスク度 | 理由 | 修正文案 |');
  });

  it('a review run names the version, and the version pins the playbook revision the review applied', async () => {
    const workspace = reviewWorkspace(reviewer());
    await approved(workspace);
    const runId = workspace.runs[0]?.id;
    if (runId === undefined) throw new Error('the review started no run');

    // run id → the version the run executed …
    const run = await workspace.aw.runs.get(runId);
    expect(run.agentVersion).toBe(1);
    // … → that version's body → the playbook revision it pins …
    const { items } = await workspace.aw.agents.versions.list(workspace.agentId);
    const version = items.find((item) => item.number === run.agentVersion);
    const pinned = version?.body.definition.resources.skillRevisions;
    expect(pinned).toStrictEqual({ 'contract-playbook': 1 });
    // … → the published revision the version pins: its number, file count and date.
    const playbook = await workspace.aw.skills.get('contract-playbook');
    expect(playbook.revisions).toMatchObject([
      { number: pinned?.['contract-playbook'], fileCount: playbookFiles()['contract-playbook'] },
    ]);
  });

  it('the draft rides on the review run as an attachment; the prompt names the working folder, not the draft', async () => {
    const workspace = reviewWorkspace(reviewer());
    const request = requestOf(SERVICE_AGREEMENT);
    await reviewContract(workspace.aw, workspace.agentId, request);

    const [start] = workspace.calls.filter((call) => call.method === 'POST');
    expect(start?.json).toMatchObject({
      prompt:
        '添付の契約書ドラフトを審査基準に照らしてレビューし、リスク表を作成してください。\n作業フォルダ: drafts/営業一部/',
      attachments: [{ fileId: request.file.id }],
      subject: SALES_MEMBER,
      fileScope: ['contracts/営業一部', 'playbook', 'drafts/営業一部'],
      sessionId: null,
    });
    expect(workspace.runs[0]?.prompt).not.toContain('contracts/');
    expect(workspace.runs[0]?.prompt).not.toContain(SERVICE_AGREEMENT.file);
  });

  it('a reviewer reaches only the contracts of their deal teams, by fileScope and not by prompt text', async () => {
    // The model searches for a phrase only the purchasing team's contract holds.
    const asked = async (draft: Draft, reviewerName: string, query: string) => {
      let seen = '';
      const workspace = scriptedWorkspace(
        async ({ builtin }) => {
          seen = (await builtin('search_files', { query })).text;
          return seen;
        },
        {},
        { search_files: search.call },
      );
      // The prompt is the same for everyone; only the run's subject and scope decide.
      // The model answers in prose, so the run fails its schema; only what it searched matters here.
      await reviewContract(workspace.aw, workspace.agentId, requestOf(draft, reviewerName)).catch(
        (error: unknown) => {
          if (!(error instanceof RunDidNotComplete)) throw error;
        },
      );
      const paths = (JSON.parse(seen) as { path: string }[]).map((hit) => hit.path);
      return { paths, run: workspace.runs[0] };
    };

    const sales = await asked(SERVICE_AGREEMENT, SALES_MEMBER, '北陸精工');
    expect(sales.run).toMatchObject({
      subject: SALES_MEMBER,
      fileScope: ['contracts/営業一部', 'playbook', 'drafts/営業一部'],
    });
    expect(sales.paths).toStrictEqual([]);
    expect(
      (await search.call({ query: '北陸精工' }, { fileScope: ['contracts/営業一部'] })).text,
    ).toBe('[]');

    // Purchasing finds its own contract, and none of sales'.
    const purchasing = await asked(SUPPLY_AGREEMENT, PURCHASING_MEMBER, '北陸精工');
    expect(purchasing.run).toMatchObject({
      subject: PURCHASING_MEMBER,
      fileScope: ['contracts/購買部', 'playbook', 'drafts/購買部'],
    });
    expect(purchasing.paths).toStrictEqual([contractPath(SUPPLY_AGREEMENT)]);
    const secrecy = await asked(SUPPLY_AGREEMENT, PURCHASING_MEMBER, 'Harborline');
    expect(secrecy.paths).toStrictEqual([]);

    // A member of both teams reaches both, and the scratch folder is the attached draft's team.
    const both: AccessList = { ...ACCESS, 高橋: { teams: ['営業一部', '購買部'] } };
    const shared = reviewWorkspace(reviewer());
    await reviewContract(shared.aw, shared.agentId, {
      ...requestOf(SUPPLY_AGREEMENT, '高橋'),
      access: both,
    });
    const twoTeams = shared.runs[0];
    expect(twoTeams?.fileScope).toStrictEqual([
      'contracts/営業一部',
      'contracts/購買部',
      'playbook',
      'drafts/購買部',
    ]);
  });

  it('a reviewer with no deal team, or an attachment outside their teams, is refused before any run', async () => {
    const refused = async (request: ReviewRequest) => {
      const workspace = reviewWorkspace(reviewer());
      await expect(reviewContract(workspace.aw, workspace.agentId, request)).rejects.toThrow(
        NoContractAccess,
      );
      expect(workspace.runs).toHaveLength(0);
    };

    // No team, a reviewer access.json does not list, and a key that is on every object.
    const none: AccessList = { ...ACCESS, 新人: { teams: [] } };
    for (const name of ['新人', '見知らぬ人', '__proto__']) {
      await refused({ ...requestOf(SERVICE_AGREEMENT, name), access: none });
    }
    expect(() => fileScopeFor('__proto__', ACCESS)).toThrow(NoContractAccess);
    expect(fileScopeFor(SALES_MEMBER, ACCESS)).toStrictEqual(['contracts/営業一部', 'playbook']);

    // Sales cannot attach purchasing's contract by its file id, nor an id this session never uploaded.
    await refused(requestOf(SUPPLY_AGREEMENT, SALES_MEMBER));
    await refused({ ...requestOf(SERVICE_AGREEMENT), file: { id: randomUUID(), name: 'x.docx' } });
    const stray = randomUUID();
    const flat = new Map([...uploads, [stray, contractPath(NDA).replace('営業一部/', '')]]);
    await refused({
      ...requestOf(NDA),
      file: { id: stray, name: NDA.file },
      uploads: flat,
    });
    const dotted = new Map([[stray, 'contracts/営業一部/../購買部/x.docx']]);
    await refused({ ...requestOf(NDA), file: { id: stray, name: 'x.docx' }, uploads: dotted });
  });

  it("the continuation keeps the reviewer's subject and fileScope on approve and reject", async () => {
    const scope = ['contracts/営業一部', 'playbook', 'drafts/営業一部'];
    const workspace = reviewWorkspace(reviewer());
    const first = await paused(workspace);
    const second = await decideReview(workspace.aw, first, {
      approve: false,
      comment: '反社条項は標準文言のままで',
    });
    expect(second.status).toBe('awaiting_legal');
    if (second.status !== 'awaiting_legal') return;
    expect(second.team).toBe('営業一部');
    expect((await decideReview(workspace.aw, second, { approve: true })).status).toBe('reviewed');
    expect(workspace.runs).toHaveLength(3);
    for (const entry of workspace.runs) {
      expect(entry).toMatchObject({ subject: SALES_MEMBER, fileScope: scope });
    }
  });

  it("a redline written to another team's scratch folder pauses nothing to approve", async () => {
    const workspace = reviewWorkspace(async ({ native }) => {
      await native('Write', {
        file_path: `drafts/購買部/${path.basename(SERVICE_AGREEMENT.file, '.docx')}_修正案.json`,
        content: '{"paragraphs":[{"style":null,"text":"x"}]}',
      });
      return 'unreachable';
    });
    const outcome = await reviewContract(
      workspace.aw,
      workspace.agentId,
      requestOf(SERVICE_AGREEMENT),
    );
    expect(outcome.status).toBe('refused');
  });

  it('clauses.mjs redline plus office-reader write the draft with a 【修正案】 paragraph per must-flag finding', () => {
    const file = contractPath(SERVICE_AGREEMENT);
    const { bytes } = redlineDocx(file, redlineJson(file));
    const original = readDocx(readFileSync(path.join(sandbox, file))).paragraphs;
    const redlined = readDocx(bytes).paragraphs;
    expect(redlined.slice(0, original.length).map(({ text }) => text)).toStrictEqual(
      original.map(({ text }) => text),
    );
    const proposals = redlined.slice(original.length).map(({ text }) => text);
    expect(proposals[0]).toBe('【修正案】');
    const flagged = checkInSandbox(file).findings.filter((finding) => finding.mustFlag);
    expect(proposals.slice(1).map((text) => text.slice(0, 11))).toStrictEqual(
      flagged.map((finding) => `【修正案 ${finding.rule}】`),
    );
    expect(proposals.at(-1)).toContain('反社会的勢力に該当しないこと');
    expect(() => node('contract-playbook/scripts/clauses.mjs', ['redline', file])).toThrow(
      /usage: clauses.mjs redline/u,
    );
  });

  it('the backend returns the redlined .docx the agent wrote', async () => {
    const workspace = reviewWorkspace(reviewer());
    const review = await approved(workspace);
    const file = contractPath(SERVICE_AGREEMENT);
    const written = redlineDocx(file, redlineJson(file));
    expect(review.status).toBe('reviewed');
    if (review.status !== 'reviewed') return;
    expect(review.redline.name).toBe('業務委託契約書_株式会社ミナトシステムズ案_修正案.docx');
    // The bytes are the agent's file, not a copy the backend rebuilt.
    expect(Buffer.from(review.redline.bytes)).toStrictEqual(written.bytes);
  });

  it('the backend pauses on the redline before the Word is made, and approving it returns the rows and the .docx', async () => {
    const workspace = reviewWorkspace(reviewer());
    const awaiting = await paused(workspace);

    // Nothing is built: the run waits on the redline's Write, and legal reads the paragraphs it holds.
    expect(awaiting.status).toBe('awaiting_legal');
    expect(awaiting.call.toolName).toBe('Write');
    expect(awaiting.redline.at(-1)?.text).toMatch(/^【修正案 PB-06】/u);
    expect(awaiting.redline.at(-1)?.text).toContain('反社会的勢力に該当しないこと');
    expect(workspace.runs).toHaveLength(1);
    expect((await workspace.aw.runs.get(awaiting.runId)).status).toBe('awaiting_approval');
    expect(await workspace.aw.runs.outputs(awaiting.runId)).toStrictEqual([]);

    // Legal approves; the continuation is the same session and the same Write.
    const outcome = await decideReview(workspace.aw, awaiting, { approve: true });
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'approved',
      sessionId: workspace.runs[0]?.sessionId,
      approvedToolCalls: [{ toolName: 'Write' }],
    });
    expect(outcome.status).toBe('reviewed');
    if (outcome.status !== 'reviewed') return;
    expect(outcome.sessionId).toBe(awaiting.sessionId);
    expect(outcome.rows).toHaveLength(7);
    const text = readDocx(Buffer.from(outcome.redline.bytes)).paragraphs.map(
      ({ text: line }) => line,
    );
    expect(text.slice(-awaiting.redline.length)).toStrictEqual(
      awaiting.redline.map(({ text: line }) => line),
    );
  });

  it('a rejection with a comment sends the redline back, and the revised redline pauses again', async () => {
    const workspace = reviewWorkspace(reviewer());
    const first = await paused(workspace);

    const comment = '反社条項は標準文言のままで';
    const second = await decideReview(workspace.aw, first, { approve: false, comment });
    expect(workspace.runs[1]).toMatchObject({
      prompt: `rejected: ${comment}`,
      sessionId: first.sessionId,
      approvedToolCalls: [],
    });
    expect(second.status).toBe('awaiting_legal');
    if (second.status !== 'awaiting_legal') return;
    expect(second.runId).not.toBe(first.runId);
    expect(second.redline).not.toStrictEqual(first.redline);
    expect(second.redline.at(-1)?.text).toContain(`（${comment}）`);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');
    for (const entry of workspace.runs) {
      expect(await workspace.aw.runs.outputs(entry.id)).toStrictEqual([]);
    }

    // Approving the revised redline builds the Word file from it.
    const outcome = await decideReview(workspace.aw, second, { approve: true });
    expect(outcome.status).toBe('reviewed');
    if (outcome.status !== 'reviewed') return;
    expect(readDocx(Buffer.from(outcome.redline.bytes)).paragraphs.at(-1)?.text).toContain(
      `（${comment}）`,
    );
  });

  it('a second decision on the same run is refused with 409 run_not_awaiting_approval', async () => {
    const workspace = reviewWorkspace(reviewer());
    const awaiting = await paused(workspace);
    await decideReview(workspace.aw, awaiting, { approve: true });

    // The paused run was decided once; a second decision finds nothing to decide.
    await expect(decideReview(workspace.aw, awaiting, { approve: true })).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    await expect(
      decideReview(workspace.aw, awaiting, { approve: false, comment: 'やはり直す' }),
    ).rejects.toMatchObject({ status: 409, code: 'run_not_awaiting_approval' });
    expect(workspace.runs).toHaveLength(2);
  });

  it('the backend refuses an approved review when the agent wrote no Word file, or one that leaves out a must-flag', async () => {
    expect(await approved(reviewWorkspace(reviewer([], 'none')))).toMatchObject({
      status: 'refused',
      missing: [],
      redlineMissing: [],
      problems: ['outputs/業務委託契約書_株式会社ミナトシステムズ案_修正案.docx を書いていません'],
    });

    // A Word file with no 【修正案】 paragraph, or one that does not open at all, carries no proposal.
    const rules = ['PB-01', 'PB-03', 'PB-04', 'PB-05', 'PB-06'];
    for (const docx of ['bare', 'broken'] as const) {
      expect(await approved(reviewWorkspace(reviewer([], docx)))).toMatchObject({
        status: 'refused',
        missing: [],
        redlineMissing: rules.map((rule) => ({ rule })),
      });
    }
  });

  it('the backend refuses an approved review listing the must-flag findings the table left out', async () => {
    // The model forgets the absent 反社 clause and the auto-renewal; PB-08 is not a must-flag.
    const refused = await approved(reviewWorkspace(reviewer(['PB-06', 'PB-05', 'PB-08'])));
    expect(refused).toMatchObject({
      status: 'refused',
      missing: [
        { rule: 'PB-05', clause: '第8条' },
        { rule: 'PB-06', clause: null },
      ],
      redlineMissing: [],
      problems: [
        '〔PB-05〕第8条 のリスク表の行がありません',
        '〔PB-06〕欠落 のリスク表の行がありません',
      ],
    });
  });

  it('the backend shows legal nothing when the run ends without the redline, pauses on another file, or fails its rows', async () => {
    const request = requestOf(SERVICE_AGREEMENT);
    const redlineFile = `drafts/${SERVICE_AGREEMENT.team}/${path.basename(SERVICE_AGREEMENT.file, '.docx')}_修正案.json`;
    const refusedWith = async (script: DraftScript) => {
      const workspace = reviewWorkspace(script);
      return reviewContract(workspace.aw, workspace.agentId, request);
    };

    expect(
      await refusedWith((_context, file) => Promise.resolve(writeReview(file, [], (rows) => rows))),
    ).toMatchObject({
      status: 'refused',
      problems: ['エージェントが修正案を書かずに終わりました'],
    });
    expect(
      await refusedWith(async ({ native }) => {
        await native('Write', { file_path: 'drafts/other.json', content: '{}' });
        return 'unreachable';
      }),
    ).toMatchObject({
      status: 'refused',
      problems: [`Write が ${redlineFile} 以外を書こうとして止まった`],
    });
    expect(
      await refusedWith(async ({ native }) => {
        await native('Write', { file_path: redlineFile, content: 'not json' });
        return 'unreachable';
      }),
    ).toMatchObject({ status: 'refused', problems: [`${redlineFile} が JSON ではない`] });
    expect(
      await refusedWith(async ({ native }) => {
        await native('Write', { file_path: redlineFile, content: '{"paragraphs":[]}' });
        return 'unreachable';
      }),
    ).toMatchObject({
      status: 'refused',
      problems: [expect.stringContaining('paragraphs') as unknown],
    });

    // An answer without the rows is not a review the backend can check: the platform fails the run,
    // and the backend surfaces that.
    const silent = scriptedWorkspace(() => Promise.resolve('問題は見当たりませんでした。'));
    const failure: unknown = await reviewContract(
      silent.aw,
      silent.agentId,
      requestOf(SUPPLY_AGREEMENT),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunDidNotComplete);
    expect(failure instanceof RunDidNotComplete ? failure.run : null).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^output_schema_unsatisfied: /u) as unknown,
    });
  });

  it('the backend still reports a downgraded must-flag and a rule the playbook does not have, from typed rows', async () => {
    const workspace = reviewWorkspace(
      reviewer([], 'redlined', (rows) => [
        // The 準拠法 row covers the must-flag but rates it 低 against the playbook's 高.
        ...rows.map((row) => (row.rules.includes('PB-02') ? { ...row, risk: '低' as const } : row)),
        ...rows.slice(0, 1).map((row) => ({ ...row, rules: ['PB-99'] })),
      ]),
    );
    const review = await approved(workspace, requestOf(NDA));
    expect(review.status).toBe('reviewed');
    if (review.status !== 'reviewed') return;
    expect(review.downgraded.map(({ row, finding }) => [row.risk, finding.severity])).toStrictEqual(
      [['低', '高']],
    );
    expect(review.unknownRules).toStrictEqual(['PB-99']);
  });
});
