import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import { toolServerKey } from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll } from 'vitest';

import { isGrantedPath } from '../../../apps/web/server/files/search-terms.ts';
import { createFileSearch } from '../harness/file-search.ts';
import { GALLERY_WORKSPACE_ID, headersAs } from '../harness/identity.ts';
import { openapiGateway, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import type { AwaitingApproval } from '../shared/run-answer.ts';
import type { DiagnosisTurn, inspectTurn, TurnAnswer } from './backend/diagnose.ts';
import { loadAccess } from './backend/scope.ts';
import { startFakeMaintenance, type FakeMaintenance } from './maintenance/fake-maintenance.mjs';
import { maintenance as maintenanceTool } from './tools/maintenance.ts';
import agentDefinition from './agents/maintenance-troubleshooting.ts';
import surfaceDefinition from './surfaces/floor.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
/** The maintenance system's connector: its id, the API token and the identity-assertion key. */
const MAINTENANCE = {
  id: '9a7e0c11-0000-4000-8000-000000000093',
  token: 'maintenance-test-token',
  secret: 'gallery-maintenance-api-secret-0123456789',
} as const;
// Who is asking: all are in `data/access.json`, the first two each in their own production line.
const TECHNICIAN = '佐藤 翔太';
const OTHER_TECHNICIAN = '小林 美咲';
const EXPERT = '山本 浩二';
const SAFETY_LINE =
  '【安全】作業前に設備を停止し、主電源を遮断してロックアウト・タグアウト（LOTO）を実施してください。';

interface Trouble {
  readonly id: string;
  readonly cause: string;
  readonly citation: string;
}
interface Logged {
  readonly id: string;
  readonly machineId: string;
  readonly citation: string;
  readonly technician: string;
  readonly logged: true;
}
interface Hit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}

const document = JSON.parse(
  readFileSync(path.join(DIR, 'apis', 'maintenance.openapi.json'), 'utf8'),
) as OpenApiDocument;

/** A maintenance system logging into its own store file, which a trouble log can read. */
async function startMaintenance(): Promise<{ api: FakeMaintenance; store: string }> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'trouble-log-')), 'store.json');
  const api = await startFakeMaintenance({
    token: MAINTENANCE.token,
    identity: {
      key: MAINTENANCE.secret,
      audience: MAINTENANCE.id,
      workspace: GALLERY_WORKSPACE_ID,
    },
    storeFile: file,
  });
  return { api, store: file };
}

/** The platform's gateway for the maintenance tool, with the calls a technician approved. */
const maintenanceGateway = (
  api: FakeMaintenance,
  approved: readonly Record<string, unknown>[] = [],
) =>
  openapiGateway({
    document,
    allow: maintenanceTool.allow,
    baseUrl: api.url,
    token: MAINTENANCE.token,
    serverKey: toolServerKey('maintenance'),
    approvedToolCalls: approved.map((body) =>
      canonicalCall('mcp__maintenance__logResolution', { body }),
    ),
  });

/** The one case the scripted diagnosis logs, and the call the technician approves for it. */
const RESOLUTION = {
  machineId: 'PR-02',
  symptom: '油圧が上がらない。ポンプからガラガラ音',
  cause: '吸込みストレーナの目詰まり',
  action: 'ストレーナを洗油で清掃し、21MPaまで上がることを確認',
  durationMin: 80,
};

let project: GalleryProject;
let store: string;
let system: FakeMaintenance;

beforeAll(async () => {
  ({ api: system, store } = await startMaintenance());
  project = await loadGalleryProject(DIR, {
    'agents/maintenance-troubleshooting.ts': agentDefinition,
    'surfaces/floor.ts': surfaceDefinition,
  });
});
afterAll(async () => {
  await system.close();
});

/** A turn the agent answered; a turn that paused for approval fails the test that expected one. */
function assertAnswered(turn: DiagnosisTurn | AwaitingApproval): asserts turn is DiagnosisTurn {
  if ('status' in turn) throw new Error(`run ${turn.runId} paused for approval`);
}

/** The connectors a run gets. */
const connectors = () => ({
  maintenance: {
    id: MAINTENANCE.id,
    session: maintenanceGateway(system),
    identityKey: MAINTENANCE.secret,
  },
});

