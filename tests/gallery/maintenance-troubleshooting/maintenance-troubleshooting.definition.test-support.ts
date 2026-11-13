import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { createDiagnosisDesk } from './backend/diagnose.ts';
import { fileScopeFor } from './backend/scope.ts';
import {
  DATA,
  TECHNICIAN,
  type Hit,
  project,
  access,
  workspaceFor,
  searchHits,
  said,
} from './maintenance-troubleshooting.fixture.test-support.ts';

export function defineDefinitionCases(): void {
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
    const hitsFor = (query: string): Promise<Hit[]> => searchHits(query, scope);
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
}
