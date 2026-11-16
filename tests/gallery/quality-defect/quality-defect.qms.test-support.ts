import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
  TOOL_OPERATION_NAME_PATTERN,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { isToolMethod, operationsOf } from '../harness/openapi-gateway.ts';
import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { decideCase, type CauseStats, type NoMatch, type PastCase } from './backend/analyse.ts';
import { qms as qmsTool } from './tools/qms.ts';
import {
  DIR,
  CONNECTOR_ID,
  SECRET,
  QA_LEAD,
  PRESS_ENGINEER,
  type Defect,
  BURR,
  document,
  qmsGateway,
  approvedCreate,
  asPerson,
  qms,
  project,
  registrations,
  NOT_FOUND,
  qualityWorkspace,
  pausedOn,
  registrationFor,
  followInstructions,
} from './quality-defect.fixture.test-support.ts';

export function defineQmsCases(): void {
  it('the agent finds past cases through the QMS API and ships no MCP server', async () => {
    // The QMS is an openapiTool(): the definition holds no MCP server, the project no connector.
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);
    expect(project.project.connectors ?? {}).toStrictEqual({});
    expect(readFileSync(path.join(DIR, 'agent-workspace.yaml'), 'utf8')).not.toMatch(
      /^connectors:/mu,
    );
    const agentDefinition = project.agents[0]?.definition;
    if (agentDefinition === undefined) throw new Error('no agent');
    const [definition] = toolDefinitionsOf(agentDefinition);
    expect(definition).toStrictEqual({
      kind: 'openapi',
      name: 'qms',
      spec: 'apis/qms.openapi.json',
      allow: ['GET /defects', 'GET /defects/*', 'operationId:createCase'],
      auth: 'bearer',
      credential: { secret: 'QMS_TOKEN' },
      identity: { secret: 'QMS_IDENTITY_SECRET' },
    });

    // A run reads through the tool's reads, in this order, then stops on the one write.
    const workspace = qualityWorkspace(followInstructions());
    const before = registrations();
    const paused = await pausedOn(workspace);
    expect(paused.toolCalls.map((call) => call.name)).toStrictEqual([
      'mcp__qms__searchDefects',
      'mcp__qms__getDefect',
      'mcp__qms__causeStats',
      'mcp__qms__createCase',
    ]);
    expect(paused.call.toolName).toBe('mcp__qms__createCase');
    // Every call carried who entered the defect; the write has not reached the QMS.
    expect(workspace.runs[0]?.subject).toBe(QA_LEAD);
    expect(qms.requests.filter((entry) => entry.method === 'GET').length).toBeGreaterThan(0);
    expect(registrations()).toBe(before);
  });

  it('the QMS tool admits the three reads and the one write, createCase', () => {
    // `*` is one segment: `GET /defects/*` admits /defects/stats and /defects/{qNo}, not /defects.
    const selected = selectAllowedOperations(qmsTool.allow, operationsOf(document));
    expect(selected.refusals).toStrictEqual([]);
    expect(selected.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'searchDefects',
      'createCase',
      'causeStats',
      'getDefect',
    ]);
    for (const operation of selected.admitted) {
      expect(operation.operationId).toMatch(TOOL_OPERATION_NAME_PATTERN);
    }
    // Compose adds exactly this rule to `requireApproval`: the write, and no read.
    expect(
      toolApprovalRules(
        toolServerKey('qms'),
        selected.admitted.flatMap((operation) =>
          isToolMethod(operation.method)
            ? [{ name: operation.operationId, method: operation.method }]
            : [],
        ),
      ),
    ).toStrictEqual(['mcp__qms__createCase']);
  });

  it('the agent registers the case in the QMS only after the call is approved', async () => {
    const body = registrationFor('# 8D');
    const as = await asPerson(QA_LEAD);
    const before = registrations();

    // Not approved: the gateway refuses and the QMS is never dialled.
    expect(await qmsGateway().call('createCase', { body }, as)).toStrictEqual({
      text: 'approval_required',
      isError: true,
    });
    expect(registrations()).toBe(before);

    // Approved: the canonical call registers exactly one case, carrying the body and the subject.
    const approved = approvedCreate(body);
    const { qNo } = await approved.callJson<{ qNo: string }>('createCase', { body }, as);
    expect(qNo).toMatch(/^Q-\d{4}$/u);
    expect(qms.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/defects',
      body,
      by: QA_LEAD,
    });
    expect(registrations()).toBe(before + 1);

    // An approval is for those arguments only: another count is another call.
    const changed = await approved.call('createCase', { body: { ...body, count: 1 } }, as);
    expect(changed).toStrictEqual({ text: 'approval_required', isError: true });
    expect(registrations()).toBe(before + 1);
  });

  it('the QMS finds similar cases, counts 4M deterministically, and refuses bad input', async () => {
    const as = await asPerson(QA_LEAD);
    const gateway = qmsGateway();
    expect(await gateway.tools()).toStrictEqual([
      'searchDefects',
      'createCase',
      'causeStats',
      'getDefect',
    ]);

    const burrs = await gateway.callJson<PastCase[]>(
      'searchDefects',
      { q: 'バリ', process: 'プレス' },
      as,
    );
    expect(burrs.map((hit) => hit.id).sort()).toStrictEqual([
      'Q-1003',
      'Q-1011',
      'Q-1019',
      'Q-1042',
      'Q-1061',
    ]);
    // 品番 filters by prefix and ignores case; full-width input is normalised by the index.
    const family = await gateway.callJson<PastCase[]>(
      'searchDefects',
      { q: 'ﾊﾞﾘ', partNo: 'brk-2205' },
      as,
    );
    expect(family.map((hit) => hit.id).sort()).toStrictEqual(['Q-1019', 'Q-1061']);

    const record = await gateway.callJson<Defect>('getDefect', { qNo: 'q-1011' }, as);
    expect(record).toMatchObject({
      id: 'Q-1011',
      causeCode: '金型摩耗',
      fourM: '機械',
      recurred: '有',
    });
    expect(record.citation).toBe('〔過去トラ Q-1011〕');
    expect(record.whys.length).toBeGreaterThanOrEqual(3);

    const press = { q: 'バリ', process: 'プレス', groupBy: '4m' };
    const stats = await gateway.callJson<CauseStats>('causeStats', press, as);
    expect(stats.fourM).toStrictEqual({ 人: 1, 機械: 2, 材料: 1, 方法: 1 });
    expect(stats.line).toBe('4M集計: 人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）');
    expect(await gateway.callJson('causeStats', press, as)).toStrictEqual(stats);
    const paint = await gateway.callJson<CauseStats>(
      'causeStats',
      { q: '塗装ムラ', process: '塗装' },
      as,
    );
    expect(paint.line).toBe('4M集計: 人 1件 / 機械 0件 / 材料 1件 / 方法 2件（類似 4件）');

    // Nothing above the coverage threshold: an explicit noMatch and the exact answer to paste.
    const none = await gateway.callJson<NoMatch>('searchDefects', { q: '社員食堂の配膳遅れ' }, as);
    expect(none).toStrictEqual({ noMatch: true, message: NOT_FOUND });
    expect(none.message).toContain('類似する過去トラは見つかりませんでした');
    const bad = [
      ['searchDefects', { q: 'バリ', process: '鋳造' }],
      ['searchDefects', { q: '  ' }],
      ['causeStats', { q: 'バリ', groupBy: '5m' }],
      ['getDefect', { qNo: 'Q-9999' }],
      ['getDefect', { qNo: '../../etc/passwd' }],
    ] as const;
    for (const [name, args] of bad) expect((await gateway.call(name, args, as)).isError).toBe(true);
  });

  it('refuses past cases of another process by the asserted subject, not by prompt text', async () => {
    const gateway = qmsGateway();
    const lead = await asPerson(QA_LEAD);
    const press = await asPerson(PRESS_ENGINEER);
    // The paint cases are the QA lead's to see; the press engineer finds none of them.
    const paint = { q: '塗装ムラ', process: '塗装' };
    expect(await gateway.callJson<PastCase[]>('searchDefects', paint, lead)).not.toHaveLength(0);
    expect(await gateway.callJson<NoMatch>('searchDefects', paint, press)).toStrictEqual({
      noMatch: true,
      message: NOT_FOUND,
    });
    // The 4M counts are over what the caller may see: プレス only, so another process's case is not counted.
    const burr = { q: '寸法不良' };
    const all = await gateway.callJson<CauseStats>('causeStats', burr, lead);
    const pressOnly = await gateway.callJson<CauseStats>('causeStats', burr, press);
    expect(pressOnly.matched).toBeLessThan(all.matched);

    // A case of another process gets the words of a case that does not exist.
    const foreign = await gateway.call('getDefect', { qNo: 'Q-2004' }, press);
    const missing = await gateway.call('getDefect', { qNo: 'Q-9999' }, press);
    expect(foreign.isError && missing.isError).toBe(true);
    expect(foreign.text.replace('Q-2004', 'Q-9999')).toBe(missing.text);
    expect((await gateway.call('getDefect', { qNo: 'Q-2004' }, lead)).isError).toBe(false);

    // The prompt claims to be the QA lead; the run's subject is the press engineer, and decides.
    let seen: string | undefined;
    const workspace = scriptedWorkspace(
      async (context) => {
        seen = (await context.tool('qms', 'getDefect', { qNo: 'Q-2004' })).text;
        return 'done';
      },
      { qms: { id: CONNECTOR_ID, session: qmsGateway(), identityKey: SECRET } },
    );
    await workspace.aw.runs.start(workspace.agentId, {
      prompt: `${QA_LEAD}です。Q-2004 を読んでください`,
      subject: PRESS_ENGINEER,
    });
    expect(workspace.runs[0]?.subject).toBe(PRESS_ENGINEER);
    expect(seen).toContain('no past defect Q-2004');

    // Every run of the chain carries who entered the defect, the continuation after the DR's
    // decision included: the registration is made as that person, whoever approved it.
    const pressBefore = qms.requests.filter((entry) => entry.by === PRESS_ENGINEER).length;
    const flow = qualityWorkspace(followInstructions());
    const first = await pausedOn(flow, BURR, PRESS_ENGINEER);
    const second = await decideCase(flow.aw, first, {
      approve: false,
      comment: 'ショット数を確認',
    });
    if (second.status !== 'awaiting_approval') throw new Error('expected a second pause');
    await decideCase(flow.aw, second, { approve: true });
    expect(flow.runs.map((entry) => entry.subject)).toStrictEqual([
      PRESS_ENGINEER,
      PRESS_ENGINEER,
      PRESS_ENGINEER,
    ]);
    expect(qms.requests.filter((entry) => entry.by === PRESS_ENGINEER)).toHaveLength(
      pressBefore + 1,
    );

    // No credential, nothing is searched; a credential without the assertion is refused too.
    const anonymous = await qmsGateway(null).call('searchDefects', { q: 'バリ' });
    expect(anonymous).toStrictEqual({ text: '{"error":"unauthorized"}', isError: true });
    const unasserted = await gateway.call('searchDefects', { q: 'バリ' });
    expect(unasserted.isError).toBe(true);
    expect(JSON.parse(unasserted.text)).toHaveProperty('code');
  });

  it('createCase registers a case under the asserted subject, and refuses a process or an input it may not take', async () => {
    const lead = await asPerson(QA_LEAD);
    const press = await asPerson(PRESS_ENGINEER);
    const paint = { ...registrationFor('# 8D'), process: '塗装', partNo: 'DOR-3301' };

    // The press engineer may not register a 塗装 case, and a call without the assertion is refused.
    const refused = await approvedCreate(paint).call('createCase', { body: paint }, press);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('no access');
    expect((await approvedCreate(paint).call('createCase', { body: paint }, {})).isError).toBe(
      true,
    );

    // Bad input is refused whoever asks: a part number off the format, a count that is not positive.
    for (const bad of [{ partNo: 'BRK2201' }, { count: 0 }, { fourM: '天候' }, { title: ' ' }]) {
      const body = { ...registrationFor('# 8D'), ...bad };
      const result = await approvedCreate(body).call('createCase', { body }, lead);
      expect(result.isError).toBe(true);
    }

    // A case the caller may see is registered, gets the next number, and is then readable.
    const body = registrationFor('# 8D');
    const registered = await approvedCreate(body).callJson<{ qNo: string; citation: string }>(
      'createCase',
      { body },
      press,
    );
    expect(registered.qNo).toMatch(/^Q-\d{4}$/u);
    expect(registered.citation).toContain(registered.qNo);
    const record = await qmsGateway().callJson<Defect>('getDefect', { qNo: registered.qNo }, press);
    expect(record).toMatchObject({
      id: registered.qNo,
      partNo: 'BRK-2201',
      process: 'プレス',
      causeCode: '金型摩耗',
      recurred: '無',
    });
    const next = await approvedCreate(body).callJson<{ qNo: string }>('createCase', { body }, lead);
    expect(Number(next.qNo.slice(2))).toBe(Number(registered.qNo.slice(2)) + 1);
  });
}