const access = loadAccess();
const search = createFileSearch({
  root: DATA,
  grants: ['trouble-log', 'expert-notes', 'manuals'],
});
// `Read` is the engine's own tool, not the platform's; the double is registered with the built-ins
// so a scripted model opens a file the way a run does, and only what the run's scope hydrated.
const builtins: BuiltinTools = {
  search_files: search.call,
  Read: (args, run) => {
    const file = String(args['file_path']);
    if (run.fileScope !== null && !isGrantedPath(file, run.fileScope)) {
      return Promise.resolve({ text: `File does not exist: ${file}`, isError: true });
    }
    return Promise.resolve({ text: readFileSync(path.join(DATA, file), 'utf8'), isError: false });
  },
};
const workspaceFor = (script: Parameters<typeof scriptedWorkspace>[0]) =>
  scriptedWorkspace(script, connectors(), builtins, {
    handoff:
      typeof agentDefinition.engine === 'object' && agentDefinition.engine.id === 'claude-agent-sdk'
        ? agentDefinition.engine.handoff
        : undefined,
  });

/** The headers the platform sends the maintenance system for a run started with `subject`. */
const asAtSystem = headersAs({ key: MAINTENANCE.secret, connectorId: MAINTENANCE.id });

/** What `search_files` returns for `query` in a run narrowed to `fileScope`. */
const searchHits = async (query: string, fileScope: readonly string[] | null): Promise<Hit[]> =>
  JSON.parse((await search.call({ query }, { fileScope })).text) as Hit[];

/** What a model answers when asked for structured output: the reply, and the same turn as fields. */
function said(
  reply: string,
  kind: TurnAnswer['kind'],
  step: { number: number; instruction: string; citations: string[] } | null,
  citations: string[],
): ScriptAnswer {
  const answer: TurnAnswer = { reply, kind, step, citations };
  return { text: reply, structured: answer };
}

const find = async (context: ScriptContext, query: string): Promise<Hit[]> =>
  JSON.parse((await context.builtin('search_files', { query })).text) as Hit[];

const open = async (context: ScriptContext, file: string): Promise<string> =>
  (await context.builtin('Read', { file_path: file })).text;

/** The 〔…〕 source printed under the `## §<section>` heading of a note or manual. */
const sourceOf = (document: string, section: string): string =>
  new RegExp(`## §${section.replace('.', '\\.')}\\s[^\\n]*\\n\\n出典: (〔[^〕]+〕)`, 'u').exec(
    document,
  )?.[1] ?? '';

/** The records of one machine, found by its number and read from its file as the model does. */
async function historyOf(context: ScriptContext, machineId: string): Promise<Trouble[]> {
  const file = (await find(context, machineId)).find((hit) =>
    hit.path.endsWith(`${machineId}.json`),
  );
  return (JSON.parse(await open(context, file?.path ?? '')) as { records: Trouble[] }).records;
}

/** The manual section on safety measures, found by search and read for its source. */
async function safetyCitation(context: ScriptContext): Promise<string> {
  const manual = (await find(context, '安全措置')).find((hit) => hit.path.startsWith('manuals/'));
  return sourceOf(await open(context, manual?.path ?? ''), '2.1');
}

/**
 * What a model following the instructions and the one-step-diagnosis skill does on the press:
 * safety and the oil level first, the strainer when the pump rattles, then log the fix.
 */
async function pressDiagnosis(context: ScriptContext): Promise<ScriptAnswer> {
  // The continuation of a decision: `approved` repeats the approved call exactly; a rejected call is
  // not made again, and the agent hands the session to the expert.
  if (context.prompt.startsWith('rejected')) {
    await context.handoff('技術者が記録を差し戻した');
    return said('記録しませんでした。熟練者に引き継ぎます。', 'step', null, []);
  }
  if (context.prompt.includes('油圧が上がらない')) {
    const lowOil = (await historyOf(context, 'PR-02')).find((trouble) =>
      trouble.cause.includes('作動油不足'),
    );
    const safety = await safetyCitation(context);
    const source = lowOil?.citation ?? '';
    const instruction = '作動油タンクの油面計を見て、油量が下限線より上にあるか確認してください。';
    return said(
      [
        `${SAFETY_LINE}${safety}`,
        '',
        `手順1：${instruction}${source}`,
        '油量は下限線より上でしたか？',
      ].join('\n'),
      'step',
      { number: 1, instruction, citations: [source] },
      [safety, source],
    );
  }
  if (context.prompt.includes('ガラガラ')) {
    const strainer = (await historyOf(context, 'PR-02')).find((trouble) =>
      trouble.cause.includes('ストレーナ'),
    );
    const note = (await find(context, 'ガラガラ')).find((hit) =>
      hit.path.startsWith('expert-notes/'),
    );
    const sources = [
      strainer?.citation ?? '',
      sourceOf(await open(context, note?.path ?? ''), '2'),
    ];
    const instruction =
      '吸込みストレーナを点検口から外し、金網が目詰まりしていないか確認してください。';
    return said(
      [`手順2：${instruction}${sources.join('')}`, '目詰まりはありましたか？'].join('\n'),
      'step',
      { number: 2, instruction, citations: sources },
      sources,
    );
  }
  const logged = JSON.parse(
    (await context.tool('maintenance', 'logResolution', { body: RESOLUTION })).text,
  ) as Logged;
  return said(
    `【解決】原因: 吸込みストレーナの目詰まり／処置: 清掃。過去トラ${logged.citation}として記録しました。熟練者のレビュー後に確定します。`,
    'resolution',
    null,
    [logged.citation],
  );
}

