/**
 * Use case 9, the skill-transfer and maintenance troubleshooting agent: the definition passes the
 * contract, the trouble-log server searches and writes like the plant's maintenance system should,
 * and the tablet's backend drives a multi-turn diagnosis whose every turn it checks (safety first,
 * one cited step at a time, a resolution only when it was logged, escalation to the expert).
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@indx-workspace/sdk';
import { fetchDouble } from '@indx-workspace/sdk/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import {
  createDiagnosisDesk,
  DiagnosisError,
  inspectTurn,
  type DiagnosisSession,
} from './backend/diagnose.ts';
import { submitExpertReview } from './backend/review.ts';
import agentDefinition from './agents/maintenance-troubleshooting.ts';
import surfaceDefinition from './surfaces/floor.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TROUBLE_LOG_ID = '9a7e0c11-0000-4000-8000-000000000091';
const MANUAL_ID = '9a7e0c11-0000-4000-8000-000000000092';
const TECHNICIAN = '佐藤 翔太';
const SAFETY_LINE =
  '【安全】作業前に設備を停止し、主電源を遮断してロックアウト・タグアウト（LOTO）を実施してください。';

interface Trouble {
  readonly id: string;
  readonly machineId: string;
  readonly cause: string;
  readonly match?: string;
  readonly reviewed: boolean;
  readonly citation: string;
}
interface TroubleSearch {
  readonly machine: { readonly machineId: string; readonly model: string } | null;
  readonly troubles: readonly Trouble[];
  readonly expertNotes: readonly { readonly citation: string }[];
}
interface Logged extends Trouble {
  readonly technician: string;
  readonly logged: true;
}

let troubleLog: McpSession;
let readOnlyLog: McpSession;
let manual: McpSession;
let project: GalleryProject;
let store: string;

beforeAll(async () => {
  store = path.join(await mkdtemp(path.join(tmpdir(), 'trouble-log-')), 'store.json');
  troubleLog = await startMcpServer(path.join(DIR, 'mcp', 'trouble-log.mjs'), {
    TROUBLE_LOG_STORE: store,
  });
  readOnlyLog = await startMcpServer(path.join(DIR, 'mcp', 'trouble-log.mjs'));
  // The equipment manuals are served by use case 1's index server, pointed at this folder.
  manual = await startMcpServer(path.join(DIR, '..', 'manual-search', 'mcp', 'manual-index.mjs'), {
    MANUALS_DIR: path.join(DIR, 'data', 'manuals'),
  });
  project = await loadGalleryProject(DIR, {
    'agents/maintenance-troubleshooting.ts': agentDefinition,
    'surfaces/floor.ts': surfaceDefinition,
  });
});
afterAll(() => {
  troubleLog.close();
  readOnlyLog.close();
  manual.close();
});

const connectors = () => ({
  'trouble-log': { id: TROUBLE_LOG_ID, session: troubleLog },
  'equipment-manual': { id: MANUAL_ID, session: manual },
});

/**
 * The manual index scores section text, not the document title, so 「AP-200」 in the query does not
 * rank the press manual first; like a model reading the results, pick the hit whose `source` is the
 * machine's model.
 */
async function safetyCitation(context: ScriptContext): Promise<string> {
  const hits = JSON.parse(
    (
      await context.tool('equipment-manual', 'search_manual', {
        query: 'AP-200 点検・修理前の安全措置',
      })
    ).text,
  ) as { id: string; source: string }[];
  const press = hits.find((hit) => hit.source.startsWith('AP-200'));
  const section = await context.tool('equipment-manual', 'read_section', { id: press?.id });
  return (JSON.parse(section.text) as { citation: string }).citation;
}

/**
 * What a model following the instructions and the one-step-diagnosis skill does on the press:
 * safety and the oil level first, the strainer when the pump rattles, then log the fix.
 */
