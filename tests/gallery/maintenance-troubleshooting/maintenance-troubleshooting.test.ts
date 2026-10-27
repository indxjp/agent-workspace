/**
 * Use case 9, the skill-transfer and maintenance troubleshooting agent: the definition passes the
 * contract, the built-in `search_files` finds the plant's past troubles, notes and manuals inside
 * the folders each technician may see (`runs.start({ fileScope })`), the maintenance system's
 * `logResolution` (an `openapiTool`) writes a resolved case back only for an approved call, and the
 * tablet's backend drives
 * a multi-turn diagnosis whose every turn it checks (safety first, one cited step at a time, a
 * resolution only when it was logged, escalation to the expert).
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
} from '@indx-workspace/contracts/tool-connectors';
import { createClient } from '@indx-workspace/sdk';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { fetchDouble } from '@indx-workspace/sdk/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isGrantedPath } from '../../../apps/web/server/files/search-terms.ts';
import { createFileSearch } from '../harness/file-search.ts';
import { GALLERY_WORKSPACE_ID, signedHeaders } from '../harness/identity.ts';
import { openapiGateway, operationsOf, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import { RunDidNotComplete, type AwaitingApproval } from '../shared/run-answer.ts';
import {
  createDiagnosisDesk,
  DiagnosisError,
  inspectTurn,
  type DiagnosisSession,
  type DiagnosisTurn,
  type TurnAnswer,
} from './backend/diagnose.ts';
import { submitExpertReview } from './backend/review.ts';
import { fileScopeFor, loadAccess } from './backend/scope.ts';
import { startFakeMaintenance, type FakeMaintenance } from './maintenance/fake-maintenance.mjs';
import { maintenance as maintenanceTool } from './tools/maintenance.ts';
import agentDefinition from './agents/maintenance-troubleshooting.ts';
import surfaceDefinition from './surfaces/floor.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const MAINTENANCE_ID = '9a7e0c11-0000-4000-8000-000000000093';
const MAINTENANCE_TOKEN = 'maintenance-test-token';
const MAINTENANCE_SECRET = 'gallery-maintenance-api-secret-0123456789';
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
    token: MAINTENANCE_TOKEN,
    identity: {
      key: MAINTENANCE_SECRET,
      audience: MAINTENANCE_ID,
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
    token: MAINTENANCE_TOKEN,
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
    id: MAINTENANCE_ID,
    session: maintenanceGateway(system),
    identityKey: MAINTENANCE_SECRET,
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
const asAtSystem = async (subject: string) => ({
  headers: await signedHeaders({ key: MAINTENANCE_SECRET, connectorId: MAINTENANCE_ID, subject }),
});

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

describe('maintenance troubleshooting agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    // readFiles is what offers `search_files` and `Read`; no write, command or network.
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['maintenance'],
      skills: ['one-step-diagnosis'],
      files: [
        { path: 'trouble-log', access: 'read' },
        { path: 'expert-notes', access: 'read' },
        { path: 'manuals', access: 'read' },
      ],
    });
    expect(definition?.policy).toMatchObject({
      tools: { autoApprove: ['mcp__agent-workspace__search_files'] },
    });
    expect(definition?.agent.instructions).toContain('logResolution');
    expect(definition?.agent.instructions).toContain('search_files');
    // The one-step rule is in the agent's own instructions, so it holds without the skill loaded.
    expect(definition?.agent.instructions).toContain(
      '1回の返答に書く「手順N：」の行は1つだけ。最初の返答も、【安全】の行のあとに手順1だけを書く\n' +
        '（設備の記録がないときは、手順1の代わりに上の引き継ぎの1行を書く）。',
    );
    // A "may I raise the setting?" question is answered "do not change it" before any step.
    expect(definition?.agent.instructions).toContain('「設定は変えないでください」');
    expect(definition?.agent.instructions).toContain('設定を変えない確認');
    // A machine with no file is handed over with the stated line, not guessed at.
    expect(definition?.agent.instructions).toContain('trouble-log/` に記録がなければ');
    expect(definition?.agent.instructions).toContain('熟練者に引き継ぎます');
    expect(definition?.agent.instructions).toContain('handoff_to_person');
    // No index server of our own is left to name.
    expect(definition?.agent.instructions).not.toMatch(
      /search_troubles|search_manual|read_section/u,
    );
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['one-step-diagnosis']);
    expect(agent?.body.surfaces).toMatchObject([
      {
        name: 'floor',
        layout: 'page',
        parts: { toolTrace: 'hidden', feedback: true, attachments: true },
      },
    ]);
    expect(project.project.connectors ?? {}).toStrictEqual({});
    expect(project.project.policy?.tools).toStrictEqual(['maintenance']);
    expect(definition?.policy).toMatchObject({ handoff: true });
    expect(project.project.policy?.permissions?.writeFiles).toBe(false);
    expect(project.project.policy?.permissions?.readFiles).toBe(true);
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases.some((entry) => entry.expect.contains?.includes('熟練者に引き継ぎます'))).toBe(
      true,
    );
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('search_files finds the machine own history, the experts notes and the manual, and nothing for an unrelated symptom', async () => {
    const scope = fileScopeFor(access, TECHNICIAN);
    const hitsFor = async (query: string): Promise<Hit[]> =>
      JSON.parse((await search.call({ query }, { fileScope: scope })).text) as Hit[];
    const pathsFor = async (query: string): Promise<string[]> =>
      (await hitsFor(query)).map((hit) => hit.path);

    // The machine by its number or its floor name, and the cause words of its own history.
    expect(await pathsFor('PR-02')).toStrictEqual(['trouble-log/PR/PR-02.json']);
    expect(await pathsFor('プレス2号機')).toContain('trouble-log/PR/PR-02.json');
    expect((await pathsFor('ストレーナ')).sort()).toStrictEqual([
      'expert-notes/hydraulics/yamamoto-hydraulics.md',
      'manuals/ap-200.md',
      'trouble-log/PR/PR-02.json',
    ]);
    expect(await pathsFor('安全措置')).toStrictEqual(['manuals/ap-200.md']);

    // The file the model opens carries the source it must copy, and the machine's model.
    const history = readFileSync(path.join(DATA, 'trouble-log/PR/PR-02.json'), 'utf8');
    expect(history).toContain('"model": "AP-200"');
    expect(history).toContain('"citation": "〔過去トラ T-0003〕"');
    expect(readFileSync(path.join(DATA, 'manuals/ap-200.md'), 'utf8')).toContain(
      '〔AP-200 設備マニュアル p.12 §2.1〕',
    );

    // A symptom no record has, and a machine the plant does not have, find nothing.
    expect(await hitsFor('社員食堂')).toStrictEqual([]);
    expect(await hitsFor('溶接ロボット')).toStrictEqual([]);
  });

  it('a photo of the part rides on the turn as an attachment, and a text-only turn sends none', async () => {
    const workspace = workspaceFor(() => Promise.resolve(said('【安全】停止', 'step', null, [])));
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);
    const photoId = 'a0000000-0000-4000-8000-000000000021';

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
      photo: { fileId: photoId },
    });
    await desk.reply(first.sessionId, '漏れは見当たらない');
    await desk.reply(first.sessionId, 'この継手です', { fileId: photoId });

    const starts = workspace.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { attachments?: unknown });
    expect(starts[0]?.attachments).toStrictEqual([{ fileId: photoId }]);
    expect(starts[1]).not.toHaveProperty('attachments');
    expect(starts[2]?.attachments).toStrictEqual([{ fileId: photoId }]);
  });

  it('the agent logs the fix only after the call is approved, and the system refuses a line, field or duration it should not take', async () => {
    const { api, store: own } = await startMaintenance();
    try {
      const [definition] = toolDefinitionsOf(agentDefinition);
      expect(definition).toMatchObject({
        kind: 'openapi',
        name: 'maintenance',
        allow: ['operationId:logResolution'],
      });
      // Compose adds exactly this rule to `requireApproval`: the write.
      const selected = selectAllowedOperations(maintenanceTool.allow, operationsOf(document));
      expect(selected.refusals).toStrictEqual([]);
      expect(
        toolApprovalRules(
          toolServerKey('maintenance'),
          selected.admitted.map((operation) => ({ name: operation.operationId, method: 'POST' })),
        ),
      ).toStrictEqual(['mcp__maintenance__logResolution']);
      expect(await maintenanceGateway(api).tools()).toStrictEqual(['logResolution']);

      const valid = {
        machineId: 'PR-02',
        symptom: '油圧が上がらない',
        cause: 'ストレーナ目詰まり',
        action: '清掃',
      };
      const as = await asAtSystem(TECHNICIAN);

      // Not approved, or approved for other arguments: refused, and the system is never dialled.
      expect(
        await maintenanceGateway(api).call('logResolution', { body: valid }, as),
      ).toStrictEqual({ text: 'approval_required', isError: true });
      expect(
        await maintenanceGateway(api, [valid]).call(
          'logResolution',
          { body: { ...valid, cause: '別の原因' } },
          as,
        ),
      ).toStrictEqual({ text: 'approval_required', isError: true });
      expect(api.requests).toHaveLength(0);

      // Approved but wrong: the system's own checks refuse a machine, a blank, a long text or a duration.
      for (const bad of [
        { ...valid, machineId: 'PR-99' },
        { ...valid, cause: '  ' },
        { ...valid, durationMin: 0 },
        { ...valid, action: 'あ'.repeat(301) },
      ]) {
        const refused = await maintenanceGateway(api, [bad]).call(
          'logResolution',
          { body: bad },
          as,
        );
        expect(refused.isError, JSON.stringify(bad)).toBe(true);
        expect(refused.text, JSON.stringify(bad)).not.toBe('approval_required');
      }
      const unknownMachine = { ...valid, machineId: '溶接ロボット9号機' };
      const unknown = await maintenanceGateway(api, [unknownMachine]).call(
        'logResolution',
        { body: unknownMachine },
        as,
      );
      expect(unknown.text).not.toContain('熟練者に引き継ぎます');
      await expect(readFile(own, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      // Approved: exactly one case, as the asserted technician and not yet reviewed.
      const logged = await maintenanceGateway(api, [valid]).callJson<Logged>(
        'logResolution',
        { body: valid },
        as,
      );
      expect(logged).toMatchObject({
        id: 'T-0027',
        technician: TECHNICIAN,
        reviewed: false,
        logged: true,
        citation: '〔過去トラ T-0027〕',
      });
      expect(JSON.parse(await readFile(own, 'utf8'))).toMatchObject([{ id: 'T-0027' }]);
      expect(api.requests.at(-1)).toMatchObject({
        method: 'POST',
        path: '/api/v1/resolutions',
        body: valid,
      });
    } finally {
      await api.close();
    }
  });

  it('a three-turn diagnosis reads each turn as typed output, ends resolved and the approved logResolution call writes the resolution', async () => {
    const workspace = workspaceFor(pressDiagnosis);
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない。圧力計が8MPaで止まる',
    });
    assertAnswered(first);
    expect(first.reply.startsWith('【安全】')).toBe(true);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['reply', 'kind', 'step', 'citations'],
      properties: {
        kind: { enum: ['step', 'resolution'] },
        step: { anyOf: [{ required: ['number', 'instruction', 'citations'] }, { type: 'null' }] },
      },
    });
    expect(first).toMatchObject({ kind: 'step', step: 1, ok: true, violations: [] });
    expect(first.citations.map((citation) => citation.raw)).toStrictEqual([
      'AP-200 設備マニュアル p.12 §2.1',
      '過去トラ T-0001',
    ]);
    // The run is started for this technician, and the prompt is what they typed, nothing more.
    expect(workspace.runs[0]).toMatchObject({
      subject: TECHNICIAN,
      prompt: 'プレス2号機 油圧が上がらない。圧力計が8MPaで止まる',
    });

    const second = await desk.reply(
      first.sessionId,
      '油面は上限と下限の間。ポンプからガラガラ音がする',
    );
    assertAnswered(second);
    expect(second).toMatchObject({ kind: 'step', step: 2, ok: true });
    expect(second.citations.map((citation) => citation.raw)).toStrictEqual([
      '過去トラ T-0003',
      '熟練者メモ 山本 §2',
    ]);

    // The third turn ends in the write, so it pauses; the technician approves and the continuation
    // is the resolution.
    const paused = await desk.reply(
      first.sessionId,
      'ストレーナが詰まっていた。清掃したら21MPaまで上がった',
    );
    expect(paused).toMatchObject({ status: 'awaiting_approval' });
    const third = await desk.approve(first.sessionId, { approve: true });
    assertAnswered(third);
    expect(third).toMatchObject({ kind: 'resolution', step: null, ok: true });
    expect(third.logged).toMatchObject({
      id: 'T-0027',
      machineId: 'PR-02',
      technician: TECHNICIAN,
    });

    // One session across the four runs, and the record is in the store for the expert to review.
    expect(new Set(workspace.runs.map((run) => run.sessionId)).size).toBe(1);
    expect(desk.session(first.sessionId).status).toBe('resolved');
    const written = JSON.parse(await readFile(store, 'utf8')) as Logged[];
    expect(written).toMatchObject([{ id: 'T-0027', reviewed: false, durationMin: 80 }]);
    await expect(desk.reply(first.sessionId, 'ありがとう')).rejects.toMatchObject({
      code: 'session_closed',
    });
  });

  it('the desk pauses on the logResolution call and, once the technician approves, the continuation logs the resolution for them and resolves the session', async () => {
    const workspace = workspaceFor(pressDiagnosis);
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);
    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    assertAnswered(first);

    // Nobody has approved the call, so the turn is a typed pause and nothing reaches the system.
    const before = system.requests.length;
    const paused = await desk.reply(
      first.sessionId,
      'ストレーナが詰まっていた。清掃したら21MPaまで上がった',
    );
    if (!('status' in paused)) throw new Error('the turn was answered, not paused');
    expect(paused.call).toStrictEqual({
      toolName: 'mcp__maintenance__logResolution',
      canonicalCall: canonicalCall('mcp__maintenance__logResolution', { body: RESOLUTION }),
    });
    expect(system.requests).toHaveLength(before);
    expect(desk.session(first.sessionId).status).toBe('diagnosing');

    // Approved: the continuation, in the same session and for the same technician, logs exactly it.
    const resolved = await desk.approve(first.sessionId, { approve: true });
    assertAnswered(resolved);
    expect(resolved).toMatchObject({ kind: 'resolution', ok: true, message: 'approved' });
    expect(resolved.logged).toMatchObject({ machineId: 'PR-02', technician: TECHNICIAN });
    expect(desk.session(first.sessionId).status).toBe('resolved');
    expect(workspace.runs.at(-1)).toMatchObject({
      prompt: 'approved',
      sessionId: first.sessionId,
      subject: TECHNICIAN,
      approvedToolCalls: [{ toolName: 'mcp__maintenance__logResolution' }],
    });
    expect(system.requests.slice(before)).toMatchObject([
      { method: 'POST', path: '/api/v1/resolutions', body: RESOLUTION },
    ]);
    // The decision is spent: there is nothing left to approve.
    await expect(desk.approve(first.sessionId, { approve: true })).rejects.toMatchObject({
      code: 'nothing_to_approve',
    });
  });

  it('a rejected logResolution call logs nothing, and the continuation hands the session to the expert with the technician’s comment', async () => {
    const workspace = workspaceFor(pressDiagnosis);
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);
    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    assertAnswered(first);
    const before = system.requests.length;
    const paused = await desk.reply(
      first.sessionId,
      'ストレーナが詰まっていた。清掃したら21MPaまで上がった',
    );
    expect(paused).toMatchObject({ status: 'awaiting_approval' });

    const rejected = await desk.approve(first.sessionId, {
      approve: false,
      comment: '原因がまだ確定していない',
    });
    assertAnswered(rejected);
    expect(rejected).toMatchObject({
      kind: 'escalation',
      logged: null,
      message: 'rejected: 原因がまだ確定していない',
    });
    expect(desk.session(first.sessionId).status).toBe('escalated');
    expect(workspace.runs.at(-1)?.approvedToolCalls).toStrictEqual([]);
    expect(system.requests).toHaveLength(before);
  });

  it('a turn with two steps, an uncited step or an unlogged resolution is flagged, and an answer without the fields fails the run', async () => {
    const workspace = workspaceFor(async (context) => {
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
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    assertAnswered(first);
    expect(first.ok).toBe(false);
    expect(first.violations).toStrictEqual(['multiple-steps', 'uncited-step']);

    const second = await desk.reply(first.sessionId, '直った');
    assertAnswered(second);
    expect(second).toMatchObject({ kind: 'resolution', logged: null, ok: false });
    expect(second.violations).toStrictEqual(['resolution-not-logged']);
    // An unlogged "resolution" does not close the session.
    expect(desk.session(first.sessionId).status).toBe('diagnosing');

    // A real run's logResolution call nobody has approved yet pauses the run: the turn is a typed
    // pause with the run id, nothing reaches the maintenance system, and the session stays open.
    const before = system.requests.length;
    const unapproved = scriptedWorkspace(
      async (context) => {
        if (context.prompt.includes('油圧が上がらない')) return pressDiagnosis(context);
        await context.tool('maintenance', 'logResolution', { body: RESOLUTION });
        return said(
          '【解決】原因: 吸込みストレーナの目詰まり／処置: 清掃。',
          'resolution',
          null,
          [],
        );
      },
      connectors(),
      builtins,
    );
    const strictDesk = createDiagnosisDesk(unapproved.aw, unapproved.agentId);
    const opened = await strictDesk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    assertAnswered(opened);
    const paused = await strictDesk.reply(opened.sessionId, '直った');
    expect(paused).toMatchObject({
      status: 'awaiting_approval',
      runId: unapproved.runs[1]?.id,
      sessionId: opened.sessionId,
      call: {
        toolName: 'mcp__maintenance__logResolution',
        canonicalCall: canonicalCall('mcp__maintenance__logResolution', { body: RESOLUTION }),
      },
    });
    expect(system.requests).toHaveLength(before);
    expect(strictDesk.session(opened.sessionId)).toMatchObject({ status: 'diagnosing' });
    expect(strictDesk.session(opened.sessionId).turns).toHaveLength(1);

    // The rest of the rules, on the pure check.
    const noSafety = inspectTurn({
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
    });
    expect(noSafety.violations).toStrictEqual([
      'missing-safety',
      'step-out-of-order',
      'unverified-citation',
    ]);
    expect(
      inspectTurn({
        answer: { reply: '圧力計を見てください。', kind: 'step', step: null, citations: [] },
        toolCalls: [],
        first: false,
        previousStep: 1,
        handoff: null,
      }).violations,
    ).toStrictEqual(['no-step']);
    // The run's handoff frame, not the agent's own label, makes a turn an escalation.
    expect(
      inspectTurn({
        answer: { reply: '熟練者に引き継ぎます。', kind: 'step', step: null, citations: [] },
        toolCalls: [],
        first: false,
        previousStep: 1,
        handoff: '既知の原因では解決しませんでした',
      }),
    ).toMatchObject({ kind: 'escalation', violations: [] });
    await expect(desk.start({ technician: ' ', message: 'x' })).rejects.toBeInstanceOf(
      DiagnosisError,
    );

    // A bare text answer has no kind and no step for the backend to check: the platform fails the
    // run, and the desk surfaces that instead of guessing from the text.
    const bare = scriptedWorkspace(() =>
      Promise.resolve(`${SAFETY_LINE}\n\n手順1：油面計を確認してください。`),
    );
    await expect(
      createDiagnosisDesk(bare.aw, bare.agentId).start({
        technician: TECHNICIAN,
        message: 'プレス2号機 油圧が上がらない',
      }),
    ).rejects.toBeInstanceOf(RunDidNotComplete);
  });

  it('after the known causes the agent hands the session to the expert, from the agent.handoff frame, and it takes no more steps', async () => {
    const workspace = workspaceFor(async (context) => {
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
    const notified: DiagnosisSession[] = [];
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId, {
      notifyExpert: (session) => {
        notified.push(session);
      },
    });

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    const second = await desk.reply(
      first.sessionId,
      '油面は正常。ストレーナもリリーフ弁も清掃済み',
    );
    expect(second).toMatchObject({ kind: 'escalation', ok: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.escalation?.reason).toBe('agent');
    expect(notified[0]?.escalation?.summary).toContain('手順1：油面計を確認してください。');
    expect(notified[0]?.escalation?.summary).toContain('→ 結果: 油面は正常');
    expect(notified[0]?.escalation?.summary).toContain(
      '引継ぎ理由: 既知の原因では解決しませんでした',
    );
    await expect(desk.reply(first.sessionId, 'まだ？')).rejects.toMatchObject({
      code: 'session_closed',
    });

    // The backend's own stop: a desk that allows one step escalates on the second by itself.
    const press = workspaceFor(pressDiagnosis);
    const strict = createDiagnosisDesk(press.aw, press.agentId, {
      maxSteps: 1,
      notifyExpert: (session) => {
        notified.push(session);
      },
    });
    const opened = await strict.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    const over = await strict.reply(opened.sessionId, '油面は正常。ポンプからガラガラ音がする');
    expect(over).toMatchObject({ kind: 'step', step: 2, ok: true });
    expect(strict.session(opened.sessionId).status).toBe('escalated');
    expect(notified[1]?.escalation?.reason).toBe('step-limit');
  });

  it('an expert correction is sent as run feedback that aw eval add-case turns into a case', async () => {
    const api = fetchDouble(() => new Response(null, { status: 204 }));
    const aw = createClient({
      baseUrl: 'https://workspace.example.co.jp',
      auth: { kind: 'api-key', apiKey: 'aw_test_gallery' },
      fetch: api.fetch,
    });
    const runId = '0b9f5d0a-0000-4000-8000-000000000009';
    const comment = await submitExpertReview(aw, {
      runId,
      expert: EXPERT,
      correct: false,
      correction: 'ガラガラ音なら油面の次はストレーナ。リリーフ弁を先に触らせない。',
    });
    expect(api.calls[0]?.url.pathname).toBe(`/api/runs/${runId}/feedback`);
    expect(api.calls[0]?.json).toStrictEqual({ rating: 'down', comment });
    expect(comment).toContain('熟練者訂正（山本 浩二）');
    await expect(
      submitExpertReview(aw, { runId, expert: EXPERT, correct: false }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('each technician searches only the folders access.json names for them, and one with nothing to see is refused before any run', async () => {
    // Each person asks the same question; what the search returns is decided by the run's scope.
    const seen: string[] = [];
    const workspace = workspaceFor(async (context) => {
      const result = await context.builtin('search_files', { query: 'オイルクーラ' });
      seen.push(result.text);
      return said('【安全】停止', 'step', null, []);
    });
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);
    for (const technician of [TECHNICIAN, OTHER_TECHNICIAN]) {
      await desk.start({ technician, message: 'オイルクーラ' });
    }

    expect(workspace.runs.map((run) => run.subject)).toStrictEqual([TECHNICIAN, OTHER_TECHNICIAN]);
    expect(workspace.runs.map((run) => run.fileScope)).toStrictEqual([
      ['trouble-log/PR', 'expert-notes/hydraulics', 'manuals/ap-200.md'],
      ['trouble-log/IM', 'expert-notes/hydraulics', 'manuals/js-350.md'],
    ]);
    const [press, molding] = seen.map((text) => JSON.parse(text) as Hit[]);
    // Each finds the cooler in their own line's log and nowhere else: by path, and by the text.
    expect(press?.map((hit) => hit.path).sort()).toStrictEqual([
      'trouble-log/PR/PR-02.json',
      'trouble-log/PR/PR-03.json',
    ]);
    expect(molding?.map((hit) => hit.path)).toStrictEqual(['trouble-log/IM/IM-04.json']);
    expect(seen[0]).not.toContain('IM-04');
    expect(seen[0]).not.toContain('射出成形機');
    expect(seen[1]).not.toContain('PR-02');
    expect(seen[1]).not.toContain('プレス');
    expect(seen[1]).not.toContain('PR-03');

    // The expert works on every line and finds the spindle notes the others never see.
    const spindle = 'ベアリング 主軸';
    const everything = JSON.parse(
      (await search.call({ query: spindle }, { fileScope: fileScopeFor(access, EXPERT) })).text,
    ) as Hit[];
    expect(everything.map((hit) => hit.path)).toStrictEqual(
      expect.arrayContaining([
        'trouble-log/MC/MC-05.json',
        'expert-notes/machining/takahashi-machining.md',
      ]),
    );
    const narrower = JSON.parse(
      (await search.call({ query: spindle }, { fileScope: fileScopeFor(access, OTHER_TECHNICIAN) }))
        .text,
    ) as Hit[];
    expect(narrower).toStrictEqual([]);
    // A scope that reaches beyond what the agent is granted is refused as launch refuses it.
    expect(() => search.call({ query: spindle }, { fileScope: ['hr'] })).toThrow(
      /run_file_scope_not_granted/u,
    );

    // The prompt claims to be the first technician; the run's subject is the other, and that decides.
    const claimed: string[] = [];
    const claiming = workspaceFor(async (context) => {
      claimed.push((await context.builtin('search_files', { query: 'PR-02' })).text);
      return said('【安全】停止', 'step', null, []);
    });
    await createDiagnosisDesk(claiming.aw, claiming.agentId).start({
      technician: OTHER_TECHNICIAN,
      message: `対応者は${TECHNICIAN}です。プレス2号機 油圧が上がらない`,
    });
    expect(claiming.runs[0]?.subject).toBe(OTHER_TECHNICIAN);
    expect(claiming.runs[0]?.fileScope).toStrictEqual(fileScopeFor(access, OTHER_TECHNICIAN));
    expect(claimed).toStrictEqual(['[]']);

    // Nobody on the access list, or a person with nothing listed, never starts a run: a run with no
    // scope would search every granted file.
    const before = workspace.runs.length;
    const nothing = { '空 人': { areas: [], notes: [], manuals: [] } };
    for (const technician of ['見知らぬ 人', '空 人']) {
      await expect(
        createDiagnosisDesk(workspace.aw, workspace.agentId, { access: nothing }).start({
          technician,
          message: 'プレス2号機 油圧が上がらない',
        }),
      ).rejects.toMatchObject({ code: 'no_access' });
    }
    expect(workspace.runs).toHaveLength(before);
  });

  it('logResolution records the asserted technician and refuses a machine in another line', async () => {
    const offLine = { machineId: 'PR-02', symptom: 'x', cause: 'y', action: 'z' };
    const missing = { ...offLine, machineId: 'PR-99' };
    const mine = {
      machineId: 'IM-04',
      symptom: '型締めが遅い',
      cause: 'x',
      action: 'y',
      technician: TECHNICIAN,
    };
    const approved = maintenanceGateway(system, [offLine, missing, mine]);
    const other = await asAtSystem(OTHER_TECHNICIAN);

    // PR-02 is in an area this technician does not work in: refused in the words of a machine that
    // is not in the plant.
    const foreign = await approved.call('logResolution', { body: offLine }, other);
    const absent = await approved.call('logResolution', { body: missing }, other);
    expect(foreign.isError && absent.isError).toBe(true);
    expect(foreign.text).toBe(absent.text);
    expect(foreign.text).not.toContain('PR-02');

    // A resolution is recorded under the asserted technician, whatever name the model passes.
    const logged = await approved.callJson<Logged>('logResolution', { body: mine }, other);
    expect(logged.technician).toBe(OTHER_TECHNICIAN);

    // No assertion, or a technician the access list does not name, writes nothing.
    expect((await approved.call('logResolution', { body: mine })).isError).toBe(true);
    const stranger = await approved.call(
      'logResolution',
      { body: mine },
      await asAtSystem('見知らぬ 人'),
    );
    expect(stranger.isError).toBe(true);
  });
});
