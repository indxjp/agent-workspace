import { readXlsx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { expect, it } from 'vitest';
import {
  approvePlan,
  MONTHLY_TRIGGER,
  proposePlan,
  proposePlanFromRun,
  rejectPlan,
} from './backend/consolidate.ts';
import {
  ACCESS,
  BRANCH_FOLDERS,
  consolidate,
  explain,
  FIRST_QUERIES,
  followInstructions,
  PLAN,
  PLANNER,
  planWrite,
  REQUEST,
  SAPPORO_MANAGER,
  workspaceFor,
} from './excel-consolidation.fixture.test-support.ts';

export function describeExcelApproval(): void {
  it('the backend reads the plan from the paused Write, the report as typed output once it is approved, and accepts a grounded explanation', async () => {
    const workspace = workspaceFor(followInstructions());

    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    expect(proposal.problems).toStrictEqual([]);
    expect(proposal.found).toHaveLength(11);
    expect(proposal.plan).toStrictEqual(PLAN);
    expect(proposal.lines).toHaveLength(10);
    expect(proposal.lines[0]).toStrictEqual({
      file: '東京支店/東京_売上報告_2025年4月.xlsx',
      branch: '東京',
      sheet: '売上明細',
      headerRows: '3–4',
      columns: '日付 A / 区分 B / 金額 D',
      unit: '千円',
      dateFormat: 'wareki',
    });
    // The run is stopped at the plan's Write, with nothing consolidated yet.
    const paused = await workspace.aw.runs.get(proposal.runId);
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApproval?.toolName).toBe('Write');
    expect(workspace.runs).toHaveLength(1);

    const result = await approvePlan(workspace.aw, proposal);
    expect(result.mismatches).toStrictEqual([]);
    expect(result.ungrounded).toStrictEqual([]);
    expect(result.status).toBe('accepted');
    expect(result.explanation).toContain('合計 7,920,000円');
    expect(result.explanation).toContain('東京: 2,800,000円（前月比 +500,000円、+21.7%）');
    expect(result.explanation).toContain('大阪: 2,015,000円（前月比 △245,000円、△10.8%）');
    expect(result.report.comparison.total.diff).toBe(509_500);

    // One conversation: the approval's continuation is in the paused run's session, started for the
    // signed-in person, and the approval admitted the very Write the person saw.
    expect(result.sessionId).toBe(proposal.sessionId);
    // Both runs were started for the same folder scope: the continuation keeps the paused run's.
    expect(workspace.runs.map((entry) => entry.fileScope)).toStrictEqual([
      BRANCH_FOLDERS,
      BRANCH_FOLDERS,
    ]);
    expect(workspace.runs.map((entry) => entry.sessionId)).toStrictEqual([
      proposal.sessionId,
      proposal.sessionId,
    ]);
    expect(workspace.runs[0]?.subject).toBe(PLANNER);
    expect(workspace.runs[1]?.prompt).toBe('approved');
    expect(workspace.runs[1]?.approvedToolCalls).toMatchObject([{ toolName: 'Write' }]);

    // Both runs ask for the report: the platform keeps the shape across the approval (ADR-0143).
    for (const entry of workspace.runs) {
      expect(entry.outputSchema).toMatchObject({
        type: 'object',
        required: ['explanation', 'report'],
      });
    }
  });

  it('the backend returns the consolidated workbook the agent wrote', async () => {
    const workspace = workspaceFor(followInstructions());
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    const result = await approvePlan(workspace.aw, proposal);

    expect(result.status).toBe('accepted');
    expect(result.workbook?.name).toBe('consolidated-2025-05.xlsx');
    // The bytes are the agent's file, and read back as the report's own totals and source cells.
    const sheets = readXlsx(Buffer.from(result.workbook?.bytes ?? [])).sheets;
    expect(sheets.map((sheet) => sheet.name)).toStrictEqual(['明細', '前月比']);
    expect(sheets[1]?.rows.at(-1)).toStrictEqual(['合計', 7_410_500, 7_920_000, 509_500, 6.9]);
    expect(sheets[0]?.rows).toHaveLength(result.report.rows.length + 1);
    expect(sheets[0]?.rows[1]?.[4]).toBe(result.report.rows[0]?.['@src'].amount);
  });

  it('the backend refuses a run whose workbook is missing or does not match its report', async () => {
    const none = workspaceFor(followInstructions(undefined, null));
    const missing = await approvePlan(
      none.aw,
      await proposePlan(none.aw, none.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(missing).toMatchObject({ status: 'refused', workbook: null });
    expect(missing.mismatches).toStrictEqual(['outputs/consolidated-2025-05.xlsx がない']);

    // The agent wrote a workbook whose total is not the report's.
    const changed = workspaceFor(
      followInstructions(undefined, (report) => ({
        ...report,
        comparison: {
          ...report.comparison,
          total: { ...report.comparison.total, current: 8_000_000 },
        },
      })),
    );
    const other = await approvePlan(
      changed.aw,
      await proposePlan(changed.aw, changed.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(other.status).toBe('refused');
    expect(other.mismatches).toStrictEqual(['consolidated-2025-05.xlsx の内容が報告と違う']);

    // The agent wrote bytes that do not open as a workbook: a mismatch, not a crash.
    const script = followInstructions();
    const corrupt = workspaceFor((context) =>
      script({
        ...context,
        write: (name) => context.write(name, new TextEncoder().encode('not a zip')),
      }),
    );
    const unreadable = await approvePlan(
      corrupt.aw,
      await proposePlan(corrupt.aw, corrupt.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(unreadable.status).toBe('refused');
    expect(unreadable.mismatches).toStrictEqual(['consolidated-2025-05.xlsx の内容が報告と違う']);
  });

  it('the backend refuses a plan that leaves a workbook out or a unit unstated', async () => {
    const osaka = PLAN.layouts.find((layout) => layout.branch === '大阪');
    if (osaka === undefined) throw new Error('the plan has no 大阪 layout');
    const sloppy = {
      ...PLAN,
      layouts: PLAN.layouts
        .filter((layout) => layout.sheet !== 'R7.5')
        .map((layout) => (layout.branch === '札幌' ? { ...layout, unit: null } : layout))
        .concat([{ ...osaka, branch: '神戸', files: ['神戸支店/売上.xlsx'] }]),
    };
    const workspace = workspaceFor(async (context) => {
      for (const query of FIRST_QUERIES) await context.builtin('search_files', { query });
      await context.native('Write', planWrite(sloppy));
      throw new Error('the plan should have stopped at its Write');
    });
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    expect(proposal.plan).toBeNull();
    expect(proposal.problems).toStrictEqual([
      'layouts[4]: 単位（unit）が明示されていない',
      '福岡支店/福岡支店売上報告（令和7年5月）.xlsx が計画にも除外にもない',
      '神戸支店/売上.xlsx は search_files が返していない',
    ]);
    // Nothing the person could approve: the approval is refused before it reaches the run.
    await expect(approvePlan(workspace.aw, proposal)).rejects.toThrow(/not approvable/u);
    expect(workspace.runs).toHaveLength(1);
  });

  it('a rejected plan comes back revised with the person’s comment, and the revision pauses for approval again', async () => {
    const revisedPlan = {
      ...PLAN,
      layouts: PLAN.layouts.map((layout) =>
        layout.branch === '東京'
          ? { ...layout, skip: [...(layout.skip ?? []), '（参考）'] }
          : layout,
      ),
    };
    let revised = false;
    const workspace = workspaceFor(
      followInstructions(undefined, undefined, (prompt) => {
        if (prompt.startsWith('rejected')) revised = true;
        return revised ? revisedPlan : PLAN;
      }),
    );
    const first = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);

    const second = await rejectPlan(workspace.aw, first, '東京の「（参考）」行も除いてください');
    expect(workspace.runs[1]?.prompt).toBe('rejected: 東京の「（参考）」行も除いてください');
    // A rejected call is not admitted: the revision meets the gate again and waits.
    expect(workspace.runs[1]?.approvedToolCalls).toStrictEqual([]);
    expect(second.problems).toStrictEqual([]);
    expect(second.plan).toStrictEqual(revisedPlan);
    expect(second.runId).not.toBe(first.runId);
    expect(second.sessionId).toBe(first.sessionId);
    // The files found in the first run still account for the revised plan.
    expect(second.found).toStrictEqual(first.found);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');

    const result = await approvePlan(workspace.aw, second);
    expect(result.status).toBe('accepted');
    expect(workspace.runs[2]?.prompt).toBe('approved');
  });

  it('a decision on a run that is not waiting is refused with 409 run_not_awaiting_approval', async () => {
    const workspace = workspaceFor(followInstructions());
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    await approvePlan(workspace.aw, proposal);

    // The paused run was decided once; a second decision finds nothing to decide.
    await expect(approvePlan(workspace.aw, proposal)).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    await expect(rejectPlan(workspace.aw, proposal, 'やはり違う')).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    expect(workspace.runs).toHaveLength(2);
  });

  it('the backend refuses a run that finished without stopping at the plan’s approval', async () => {
    const workspace = workspaceFor(async () => {
      const report = await consolidate(PLAN);
      const text = explain(report);
      return { text, structured: { explanation: text, report } };
    });
    await expect(
      proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS),
    ).rejects.toThrow(/without stopping for the plan's approval/u);
  });

  it('the backend refuses an explanation that quotes a number the script did not compute', async () => {
    const inflated = workspaceFor(
      followInstructions((text, report) => [
        `${text}\n東京は前月比 +25.0% と大きく伸び、約290万円になりました。`,
        report,
      ]),
    );
    const proposal = await proposePlan(inflated.aw, inflated.agentId, REQUEST, PLANNER, ACCESS);
    const result = await approvePlan(inflated.aw, proposal);
    expect(result.status).toBe('refused');
    expect(result.ungrounded).toStrictEqual(['25.0%', '290万']);
    expect(result.mismatches).toStrictEqual([]);

    // A report whose stated total its own rows do not add up to is refused as well.
    const tampered = workspaceFor(
      followInstructions((text, report) => [
        text,
        {
          ...report,
          comparison: {
            ...report.comparison,
            total: { ...report.comparison.total, current: 8_000_000 },
          },
        },
      ]),
    );
    const second = await approvePlan(
      tampered.aw,
      await proposePlan(tampered.aw, tampered.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(second.status).toBe('refused');
    expect(second.mismatches).toStrictEqual(['合計 2025-05: 報告 8000000、再計算 7920000']);
  });

  it('the monthly schedule trigger starts the plan run when it is due, as the planner it names', async () => {
    const workspace = workspaceFor(followInstructions());
    const created = await workspace.aw.triggers.create({
      ...MONTHLY_TRIGGER,
      agentId: workspace.agentId,
    });
    // A schedule has no URL to call: the answer is the trigger and nothing else.
    expect('secret' in created).toBe(false);
    expect(created.trigger).toMatchObject({
      kind: 'schedule',
      cron: '0 9 1 * *',
      timezone: 'Asia/Tokyo',
      hasSecret: false,
    });
    expect(workspace.runs).toHaveLength(0);

    const run = await workspace.fireSchedule(created.trigger.id);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.prompt).toBe(MONTHLY_TRIGGER.prompt);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['explanation', 'report'],
    });

    // A schedule has no person behind it, so the trigger's subject is the caller (ADR-0156). A trigger
    // carries no fileScope: the run searches every granted branch folder, pauses on its plan, and the
    // backend checks the plan against the folders that planner may see.
    expect(created.trigger.subject).toBe(PLANNER);
    expect(workspace.runs[0]?.subject).toBe(PLANNER);
    expect(workspace.runs[0]?.fileScope).toBeNull();
    const proposal = await proposePlanFromRun(
      workspace.aw,
      run.id,
      MONTHLY_TRIGGER.subject,
      ACCESS,
    );
    expect(proposal.problems).toStrictEqual([]);
    expect(proposal.found).toHaveLength(11);
    expect(proposal.plan).toStrictEqual(PLAN);
    expect(proposal.subject).toBe(PLANNER);
    expect(proposal.fileScope).toStrictEqual(ACCESS[PLANNER]?.folders);

    // Named as a subject who may see less, the same run's plan is not confirmable.
    const narrower = await proposePlanFromRun(workspace.aw, run.id, SAPPORO_MANAGER, ACCESS);
    expect(narrower.plan).toBeNull();
    expect(narrower.problems.some((problem) => problem.includes('東京支店/'))).toBe(true);
  });
}
