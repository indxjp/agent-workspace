import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  NoDrawingAccess,
  decideDraft,
  fileScopeOf,
  proposeDraft,
  type AccessList,
} from './backend/draft.ts';
import { summarise } from './skills/dxf-draft/scripts/dxf.mjs';
import {
  ACCESS,
  DESIGNER,
  DIR,
  OTHER_DESIGNER,
  REQUIREMENTS,
  type Hit,
  designer,
  desk,
  deskOf,
  drawingOf,
  pathsOf,
  project,
  proposalOutsideSeries,
  proposed,
  search,
  titleBlocksSearchedBy,
} from './cad-drafting.fixture.test-support.ts';

export function defineDefinitionCases(): void {
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
    // The skill script runs unattended; the change set's Write waits for the designer (ADR-0145).
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
      skills: ['office-reader', 'dxf-draft'],
      files: [
        { path: 'drawings', access: 'read' },
        { path: 'drafts', access: 'read-write' },
      ],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['design-desk']);
    expect(project.surfaces[0]?.layout).toBe('page');
    expect(agent?.body.surfaces).toMatchObject([{ parts: { attachments: true } }]);
    expect(definition?.agent.instructions).toContain('未検図');
    expect(definition?.agent.instructions).toContain('`search_files`');
    // The reply's bullets are the script's own `changes` and `kept` lines.
    expect(definition?.agent.instructions).toContain('`changes` を変更点の箇条書きにそのまま写し');
    expect(definition?.agent.instructions).toContain('元図と値が違う項目だけ');
    // ...and its change set is the script's `changeSet`, pasted, not composed by the model.
    expect(definition?.agent.instructions).toContain('`changeSet`');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'dxf-draft',
      'office-reader',
    ]);
    expect(
      project.skills
        .find((skill) => skill.name === 'dxf-draft')
        ?.files.map((file) => file.path)
        .sort(),
    ).toStrictEqual(['SKILL.md', 'scripts/dxf.d.mts', 'scripts/dxf.mjs']);
    expect(project.project.policy?.permissions?.unrestrictedNetwork).toBe(false);
  });

  it('the eval file pins the candidates, the 未検図 mark, the refusals and the change-set geometry', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(5);
    const geometry = cases.filter((entry) => entry.outputSchema !== undefined);
    expect(geometry).toHaveLength(1);
    expect(geometry[0]?.expect.output).toMatchObject({ width: 140, height: 90 });
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases.some((entry) => entry.expect.contains?.includes('未検図'))).toBe(true);
    expect(cases.filter((entry) => entry.expect.judge !== undefined)).toHaveLength(3);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('every past drawing is a DXF office-reader reads and the skill summarises', async () => {
    for (const drawingNo of [
      'BRK-1001',
      'BRK-1002',
      'BRK-1003',
      'BRK-1004',
      'PLT-2001',
      'CVR-3002',
    ]) {
      const summary = summarise(await drawingOf(drawingNo));
      expect(summary).toMatchObject({ version: 'AC1027', drawingNo, status: '出図' });
      expect(summary.unreadEntities).toStrictEqual([]);
    }
    expect(summarise(await drawingOf('BRK-1003'))).toMatchObject({
      partName: 'ブラケット',
      material: 'SUS304',
      thickness: 't2.0',
      origin: { x: 50, y: 50 },
      width: 140,
      height: 80,
      rectangular: true,
    });
    expect(summarise(await drawingOf('BRK-1004')).rectangular).toBe(false);
  });
}

/** The search and access cases, which ran after the skill-script cases in the original file. */
export function defineSearchCases(): void {
  it('the agent finds similar drawings with search_files and ships no index server', async () => {
    // No connector, and no hosted server of ours: the platform reads the DXF title block itself.
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);
    expect(search.searchablePaths().sort()).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
      'drawings/CVR/CVR-3002.dxf',
      'drawings/PLT/PLT-2001.dxf',
    ]);

    const hitsOf = async (query: string): Promise<string[]> => {
      const result = await search.call({ query });
      expect(result.isError).toBe(false);
      return pathsOf(result).sort();
    };
    expect(await hitsOf('ブラケット')).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
    ]);
    // Full-width input in the query still lands on the plate.
    expect(await hitsOf('取付プレート　ＳＰＣＣ')).toStrictEqual(['drawings/PLT/PLT-2001.dxf']);
    const [material] = JSON.parse(
      (await search.call({ query: 'ブラケット SUS304' })).text,
    ) as Hit[];
    expect(material?.path).toBe('drawings/BRK/BRK-1003.dxf');
    // An unrelated part name returns nothing rather than the least-bad drawing.
    expect(await hitsOf('油圧シリンダ')).toStrictEqual([]);
    expect((await search.call({ query: '？' })).isError).toBe(true);

    // The model reads what it found and writes its change set from the closest drawing.
    const workspace = desk(designer());
    const proposal = await proposed(workspace);
    const searched = proposal.toolCalls.find((call) => call.name.endsWith('__search_files'));
    expect(pathsOf({ text: searched?.output ?? '[]' }).sort()).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
    ]);
    expect(proposal.changeSet.base).toBe('BRK-1003');
  });

  it('a designer reaches only the drawing series access.json gives them, by fileScope and not by prompt text', async () => {
    const first = await titleBlocksSearchedBy(DESIGNER);
    expect(first.run).toMatchObject({
      subject: DESIGNER,
      fileScope: ['drawings/BRK', 'drawings/PLT', 'drawings/CVR'],
    });
    expect(first.paths.sort()).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
      'drawings/CVR/CVR-3002.dxf',
      'drawings/PLT/PLT-2001.dxf',
    ]);

    // The second designer may use the PLT series only: nothing else is searched, so no bracket
    // or cover drawing, nor any word of theirs, reaches the model.
    const second = await titleBlocksSearchedBy(OTHER_DESIGNER);
    expect(second.run).toMatchObject({ subject: OTHER_DESIGNER, fileScope: ['drawings/PLT'] });
    expect(second.paths).toStrictEqual(['drawings/PLT/PLT-2001.dxf']);
    expect(second.seen).toContain('PLT-2001');
    expect(second.seen).not.toMatch(/BRK-|CVR-|ブラケット/u);
    expect(
      pathsOf(await search.call({ query: 'ブラケット' }, { fileScope: ['drawings/PLT'] })),
    ).toStrictEqual([]);

    // The continuation keeps the same scope and subject (ADR-0157).
    const workspace = desk(designer());
    const outcome = await decideDraft(workspace.aw, await proposed(workspace), { approve: true });
    expect(outcome.status).toBe('ready-for-check');
    for (const entry of workspace.runs) {
      expect(entry).toMatchObject({
        subject: DESIGNER,
        fileScope: ['drawings/BRK', 'drawings/PLT', 'drawings/CVR'],
      });
    }

    // A designer with nothing accessible is refused before any run, never given an unscoped one.
    const none: AccessList = { ...ACCESS, 新人: { series: [] } };
    for (const drafter of ['新人', '見知らぬ人']) {
      const refused = desk(designer());
      await expect(
        proposeDraft(refused.aw, refused.agentId, deskOf({ ...REQUIREMENTS, drafter }, none)),
      ).rejects.toThrow(NoDrawingAccess);
      expect(refused.runs).toHaveLength(0);
    }

    // A change set that names a drawing outside the designer's series pauses nothing to approve.
    expect(await proposalOutsideSeries()).toMatchObject({
      status: 'refused',
      problems: ['中村 は BRK-1003 を使えません'],
    });
    expect(() => fileScopeOf(ACCESS, '__proto__')).toThrow(NoDrawingAccess);
  });
}