/** A model whose first turn gives two steps and no source, and whose next is an unlogged 【解決】. */
const flaggedWorkspace = () =>
  workspaceFor(async (context) => {
    await historyOf(context, 'PR-02');
    if (context.prompt.includes('油圧が上がらない')) {
      return said(
        `${SAFETY_LINE}\n\n手順1：油面計を確認してください。\n\n手順2：ストレーナを外してください。〔過去トラ T-0003〕`,
        'step',
        { number: 1, instruction: '油面計を確認してください。', citations: [] },
        [],
      );
    }
    return said('【解決】直りました。', 'resolution', null, []);
  });

/** The press diagnosis on a real run, whose logResolution call nobody has approved yet. */
const unapprovedWorkspace = () =>
  scriptedWorkspace(
    async (context) => {
      if (context.prompt.includes('油圧が上がらない')) return pressDiagnosis(context);
      await context.tool('maintenance', 'logResolution', { body: RESOLUTION });
      return said('【解決】原因: 吸込みストレーナの目詰まり／処置: 清掃。', 'resolution', null, []);
    },
    connectors(),
    builtins,
  );

/** A model that answers bare text, without the fields the backend checks. */
const bareWorkspace = () =>
  scriptedWorkspace(() => Promise.resolve(`${SAFETY_LINE}\n\n手順1：油面計を確認してください。`));

type TurnInput = Parameters<typeof inspectTurn>[0];

/** A session's first answer that skips the safety line, starts at step 3 and cites what no tool returned. */
const UNSAFE_FIRST_TURN: TurnInput = {
  answer: {
    reply: '手順3：リリーフ弁を確認してください。〔過去トラ T-0007〕',
    kind: 'step',
    step: {
      number: 3,
      instruction: 'リリーフ弁を確認してください。',
      citations: ['過去トラ T-0007'],
    },
    citations: ['過去トラ T-0007'],
  },
  toolCalls: [],
  first: true,
  previousStep: 0,
  handoff: null,
};

/** A later step turn after step 1 that carries no step, ended by `handoff` when it is not null. */
const stepless = (reply: string, handoff: string | null): TurnInput => ({
  answer: { reply, kind: 'step', step: null, citations: [] },
  toolCalls: [],
  first: false,
  previousStep: 1,
  handoff,
});

/** A model that gives step 1 on the press report, and on the next turn hands the session over. */
const handoffWorkspace = () =>
  workspaceFor(async (context) => {
    const [firstRecord] = await historyOf(context, 'PR-02');
    if (context.prompt.startsWith('プレス2号機')) {
      const source = firstRecord?.citation ?? '';
      return said(
        `${SAFETY_LINE}\n\n手順1：油面計を確認してください。${source}`,
        'step',
        { number: 1, instruction: '油面計を確認してください。', citations: [source] },
        [source],
      );
    }
    await context.handoff('既知の原因では解決しませんでした');
    return said(
      '既知の原因では解決しませんでした。熟練者に引き継ぎます。\n- 手順1 油面: 正常',
      'step',
      null,
      [],
    );
  });

/** A model that searches for `query` on every turn and keeps what the search returned in `seen`. */
const searchingWorkspace = (query: string, seen: string[]) =>
  workspaceFor(async (context) => {
    seen.push((await context.builtin('search_files', { query })).text);
    return said('【安全】停止', 'step', null, []);
  });

export {
  DATA,
  TECHNICIAN,
  OTHER_TECHNICIAN,
  EXPERT,
  type Logged,
  type Hit,
  document,
  startMaintenance,
  maintenanceGateway,
  RESOLUTION,
  project,
  store,
  system,
  assertAnswered,
  access,
  search,
  workspaceFor,
  asAtSystem,
  searchHits,
  said,
  pressDiagnosis,
  flaggedWorkspace,
  unapprovedWorkspace,
  bareWorkspace,
  UNSAFE_FIRST_TURN,
  stepless,
  handoffWorkspace,
  searchingWorkspace,
};
