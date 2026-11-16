import { canonicalCall } from '@indx-workspace/contracts/agents';
import { expect, it } from 'vitest';

import type { ScriptAnswer, ScriptContext } from '../harness/scripted-workspace.ts';
import { fileScopeFor } from './backend/review-run.ts';
import {
  CONVEYOR,
  HR_CLERK,
  STRANGER,
  SUBMITTER,
  type Decision,
  type Hit,
  access,
  asPersonAtWorkflow,
  authority,
  hook,
  reviewer,
  workflowGateway,
  workflowSystem,
} from './ringi-review.fixture.test-support.ts';

export function defineScopeCases(): void {
  it('narrows each review run to the filer’s departments by fileScope, so another department’s precedents are never found', async () => {
    expect(fileScopeFor(SUBMITTER, access)).toStrictEqual([
      'ringi/製造本部',
      'ringi/物流部',
      'ringi/営業本部',
      'ringi/技術本部',
      'ringi/情報システム部',
      'ringi/総務部',
      'rules',
    ]);
    expect(fileScopeFor(HR_CLERK, access)).toStrictEqual(['ringi/人事部', 'rules']);

    // R-2025-0184 is 人事部's. What the run saw is whatever the scope let through, and the prompt
    // that claims to be the clerk changes nothing: the run's `fileScope` decides.
    const script = async ({ builtin }: ScriptContext): Promise<ScriptAnswer> => {
      const found = await builtin('search_files', { query: '人事評価 クラウド' });
      const opened = await builtin('Read', { path: 'ringi/人事部/2025.json' });
      // The run asked for the review sheet; the answer here is only what it saw.
      return { text: JSON.stringify({ found: found.text, opened }), structured: {} };
    };
    const askAs = async (
      person: string,
    ): Promise<{ found: string; opened: { isError: boolean } }> => {
      const desk = await hook(script);
      const runId = await desk.file({ ...CONVEYOR, submittedBy: person });
      const answer = JSON.parse((await desk.aw.runs.result(runId)).text ?? '{}') as {
        found: string;
        opened: { isError: boolean };
      };
      expect(desk.subjects()).toStrictEqual([person]);
      expect(desk.fileScopes()).toStrictEqual([fileScopeFor(person, access)]);
      return answer;
    };

    const clerk = await askAs(HR_CLERK);
    expect((JSON.parse(clerk.found) as Hit[]).map((hit) => hit.path)).toStrictEqual([
      'ringi/人事部/2025.json',
    ]);
    expect(clerk.opened.isError).toBe(false);

    const filer = await askAs(SUBMITTER);
    expect(JSON.parse(filer.found)).toStrictEqual([]);
    expect(filer.found).not.toContain('人事評価');
    expect(filer.opened.isError).toBe(true);
  });

  it('refuses to start a review for a filer who may read no department, rather than an unscoped run', async () => {
    const desk = await hook(reviewer(), {
      access: { ...access, 'no-access': { departments: [] } },
    });
    await expect(desk.file({ ...CONVEYOR, submittedBy: STRANGER })).rejects.toThrow(
      `${STRANGER} may read no department`,
    );
    await expect(desk.file({ ...CONVEYOR, submittedBy: 'no-access' })).rejects.toThrow(
      'may read no department',
    );
    expect(desk.runs()).toBe(0);
  });

  it('check_authority applies the matrix at each boundary and cites the clause', async () => {
    const approver = async (category: string, amountYen: number): Promise<string> =>
      (await authority.callJson<Decision>('check_authority', { category, amountYen })).route;

    expect(await approver('設備投資', 3_000_000)).toBe('部長決裁');
    expect(await approver('設備投資', 3_000_001)).toBe('本部長決裁');
    expect(await approver('設備投資', 30_000_000)).toBe('本部長決裁');
    expect(await approver('設備投資', 30_000_001)).toBe('取締役会決裁');
    expect(await approver('業務委託', 62_000_000)).toBe('社長決裁');
    // A donation needs the president at any amount, with 総務部長 co-reviewing.
    expect(
      await authority.callJson<Decision>('check_authority', {
        category: '寄付',
        amountYen: 100_000,
      }),
    ).toMatchObject({ route: '社長決裁', coReview: '総務部長', clause: '〔職務権限規程 §3.4〕' });

    const unknown = await authority.call('check_authority', { category: '人員採用', amountYen: 1 });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('〔職務権限規程 §1.1〕');
    expect(
      (await authority.call('check_authority', { category: '設備投資', amountYen: -1 })).isError,
    ).toBe(true);
    expect(
      (await authority.call('check_authority', { category: '設備投資', amountYen: '4500万' }))
        .isError,
    ).toBe(true);
  });

  it("refuses to comment on another department's ringi by the asserted subject", async () => {
    const comment = (ringiId: string) => ({
      requestId: ringiId,
      body: { revision: 1, body: '【AI稟議レビュー】' },
    });
    // Every call is approved, so what refuses is the workflow system, by who is asking.
    const gateway = await workflowGateway(
      ['R-2026-0101', 'R-2026-0102', 'R-2026-9999'].map((ringiId) =>
        canonicalCall('mcp__workflow__postComment', comment(ringiId)),
      ),
    );
    const posted = workflowSystem.comments.length;
    const hr = await asPersonAtWorkflow(HR_CLERK);
    const filer = await asPersonAtWorkflow(SUBMITTER);

    // 人事部 may not comment on 製造本部's ringi, and 製造本部's filer not on 人事部's: both are
    // answered exactly like a ringi that does not exist.
    const refusedToHr = await gateway.call('postComment', comment('R-2026-0101'), hr);
    const refusedToFiler = await gateway.call('postComment', comment('R-2026-0102'), filer);
    const missing = await gateway.call('postComment', comment('R-2026-9999'), filer);
    expect(refusedToHr.isError).toBe(true);
    expect(refusedToHr.text).toBe(missing.text.replace('R-2026-9999', 'R-2026-0101'));
    expect(refusedToFiler.text).toBe(missing.text.replace('R-2026-9999', 'R-2026-0102'));
    // No assertion at all: refused before any ringi is looked at.
    expect((await gateway.call('postComment', comment('R-2026-0101'))).isError).toBe(true);
    expect(workflowSystem.comments).toHaveLength(posted);

    // The prompt text does not matter: the filer's own ringi takes the comment.
    expect((await gateway.call('postComment', comment('R-2026-0101'), filer)).isError).toBe(false);
    expect(workflowSystem.comments).toHaveLength(posted + 1);
  });
}