async function pressDiagnosis(context: ScriptContext): Promise<string> {
  if (context.prompt.includes('油圧が上がらない')) {
    const found = JSON.parse(
      (
        await context.tool('trouble-log', 'search_troubles', {
          machineId: 'プレス2号機',
          symptom: '油圧が上がらない',
        })
      ).text,
    ) as TroubleSearch;
    const lowOil = found.troubles.find((trouble) => trouble.cause.includes('作動油不足'));
    return [
      `${SAFETY_LINE}${await safetyCitation(context)}`,
      '',
      `手順1：作動油タンクの油面計を見て、油量が下限線より上にあるか確認してください。${lowOil?.citation ?? ''}`,
      '油量は下限線より上でしたか？',
    ].join('\n');
  }
  if (context.prompt.includes('ガラガラ')) {
    const found = JSON.parse(
      (
        await context.tool('trouble-log', 'search_troubles', {
          machineId: 'PR-02',
          symptom: 'ポンプからガラガラ音がする',
        })
      ).text,
    ) as TroubleSearch;
    const strainer = found.troubles[0];
    const read = JSON.parse(
      (await context.tool('trouble-log', 'get_trouble', { id: strainer?.id })).text,
    ) as Trouble;
    return [
      `手順2：吸込みストレーナを点検口から外し、金網が目詰まりしていないか確認してください。${read.citation}${found.expertNotes[0]?.citation ?? ''}`,
      '目詰まりはありましたか？',
    ].join('\n');
  }
  const logged = JSON.parse(
    (
      await context.tool('trouble-log', 'log_resolution', {
        machineId: 'PR-02',
        symptom: '油圧が上がらない。ポンプからガラガラ音',
        cause: '吸込みストレーナの目詰まり',
        action: 'ストレーナを洗油で清掃し、21MPaまで上がることを確認',
        technician: TECHNICIAN,
        durationMin: 80,
      })
    ).text,
  ) as Logged;
  return `【解決】原因: 吸込みストレーナの目詰まり／処置: 清掃。過去トラ${logged.citation}として記録しました。熟練者のレビュー後に確定します。`;
}

