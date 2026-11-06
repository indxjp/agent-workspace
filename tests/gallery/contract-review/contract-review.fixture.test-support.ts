import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import { afterAll, beforeAll } from 'vitest';
import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type ScriptContext,
  type ScriptedWorkspace,
} from '../harness/scripted-workspace.ts';
import { writeDocx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import {
  decideReview,
  reviewContract,
  type AccessList,
  type AwaitingLegal,
  type ReviewOutcome,
  type ReviewRequest,
  type RiskRow,
} from './backend/review.ts';
import { contractPath, DRAFTS, SERVICE_AGREEMENT, type Draft } from './data/drafts.ts';
import {
  loadPlaybook,
  type CheckResult,
  type DocxParagraph,
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
export {
  DIR,
  DATA,
  CONTRACTS,
  PLAYBOOK,
  ACCESS,
  SALES_MEMBER,
  PURCHASING_MEMBER,
  project,
  sandbox,
  docxOf,
  node,
  paragraphsInSandbox,
  checkInSandbox,
  pairs,
  redlineJson,
  redlineDocx,
  reviewer,
  uploads,
  type DraftScript,
  search,
  playbookFiles,
  reviewWorkspace,
  requestOf,
  paused,
  approved,
  writeReview,
};
