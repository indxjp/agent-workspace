import { readFile } from 'node:fs/promises';

import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { operationsOf } from '../harness/openapi-gateway.ts';
import { createDiagnosisDesk } from './backend/diagnose.ts';
import { fileScopeFor } from './backend/scope.ts';
import { maintenance as maintenanceTool } from './tools/maintenance.ts';
import agentDefinition from './agents/maintenance-troubleshooting.ts';
import {
  TECHNICIAN,
  OTHER_TECHNICIAN,
  EXPERT,
  type Logged,
  type Hit,
  document,
  startMaintenance,
  maintenanceGateway,
  system,
  access,
  search,
  asAtSystem,
  searchHits,
  searchingWorkspace,
} from './maintenance-troubleshooting.fixture.test-support.ts';

/** The maintenance tool's contract and the system's own checks on a logResolution call. */
export function defineToolCases(): void {
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
      const logWith = (
        approved: readonly Record<string, unknown>[],
        body: Record<string, unknown>,
      ) => maintenanceGateway(api, approved).call('logResolution', { body }, as);

      // Not approved, or approved for other arguments: refused, and the system is never dialled.
      expect(await logWith([], valid)).toStrictEqual({ text: 'approval_required', isError: true });
      expect(await logWith([valid], { ...valid, cause: '別の原因' })).toStrictEqual({
        text: 'approval_required',
        isError: true,
      });
      expect(api.requests).toHaveLength(0);

      // Approved but wrong: the system's own checks refuse a machine, a blank, a long text or a duration.
      for (const bad of [
        { ...valid, machineId: 'PR-99' },
        { ...valid, cause: '  ' },
        { ...valid, durationMin: 0 },
        { ...valid, action: 'あ'.repeat(301) },
      ]) {
        const refused = await logWith([bad], bad);
        expect(refused.isError, JSON.stringify(bad)).toBe(true);
        expect(refused.text, JSON.stringify(bad)).not.toBe('approval_required');
      }
      const unknownMachine = { ...valid, machineId: '溶接ロボット9号機' };
      const unknown = await logWith([unknownMachine], unknownMachine);
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
}

/** What each technician may search and log: the run's scope and the asserted subject decide. */
export function defineAccessCases(): void {
  it('each technician searches only the folders access.json names for them, and one with nothing to see is refused before any run', async () => {
    // Each person asks the same question; what the search returns is decided by the run's scope.
    const seen: string[] = [];
    const workspace = searchingWorkspace('オイルクーラ', seen);
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
    const everything = await searchHits(spindle, fileScopeFor(access, EXPERT));
    expect(everything.map((hit) => hit.path)).toStrictEqual(
      expect.arrayContaining([
        'trouble-log/MC/MC-05.json',
        'expert-notes/machining/takahashi-machining.md',
      ]),
    );
    const narrower = await searchHits(spindle, fileScopeFor(access, OTHER_TECHNICIAN));
    expect(narrower).toStrictEqual([]);
    // A scope that reaches beyond what the agent is granted is refused as launch refuses it.
    expect(() => search.call({ query: spindle }, { fileScope: ['hr'] })).toThrow(
      /run_file_scope_not_granted/u,
    );

    // The prompt claims to be the first technician; the run's subject is the other, and that decides.
    const claimed: string[] = [];
    const claiming = searchingWorkspace('PR-02', claimed);
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
}