describe('maintenance troubleshooting agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['trouble-log', 'equipment-manual'],
      skills: ['one-step-diagnosis'],
    });
    expect(definition?.agent.instructions).toContain('log_resolution');
    // The one-step rule is in the agent's own instructions, so it holds without the skill loaded.
    expect(definition?.agent.instructions).toContain(
      '1回の返答に書く「手順N：」の行は1つだけ。最初の返答も、【安全】の行のあとに手順1だけを書く\n' +
        '（`search_troubles` が unknown machineId を返したときは、手順1の代わりにツールの返した1行を書く）。',
    );
    // A "may I raise the setting?" question is answered "do not change it" before any step.
    expect(definition?.agent.instructions).toContain('「設定は変えないでください」');
    expect(definition?.agent.instructions).toContain('設定を変えない確認');
    // An unlisted machine is handed over with the line the tool returns, not guessed at.
    expect(definition?.agent.instructions).toContain('unknown machineId');
    expect(definition?.agent.instructions).toContain('熟練者に引き継ぎます');
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['one-step-diagnosis']);
    expect(agent?.body.surfaces).toMatchObject([
      {
        name: 'floor',
        layout: 'page',
        parts: { toolTrace: 'hidden', feedback: true },
      },
    ]);
    expect(project.project.connectors).toMatchObject({
      'trouble-log': { transport: 'http' },
      'equipment-manual': { transport: 'http' },
    });
    expect(project.project.policy?.permissions?.writeFiles).toBe(false);
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

  it('the trouble log finds the machine own history first, then the same model, and nothing for an unrelated symptom', async () => {
    expect(await troubleLog.tools()).toStrictEqual([
      'search_troubles',
      'get_trouble',
      'log_resolution',
    ]);

    const found = await troubleLog.callJson<TroubleSearch>('search_troubles', {
      machineId: 'ﾌﾟﾚｽ２号機',
      symptom: '油圧が上がらない',
      limit: 10,
    });
    expect(found.machine).toMatchObject({ machineId: 'PR-02', model: 'AP-200' });
    const matches = found.troubles.map((trouble) => trouble.match);
    expect(matches[0]).toBe('same-machine');
    expect(matches.indexOf('same-model')).toBeGreaterThan(matches.lastIndexOf('same-machine'));
    // PR-03 is the same AP-200; MC-05's clamp unit has the same words but is not evidence.
    expect(found.troubles.map((trouble) => trouble.machineId)).toContain('PR-03');
    expect(found.troubles.map((trouble) => trouble.machineId)).not.toContain('MC-05');
    expect(found.expertNotes.map((note) => note.citation)).toContain('〔熟練者メモ 山本 §1〕');

    const rattle = await troubleLog.callJson<TroubleSearch>('search_troubles', {
      machineId: 'PR-02',
      symptom: 'ポンプからガラガラ音がする',
    });
    expect(rattle.troubles[0]).toMatchObject({ id: 'T-0003', citation: '〔過去トラ T-0003〕' });
    expect(rattle.expertNotes[0]?.citation).toBe('〔熟練者メモ 山本 §2〕');

    expect(
      await troubleLog.callJson<TroubleSearch>('search_troubles', {
        machineId: 'PR-02',
        symptom: '社員食堂の営業時間',
      }),
    ).toMatchObject({ troubles: [], expertNotes: [] });
    const unknown = await troubleLog.call('search_troubles', {
      machineId: '溶接ロボット9号機',
      symptom: 'x',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain(
      'この設備の過去トラ・マニュアルは登録されていません。熟練者に引き継ぎます。',
    );
    const unlogged = await troubleLog.call('log_resolution', {
      machineId: '溶接ロボット9号機',
      symptom: 'x',
      cause: 'y',
      action: 'z',
      technician: TECHNICIAN,
    });
    expect(unlogged.isError).toBe(true);
    expect(unlogged.text).not.toContain('熟練者に引き継ぎます');
    expect((await troubleLog.call('get_trouble', { id: 'T-9999' })).isError).toBe(true);
    expect((await troubleLog.call('get_trouble', { id: '../etc' })).isError).toBe(true);
  });

  it('log_resolution validates every field and refuses to write without a store', async () => {
    const valid = {
      machineId: 'PR-02',
      symptom: '油圧が上がらない',
      cause: 'ストレーナ目詰まり',
      action: '清掃',
      technician: TECHNICIAN,
    };
    for (const bad of [
      { ...valid, machineId: 'PR-99' },
      { ...valid, cause: '  ' },
      { ...valid, technician: undefined },
      { ...valid, durationMin: 0 },
      { ...valid, action: 'あ'.repeat(301) },
    ]) {
      expect((await troubleLog.call('log_resolution', bad)).isError, JSON.stringify(bad)).toBe(
        true,
      );
    }
    const refused = await readOnlyLog.call('log_resolution', valid);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('TROUBLE_LOG_STORE');
    await expect(readFile(store, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a three-turn diagnosis ends resolved and the resolution is written to the trouble log', async () => {
    const workspace = scriptedWorkspace(pressDiagnosis, connectors());
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない。圧力計が8MPaで止まる',
    });
    expect(first.answer.startsWith('【安全】')).toBe(true);
    expect(first).toMatchObject({ kind: 'step', step: 1, ok: true, violations: [] });
    expect(first.citations.map((citation) => citation.raw)).toStrictEqual([
      'AP-200 設備マニュアル p.12 §2.1',
      '過去トラ T-0001',
    ]);
    expect(workspace.runs[0]?.prompt).toBe(
      `［対応者: ${TECHNICIAN}］プレス2号機 油圧が上がらない。圧力計が8MPaで止まる`,
    );

    const second = await desk.reply(
      first.sessionId,
      '油面は上限と下限の間。ポンプからガラガラ音がする',
    );
    expect(second).toMatchObject({ kind: 'step', step: 2, ok: true });
    expect(second.citations.map((citation) => citation.raw)).toStrictEqual([
      '過去トラ T-0003',
      '熟練者メモ 山本 §2',
    ]);

    const third = await desk.reply(
      first.sessionId,
      'ストレーナが詰まっていた。清掃したら21MPaまで上がった',
    );
    expect(third).toMatchObject({ kind: 'resolution', step: null, ok: true });
    expect(third.logged).toMatchObject({
      id: 'T-0027',
      machineId: 'PR-02',
      technician: TECHNICIAN,
    });

    // One session across the three runs, and the record is in the store for the expert to review.
    expect(new Set(workspace.runs.map((run) => run.sessionId)).size).toBe(1);
    expect(desk.session(first.sessionId).status).toBe('resolved');
    const written = JSON.parse(await readFile(store, 'utf8')) as Logged[];
    expect(written).toMatchObject([{ id: 'T-0027', reviewed: false, durationMin: 80 }]);
    // The next technician's search finds it, marked as not yet reviewed.
    const next = await troubleLog.callJson<TroubleSearch>('search_troubles', {
      machineId: 'PR-02',
      symptom: 'ストレーナの目詰まり',
    });
    expect(next.troubles.find((trouble) => trouble.id === 'T-0027')?.reviewed).toBe(false);
    await expect(desk.reply(first.sessionId, 'ありがとう')).rejects.toMatchObject({
      code: 'session_closed',
    });
  });

  it('a turn with two steps, an uncited step or an unlogged resolution is flagged', async () => {
    const workspace = scriptedWorkspace(async (context) => {
      await context.tool('trouble-log', 'search_troubles', {
        machineId: 'PR-02',
        symptom: '油圧が上がらない',
      });
      if (context.prompt.includes('油圧が上がらない')) {
        return `${SAFETY_LINE}\n\n手順1：油面計を確認してください。\n\n手順2：ストレーナを外してください。〔過去トラ T-0003〕`;
      }
      return '【解決】直りました。';
    }, connectors());
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    expect(first.ok).toBe(false);
    expect(first.violations).toStrictEqual(['multiple-steps', 'uncited-step']);

    const second = await desk.reply(first.sessionId, '直った');
    expect(second).toMatchObject({ kind: 'resolution', logged: null, ok: false });
    expect(second.violations).toStrictEqual(['resolution-not-logged']);
    // An unlogged "resolution" does not close the session.
    expect(desk.session(first.sessionId).status).toBe('diagnosing');

    // The rest of the rules, on the pure check.
    const noSafety = inspectTurn({
      answer: '手順3：リリーフ弁を確認してください。〔過去トラ T-0007〕',
      toolCalls: [],
      first: true,
      previousStep: 0,
      technician: TECHNICIAN,
    });
    expect(noSafety.violations).toStrictEqual([
      'missing-safety',
      'step-out-of-order',
      'unverified-citation',
    ]);
    expect(
      inspectTurn({
        answer: '圧力計を見てください。',
        toolCalls: [],
        first: false,
        previousStep: 1,
        technician: TECHNICIAN,
      }).violations,
    ).toStrictEqual(['no-step']);
    await expect(desk.start({ technician: ' ', message: 'x' })).rejects.toBeInstanceOf(
      DiagnosisError,
    );
  });

  it('after the known causes the session escalates to the expert and takes no more steps', async () => {
    const workspace = scriptedWorkspace(async (context) => {
      const found = JSON.parse(
        (
          await context.tool('trouble-log', 'search_troubles', {
            machineId: 'PR-02',
            symptom: '油圧が上がらない',
          })
        ).text,
      ) as TroubleSearch;
      if (context.prompt.startsWith('［対応者')) {
        return `${SAFETY_LINE}\n\n手順1：油面計を確認してください。${found.troubles[0]?.citation ?? ''}`;
      }
      return '既知の原因では解決しませんでした。熟練者に引き継ぎます。\n- 手順1 油面: 正常';
    }, connectors());
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
    await expect(desk.reply(first.sessionId, 'まだ？')).rejects.toMatchObject({
      code: 'session_closed',
    });

    // The backend's own stop: a desk that allows one step escalates on the second by itself.
    const press = scriptedWorkspace(pressDiagnosis, connectors());
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
      expert: '山本 浩二',
      correct: false,
      correction: 'ガラガラ音なら油面の次はストレーナ。リリーフ弁を先に触らせない。',
    });
    expect(api.calls[0]?.url.pathname).toBe(`/api/runs/${runId}/feedback`);
    expect(api.calls[0]?.json).toStrictEqual({ rating: 'down', comment });
    expect(comment).toContain('熟練者訂正（山本 浩二）');
    await expect(
      submitExpertReview(aw, { runId, expert: '山本 浩二', correct: false }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
